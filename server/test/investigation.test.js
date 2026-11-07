import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { JsonCaseRepository, seed } from '../src/repository/JsonCaseRepository.js';
import { InvestigationService } from '../src/services/InvestigationService.js';
import { auditRecon, buildAgentPrompt, buildMockWorkflow, resolveFindings } from '../src/services/agentWorkflow.js';
import { SwitchAgentAdapter } from '../src/switch/SwitchAgentAdapter.js';

class MemoryRepository {
  constructor() { this.data = seed(); }
  async getWorkspace() { return this.data; }
  async get(id) { return this.data.cases.find(c => c.id === id) || null; }
  async update(id, fn) { const i = this.data.cases.findIndex(c => c.id === id); if (i < 0) return null; this.data.cases[i] = fn(this.data.cases[i]); return this.data.cases[i]; }
  async addTimeline(item) { this.data.timeline.push(item); }
  async addActivity(item) { this.data.activity.unshift(item); }
  async create(record) { this.data.cases.push(record); return record; }
}
const waitUntil = async (fn, attempts = 100) => { for (let i=0;i<attempts;i++) { const result=fn(); if (result) return result; await new Promise(r=>setTimeout(r,10)); } throw new Error('Timed out waiting for investigation'); };

test('mock workflow executes and records RECON, AUDITOR, RESOLVER in sequence', async () => {
  const repository = new MemoryRepository(), service = new InvestigationService(repository, { env: { SWITCH_MODE: 'mock' } });
  const run = await service.startInvestigation('CASE-001'); await service.waitForRun(run.id);
  const saved = await service.getInvestigation('CASE-001', run.id);
  assert.equal(saved.status, 'completed');
  assert.deepEqual(saved.events.filter(e=>e.kind==='delegation').map(e=>e.actor), ['RECON','AUDITOR','RESOLVER']);
  assert.equal(saved.mode, 'SIMULATED');
  assert.equal(saved.recommendation.humanApprovalRequired, true);
  assert.equal(saved.recommendation.paymentAuthorized, false);
});

test('test-case fixtures remain marked separately and their context reaches agent prompts', async () => {
  const repository = new MemoryRepository();
  const service = new InvestigationService(repository, { env: { SWITCH_MODE: 'mock' } });
  const scenarioContext = 'Verify the supplier credit memo against the partial receipt.';
  const fixture = await service.createCase({
    ...seed().cases[0],
    testCaseKey: 'test-case-3',
    investigationContext: scenarioContext
  });
  assert.equal(fixture.synthetic, true);
  assert.equal(fixture.testCaseKey, 'test-case-3');
  const prompt = buildAgentPrompt('RECON', fixture, { calculations: {}, recon: {}, auditor: {} });
  assert.match(prompt, /scenarioContext/);
  assert.match(prompt, /Verify the supplier credit memo against the partial receipt/);
  assert.ok((await service.listCases()).cases.some(item => item.id === fixture.id && item.synthetic));
});

test('opt-in Groq engine runs ordered role analyses and retains deterministic approval gates', async () => {
  const repository = new MemoryRepository(), calls = [];
  const reasoningAgents = { run: async (role, context) => {
    calls.push({ role, context });
    return { agent: role, findings: [`${role} model note`], evidence: [], calculations: [], unresolved_questions: [], recommendation: 'Hold', reasoning_summary: `${role} checked the supplied case.` };
  } };
  const service = new InvestigationService(repository, { env: { SWITCH_MODE: 'mock', INVESTIGATION_ENGINE: 'groq' }, reasoningAgents });
  const run = await service.startInvestigation('CASE-001'); await service.waitForRun(run.id);
  const saved = await service.getInvestigation('CASE-001', run.id);
  assert.equal(saved.status, 'completed', saved.error || 'Groq engine did not complete');
  assert.equal(saved.engine, 'groq');
  assert.deepEqual(calls.map(call => call.role), ['RECON', 'AUDITOR', 'RESOLVER']);
  assert.ok(calls[1].context.recon);
  assert.ok(calls[2].context.recon && calls[2].context.auditor);
  assert.equal(saved.stages.recon.output.modelFindings[0], 'RECON model note');
  assert.equal(saved.recommendation.humanApprovalRequired, true);
  assert.equal(saved.recommendation.paymentAuthorized, false);
});

test('AUDITOR challenges an incorrect RECON calculation', () => {
  const c=seed().cases[0], recon=buildMockWorkflow(c).recon; recon.invoiceToPoVariance=1;
  const audit=auditRecon(c,recon);
  assert.equal(audit.verificationStatus,'CHALLENGED');
  assert.ok(audit.disputedFindings.some(x=>x.includes('invoiceToPoVariance')));
});

test('RESOLVER carries AUDITOR disagreement into the final recommendation', () => {
  const c=seed().cases[0], workflow=buildMockWorkflow(c);
  const audit={...workflow.auditor,verificationStatus:'CHALLENGED',disputedFindings:['RECON omitted a missing amendment.']};
  const result=resolveFindings(c,workflow.recon,audit,workflow.calculations);
  assert.ok(result.unresolvedDisagreements.includes('RECON omitted a missing amendment.'));
  assert.match(result.reason,/challenge/);
  assert.equal(result.humanApprovalRequired,true);
});

test('duplicate requests during an active run return the existing investigation', async () => {
  const repository=new MemoryRepository(),service=new InvestigationService(repository,{env:{SWITCH_MODE:'mock'}});
  const [a,b]=await Promise.all([service.startInvestigation('CASE-001'),service.startInvestigation('CASE-001')]);
  assert.equal(a.id,b.id);
  await service.waitForRun(a.id);
  assert.equal((await service.listInvestigations('CASE-001')).length,1);
});

test('completed investigation outputs persist across repository instances', async () => {
  const folder=await mkdtemp(path.join(process.cwd(),'data','test-investigation-'));
  try {
    const repository=new JsonCaseRepository(path.join(folder,'matchpoint.json'));
    await repository.init();
    const service=new InvestigationService(repository,{env:{SWITCH_MODE:'mock'}});
    const run=await service.startInvestigation('CASE-001'); const completed=await service.waitForRun(run.id);
    assert.equal(completed.status,'completed',completed.error||'run did not complete');
    const refreshed=await new JsonCaseRepository(path.join(folder,'matchpoint.json')).get('CASE-001');
    assert.equal(refreshed.investigations.at(-1).id,run.id);
    assert.ok(refreshed.investigations.at(-1).stages.recon.output);
    assert.ok(refreshed.investigations.at(-1).stages.auditor.output);
    assert.ok(refreshed.investigations.at(-1).stages.resolver.output);
  } finally { await rm(folder,{recursive:true,force:true}); }
});

test('human decisions require a reason', async () => {
  const service=new InvestigationService(new MemoryRepository(),{env:{SWITCH_MODE:'mock'}});
  await assert.rejects(service.decide('CASE-001',{action:'Approve recommendation',reason:'  '}),/reason is required/i);
});

test('mock mode and its generated events are explicitly simulated', async () => {
  const service=new InvestigationService(new MemoryRepository(),{env:{SWITCH_MODE:'mock'}});
  assert.deepEqual(await service.integrationStatus(),{mode:'SIMULATED',connected:false,label:'DEMO / SIMULATED',roomId:null,sessions:{}});
  const run=await service.startInvestigation('CASE-001'); await service.waitForRun(run.id);
  assert.ok((await service.getInvestigation('CASE-001',run.id)).events.every(e=>e.mode==='SIMULATED'));
});

test('mock mode ignores switch engine selection and never starts collaboration sessions', async () => {
  let groqCalls = 0;
  const service = new InvestigationService(new MemoryRepository(), { env: { SWITCH_MODE: 'mock', INVESTIGATION_ENGINE: 'switch', SWITCH_API_URL: 'https://switch.example', SWITCH_ROOM_ID: 'room', SWITCH_RECON_ID: 'r', SWITCH_RECON_API_KEY: 'x', SWITCH_AUDITOR_ID: 'a', SWITCH_AUDITOR_API_KEY: 'x', SWITCH_RESOLVER_ID: 'z', SWITCH_RESOLVER_API_KEY: 'x' }, reasoningAgents: { run: async () => { groqCalls++; throw new Error('must not call Groq'); } } });
  assert.equal(service.mode, 'SIMULATED');
  assert.equal(service.engine, 'rules');
  assert.equal((await service.start()).mode, 'SIMULATED');
  const run = await service.startInvestigation('CASE-001'); await service.waitForRun(run.id);
  assert.equal((await service.getInvestigation('CASE-001', run.id)).status, 'completed');
  assert.equal(groqCalls, 0);
  assert.ok(Object.values(service.switchCollaboration.sessions).every(session => session.state === 'disconnected'));
  await service.shutdown();
});

test('live switch collaboration service startup and cleanup reflect actual role readiness', async () => {
  const service = new InvestigationService(new MemoryRepository(), { env: { SWITCH_MODE: 'live', INVESTIGATION_ENGINE: 'switch', SWITCH_API_URL: 'https://switch.example', SWITCH_ROOM_ID: 'room', SWITCH_RECON_ID: 'r', SWITCH_RECON_API_KEY: 'x', SWITCH_AUDITOR_ID: 'a', SWITCH_AUDITOR_API_KEY: 'x', SWITCH_RESOLVER_ID: 'z', SWITCH_RESOLVER_API_KEY: 'x' } });
  assert.equal((await service.integrationStatus()).connected, false);
  for (const session of Object.values(service.switchCollaboration.sessions)) {
    session.start = async function () { this.state = 'connected'; };
    session.stop = async function () { this.state = 'stopped'; };
  }
  assert.equal((await service.start()).connected, true);
  await service.shutdown();
  assert.equal((await service.integrationStatus()).connected, false);
});

test('live mode fails honestly and never substitutes simulated work when Switch is unavailable', async () => {
  const adapter=new SwitchAgentAdapter({apiUrl:'http://switch.invalid',agentId:'agent',apiKey:'secret',connectionId:'connection',roomId:'room',agentNames:{recon:'RECON',auditor:'AUDITOR',resolver:'RESOLVER'},fetchImpl:async()=>{throw new TypeError('network down')}});
  const status=await adapter.checkConnection();
  assert.equal(status.connected,false); assert.equal(status.mode,'LIVE');
  const service=new InvestigationService(new MemoryRepository(),{env:{SWITCH_MODE:'live'},switchAdapter:{...adapter,roomId:'room',checkConnection:async()=>status}});
  const run=await service.startInvestigation('CASE-001'); await service.waitForRun(run.id);
  const saved=await service.getInvestigation('CASE-001',run.id);
  assert.equal(saved.mode,'LIVE'); assert.equal(saved.status,'incomplete');
  assert.equal(saved.recommendation,null); assert.match(saved.error,/Could not connect/);
});

test('missing live agent reply yields an incomplete failed stage', async () => {
  const unavailable={roomId:'room',checkConnection:async()=>({connected:true,roomId:'room'}),sendTask:async()=>({event_id:'event-1'}),waitForAgentReply:async()=>{throw Object.assign(new Error('RECON did not respond'),{code:'agent_timeout'})}};
  const service=new InvestigationService(new MemoryRepository(),{env:{SWITCH_MODE:'live'},switchAdapter:unavailable});
  const run=await service.startInvestigation('CASE-001'); await service.waitForRun(run.id);
  const saved=await service.getInvestigation('CASE-001',run.id);
  assert.equal(saved.status,'incomplete'); assert.equal(saved.stages.recon.status,'failed');
  assert.equal(saved.stages.auditor.status,'waiting'); assert.equal(saved.recommendation,null);
});

test('invalid live agent response is retained as a failed stage without final completion', async () => {
  const unavailable={roomId:'room',checkConnection:async()=>({connected:true,roomId:'room'}),sendTask:async()=>({event_id:'event-1'}),waitForAgentReply:async()=>({body:'This is not the required structured response.',sender:'RECON',timestamp:new Date().toISOString()})};
  const service=new InvestigationService(new MemoryRepository(),{env:{SWITCH_MODE:'live'},switchAdapter:unavailable});
  const run=await service.startInvestigation('CASE-001'); await service.waitForRun(run.id);
  const saved=await service.getInvestigation('CASE-001',run.id);
  assert.equal(saved.status,'incomplete');assert.equal(saved.stages.recon.status,'failed');
  assert.match(saved.error,/valid JSON/);assert.equal(saved.recommendation,null);
});

test('live workflow sends targeted sequential tasks with preceding validated findings', async () => {
  const repository=new MemoryRepository(), c=repository.data.cases[0], demo=buildMockWorkflow(c), sent=[], replies=[];
  const outputs={RECON:demo.recon,AUDITOR:demo.auditor,RESOLVER:demo.resolver};
  const adapter={roomId:'room',checkConnection:async()=>({connected:true,roomId:'room'}),sendTask:async task=>{sent.push(task);return {event_id:`event-${sent.length}`,target:'agent',delivery:'live'};},waitForAgentReply:async({role,threadId,timeoutMs})=>{replies.push({role,threadId,timeoutMs});return {id:`reply-${role}`,sender:role,body:JSON.stringify(outputs[role])};}};
  const service=new InvestigationService(repository,{env:{SWITCH_MODE:'live',SWITCH_AGENT_TIMEOUT_MS:'37'},switchAdapter:adapter});
  const run=await service.startInvestigation('CASE-001');await service.waitForRun(run.id);
  const saved=await service.getInvestigation('CASE-001',run.id);
  assert.equal(saved.status,'completed',saved.error||'live run failed');
  assert.deepEqual(replies.map(x=>[x.role,x.threadId,x.timeoutMs]),[['RECON','event-1',37],['AUDITOR','event-2',37],['RESOLVER','event-3',37]]);
  assert.match(sent[0].prompt,/Case JSON:/);
  assert.match(sent[1].prompt,/RECON output:/);
  assert.match(sent[1].prompt,/'invoiceToPoVariance':?\s*3750|"invoiceToPoVariance":3750/);
  assert.match(sent[2].prompt,/AUDITOR:/);
  assert.match(sent[2].prompt,/verifiedFindings/);
  assert.deepEqual(sent.map(x=>x.role),['RECON','AUDITOR','RESOLVER']);
});
