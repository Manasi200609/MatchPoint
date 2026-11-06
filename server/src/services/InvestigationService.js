import { randomUUID } from 'node:crypto';
import { reconcileCase } from '../reconciliation.js';
import { MockSwitchAdapter } from '../switch/MockSwitchAdapter.js';
import { SwitchAgentAdapter, SwitchAdapterError } from '../switch/SwitchAgentAdapter.js';
import { auditRecon, buildAgentPrompt, buildMockWorkflow, resolveFindings, validateRoleOutput } from './agentWorkflow.js';

const roles = ['RECON', 'AUDITOR', 'RESOLVER'];
const agentCards = [
  { name: 'RECON', role: 'Investigation agent', task: 'Compare invoice, PO, receipt and supporting evidence' },
  { name: 'AUDITOR', role: 'Independent verification agent', task: 'Recalculate, challenge unsupported claims and check double counting' },
  { name: 'RESOLVER', role: 'Resolution agent', task: 'Prepare an auditable resolution package for human review' }
];
const errorForUi = error => error instanceof SwitchAdapterError ? error.message : error?.message || 'Investigation stage failed.';

export class InvestigationService {
  constructor(repository, { env = process.env, switchAdapter } = {}) {
    this.repository = repository;
    const requestedMode = String(env.SWITCH_MODE || 'mock').toLowerCase();
    if (!['mock', 'live'].includes(requestedMode)) throw new Error('SWITCH_MODE must be either mock or live.');
    this.mode = requestedMode === 'live' ? 'LIVE' : 'SIMULATED';
    this.agentTimeoutMs = Number(env.SWITCH_AGENT_TIMEOUT_MS) || 120000;
    this.mockSwitch = new MockSwitchAdapter();
    this.liveSwitch = switchAdapter || new SwitchAgentAdapter({
      apiUrl: env.SWITCH_API_URL || env.SWITCH_SERVER_URL,
      agentId: env.SWITCH_AGENT_ID,
      apiKey: env.SWITCH_AGENT_API_KEY,
      connectionId: env.SWITCH_CONNECTION_ID,
      roomId: env.SWITCH_ROOM_ID,
      agentNames: { recon: env.SWITCH_RECON_NAME || 'RECON', auditor: env.SWITCH_AUDITOR_NAME || 'AUDITOR', resolver: env.SWITCH_RESOLVER_NAME || 'RESOLVER' },
      timeoutMs: Number(env.SWITCH_REQUEST_TIMEOUT_MS) || 12000
    });
    this.activeRuns = new Map();
    this.starting = new Map();
    this.statusCache = null;
    this.statusPending = null;
  }

  get switch() { return this.mode === 'LIVE' ? this.liveSwitch : this.mockSwitch; }

  async integrationStatus() {
    if (this.mode !== 'LIVE') return { mode: 'SIMULATED', connected: true, label: 'DEMO / SIMULATED', roomId: null };
    if (this.statusCache && Date.now() - this.statusCache.at < 5000) return this.statusCache.value;
    if (this.statusPending) return this.statusPending;
    this.statusPending = this.liveSwitch.checkConnection().then(value => { this.statusCache = { at: Date.now(), value }; return value; }).finally(() => { this.statusPending = null; });
    return this.statusPending;
  }

  async listCases() {
    const db = await this.repository.getWorkspace(), cases = db.cases, integrationStatus = await this.integrationStatus();
    return { cases, agents: agentCards.map(a => ({ ...a, status: this.mode === 'LIVE' ? (integrationStatus.connected ? 'Room member' : 'Unverified') : 'SIMULATED' })), activity: db.activity, integrationStatus, updatedAt: cases.reduce((a,c)=>a>c.updatedAt?a:c.updatedAt,''), metrics: { active: cases.filter(c=>!['Resolved','Rejected'].includes(c.status)).length, review: cases.filter(c=>c.status==='Needs review').length, exposure: cases.filter(c=>!['Resolved','Rejected'].includes(c.status)).reduce((s,c)=>s+Math.max(0,c.invoice.total-c.purchaseOrder.total),0), resolved: cases.filter(c=>c.status==='Resolved').length } };
  }

  async getCase(id) {
    const c = await this.repository.get(id); if (!c) return null;
    const db = await this.repository.getWorkspace();
    const investigations = c.investigations || [];
    const latest = investigations.at(-1) || null;
    const agents = agentCards.map(a => ({ ...a, status: latest?.stages?.[a.name.toLowerCase()]?.status || 'Waiting', finding: latest?.stages?.[a.name.toLowerCase()]?.output || null, evidence: [] }));
    return { case: c, reconciliation: reconcileCase(c, c.reconciliationRuns || 1), evidence: c.evidence, activity: db.activity, timeline: db.timeline, agents, investigations, latestInvestigation: latest, integrationStatus: await this.integrationStatus(), executionMode: this.mode };
  }

  async getInvestigation(id, investigationId) {
    const c = await this.repository.get(id); if (!c) return null;
    return (c.investigations || []).find(x => x.id === investigationId) || null;
  }

  async listInvestigations(id) { const c = await this.repository.get(id); return c ? c.investigations || [] : null; }

  async startInvestigation(id) {
    if (this.activeRuns.has(id)) return this.getInvestigation(id, this.activeRuns.get(id));
    if (this.starting.has(id)) return this.starting.get(id);
    const creation = (async () => {
      const c = await this.repository.get(id); if (!c) return null;
      const now = new Date().toISOString();
      const run = { id: randomUUID(), caseId: id, mode: this.mode, roomId: this.mode === 'LIVE' ? this.liveSwitch.roomId : null, status: 'running', startedAt: now, completedAt: null, stages: Object.fromEntries(roles.map(role => [role.toLowerCase(), { role, status: 'waiting', output: null, rawOutput: null, error: null, startedAt: null, completedAt: null, eventId: null }])), events: [], error: null, recommendation: null };
      await this.repository.update(id, current => ({ ...current, investigations: [...(current.investigations || []), run], updatedAt: now }));
      this.activeRuns.set(id, run.id);
      const work = this.executeRun(id, run.id);
      work.finally(() => { if (this.activeRuns.get(id) === run.id) this.activeRuns.delete(id); });
      this.runPromises ??= new Map(); this.runPromises.set(run.id, work);
      return run;
    })();
    this.starting.set(id, creation);
    try { return await creation; } finally { this.starting.delete(id); }
  }

  async waitForRun(investigationId) { return this.runPromises?.get(investigationId); }

  async patchRun(caseId, investigationId, fn) {
    let result = null;
    await this.repository.update(caseId, current => {
      const investigations = [...(current.investigations || [])];
      const index = investigations.findIndex(x => x.id === investigationId);
      if (index < 0) return current;
      investigations[index] = fn(investigations[index]); result = investigations[index];
      return { ...current, investigations, updatedAt: new Date().toISOString() };
    });
    return result;
  }

  async event(caseId, investigationId, item) {
    const event = { id: randomUUID(), timestamp: new Date().toISOString(), mode: this.mode, ...item };
    await this.patchRun(caseId, investigationId, run => ({ ...run, events: [...run.events, event] }));
    await this.repository.addTimeline({ title: item.title || `${item.actor} update`, detail: item.summary || item.body || '', actor: item.actor || 'System', timestamp: event.timestamp, type: item.kind || (this.mode === 'LIVE' ? 'switch' : 'simulated'), simulated: this.mode !== 'LIVE' });
    await this.repository.addActivity({ actor: item.actor || 'System', summary: item.summary || item.body || '', timestamp: event.timestamp, simulated: this.mode !== 'LIVE', source: this.mode === 'LIVE' ? 'switch' : 'simulated', caseId });
    return event;
  }

  async setStage(caseId, investigationId, role, changes) {
    const key = role.toLowerCase();
    return this.patchRun(caseId, investigationId, run => ({ ...run, stages: { ...run.stages, [key]: { ...run.stages[key], ...changes } } }));
  }

  async executeRun(caseId, investigationId) {
    try {
      const caseRecord = await this.repository.get(caseId);
      if (!caseRecord) throw new Error('Case not found.');
      const calculations = reconcileCase(caseRecord);
      const live = this.mode === 'LIVE' ? this.liveSwitch : null;
      if (live) {
        const status = await live.checkConnection();
        if (!status.connected) throw new SwitchAdapterError(status.error?.includes('needs the API URL') ? 'configuration' : 'connection', status.error || 'Switch is unavailable.');
        await this.patchRun(caseId, investigationId, run => ({ ...run, roomName: status.roomName || null }));
      }

      let recon, auditor, resolver;
      for (const role of roles) {
        await this.setStage(caseId, investigationId, role, { status: 'working', startedAt: new Date().toISOString() });
        await this.event(caseId, investigationId, { actor: role, kind: 'delegation', title: `${role} task dispatched`, summary: `${role} received its assigned investigation stage.`, source: this.mode === 'LIVE' ? 'switch' : 'simulated' });
        let output, rawOutput = null, eventId = null;
        if (live) {
          const prompt = buildAgentPrompt(role, caseRecord, { calculations, recon, auditor });
          const sentAt = Date.now();
          const sent = await live.sendTask({ role, prompt, threadId: null });
          eventId = sent?.event_id || null;
          await this.event(caseId, investigationId, { actor: 'MATCHPOINT', kind: 'switch', title: `Task addressed to ${role}`, summary: `Switch accepted a targeted task for ${role}.`, body: eventId ? `Switch event ${eventId}` : null, source: 'switch' });
          const reply = await live.waitForAgentReply({ role, after: sentAt, threadId: eventId, timeoutMs: this.agentTimeoutMs });
          rawOutput = reply.body;
          output = validateRoleOutput(role, rawOutput);
          if (role === 'AUDITOR') {
            const backendCrossCheck = auditRecon(caseRecord, recon, calculations);
            const disputedFindings = [...new Set([...(output.disputedFindings || []), ...backendCrossCheck.disputedFindings])];
            output = { ...output, disputedFindings, backendCrossCheck, verificationStatus: disputedFindings.length ? 'CHALLENGED' : output.verificationStatus };
            if (disputedFindings.length && !/challenge|dispute|mismatch/i.test(output.auditConclusion)) output.auditConclusion += ` Backend cross-check identified ${backendCrossCheck.disputedFindings.length} discrepancy(s).`;
          }
          await this.event(caseId, investigationId, { actor: reply.sender || role, kind: 'switch', title: `${role} response received`, summary: `A response from the configured Switch room was received and validated.`, body: reply.body, source: 'switch', switchMessageId: reply.id });
        } else {
          // Explicitly deterministic demo behavior: values are derived from this case and the reconciliation service.
          const demo = buildMockWorkflow(caseRecord);
          output = role === 'RECON' ? demo.recon : role === 'AUDITOR' ? demo.auditor : demo.resolver;
          rawOutput = JSON.stringify(output);
          await new Promise(resolve => setTimeout(resolve, 180));
        }

        if (role === 'RECON') recon = output;
        if (role === 'AUDITOR') auditor = output;
        if (role === 'RESOLVER') resolver = output;
        const status = role === 'AUDITOR' && output.verificationStatus === 'CHALLENGED' ? 'challenged' : 'complete';
        await this.setStage(caseId, investigationId, role, { status, output, rawOutput, eventId, completedAt: new Date().toISOString() });
        const summary = role === 'RECON' ? `Invoice-to-PO variance ${calculations.invoiceToPoVariance}; PO-to-receipt shortfall ${calculations.receivedShortfall}.` : role === 'AUDITOR' ? output.auditConclusion || output.verificationStatus : output.executiveRecommendation;
        await this.event(caseId, investigationId, { actor: role, kind: live ? 'switch' : 'simulated', title: `${role} stage ${status}`, summary, body: live ? rawOutput : null, source: live ? 'switch' : 'simulated' });
      }
      if (resolver.humanApprovalRequired !== true || resolver.paymentAuthorized === true) throw new Error('RESOLVER response did not preserve the mandatory human approval gate.');
      const deterministicResolution = resolveFindings(caseRecord, recon, auditor, calculations);
      if (deterministicResolution.executiveRecommendation.startsWith('HOLD') && !/hold/i.test(resolver.executiveRecommendation)) throw new Error('RESOLVER recommendation conflicts with the deterministic hold-for-evidence requirement; run left incomplete for human review.');
      await this.patchRun(caseId, investigationId, run => ({ ...run, status: 'completed', completedAt: new Date().toISOString(), recommendation: resolver, calculations, error: null }));
      await this.event(caseId, investigationId, { actor: 'MATCHPOINT', kind: 'backend_calculation', title: 'Investigation package completed', summary: 'All three agent stages completed. Human approval is still required; no payment action was taken.' });
      return this.getInvestigation(caseId, investigationId);
    } catch (error) {
      const safe = errorForUi(error);
      await this.patchRun(caseId, investigationId, run => {
        const stages = { ...run.stages };
        const current = Object.values(stages).find(stage => stage.status === 'working');
        if (current) stages[current.role.toLowerCase()] = { ...current, status: 'failed', error: safe, completedAt: new Date().toISOString() };
        return { ...run, stages, status: 'incomplete', completedAt: new Date().toISOString(), error: safe };
      });
      await this.event(caseId, investigationId, { actor: 'MATCHPOINT', kind: 'error', title: 'Investigation incomplete', summary: safe, source: this.mode === 'LIVE' ? 'switch' : 'simulated' });
      return this.getInvestigation(caseId, investigationId);
    }
  }

  async runReconciliation(id) {
    const c = await this.repository.update(id, x => ({ ...x, reconciliationRuns: (x.reconciliationRuns || 0) + 1, updatedAt: new Date().toISOString() }));
    if (!c) return null;
    await this.repository.addTimeline({ title: 'Deterministic reconciliation rerun', detail: 'Invoice, PO and received-goods comparisons recalculated by local deterministic service.', actor: 'System', timestamp: c.updatedAt, type: 'backend_calculation', simulated: false });
    return this.getCase(id);
  }

  async getReport(id) { return this.getCase(id); }

  async decide(id, { action, reason }) {
    if (!String(reason || '').trim()) throw new Error('A reason is required for a human decision.');
    const decision = { action, reason: reason.trim(), actor: 'Morgan Patel', timestamp: new Date().toISOString() };
    const c = await this.repository.update(id, x => {
      const investigations = [...(x.investigations || [])];
      if (investigations.length) investigations[investigations.length - 1] = { ...investigations.at(-1), humanDecision: decision };
      return { ...x, investigations, decision, status: action === 'Approve recommendation' ? 'Resolved' : action === 'Reject recommendation' ? 'Needs review' : 'Investigating', updatedAt: decision.timestamp };
    });
    if (!c) return null;
    await this.repository.addTimeline({ title: 'Human decision recorded', detail: `${action}: ${reason.trim()}`, actor: decision.actor, timestamp: decision.timestamp, type: 'decision', simulated: false });
    await this.repository.addActivity({ actor: decision.actor, summary: `Recorded human decision: ${action}.`, timestamp: decision.timestamp, simulated: false });
    return c;
  }

  async createCase(data) { const db=await this.repository.getWorkspace(); const id=`CASE-${String(db.cases.length+1).padStart(3,'0')}`; const c={...data,id,synthetic:false,status:'Needs review',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),decision:null,reconciliationRuns:0,investigations:[]}; return this.repository.create(c); }
}
