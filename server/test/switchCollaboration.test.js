import test from 'node:test';
import assert from 'node:assert/strict';
import { seed } from '../src/repository/JsonCaseRepository.js';
import { reconcileCase } from '../src/reconciliation.js';
import { SwitchCollaboration } from '../src/switch/SwitchCollaboration.js';

const modelOutput = (role, taskId, caseId) => ({ agent: role, task_id: taskId, case_id: caseId, status: 'complete', findings: [{ title: `${role} finding` }], evidence: [], calculations: [{ field: 'test' }], unresolved_questions: [], recommendation: 'Hold', reasoning_summary: 'Checked.' });

const configuredEnv = extra => ({ SWITCH_API_URL: 'https://switch.example/api', SWITCH_ROOM_ID: 'room', SWITCH_RECON_ID: 'recon', SWITCH_RECON_API_KEY: 'fixture', SWITCH_AUDITOR_ID: 'auditor', SWITCH_AUDITOR_API_KEY: 'fixture', SWITCH_RESOLVER_ID: 'resolver', SWITCH_RESOLVER_API_KEY: 'fixture', ...extra });

test('role connection IDs are distinct, stable, and use each configured role value', () => {
  const env = configuredEnv();
  const collab = new SwitchCollaboration({ env });
  assert.equal(new Set(Object.values(collab.connectionIds)).size, 3);
  for (const role of ['RECON', 'AUDITOR', 'RESOLVER']) assert.equal(collab.sessions[role].connectionId, collab.connectionIds[role]);
  const persisted = collab.connectionIds.RECON;
  assert.equal(collab.sessions.RECON.connectionId, persisted);
  const configured = new SwitchCollaboration({ env: configuredEnv({ SWITCH_RECON_CONNECTION_ID: 'r-id', SWITCH_AUDITOR_CONNECTION_ID: 'a-id', SWITCH_RESOLVER_CONNECTION_ID: 'z-id' }) });
  assert.deepEqual(configured.connectionIds, { RECON: 'r-id', AUDITOR: 'a-id', RESOLVER: 'z-id' });
  assert.throws(() => new SwitchCollaboration({ env: configuredEnv({ SWITCH_RECON_CONNECTION_ID: 'same', SWITCH_AUDITOR_CONNECTION_ID: 'same' }) }), /must be distinct/);
});

test('live session startup waits for readiness and shutdown stops all roles', async () => {
  const calls = [];
  const collab = new SwitchCollaboration({ env: configuredEnv(), sessionFactory: options => ({ ...options, state: 'disconnected' }) });
  // Use regular methods so each fake updates its own readiness state.
  for (const role of ['RECON', 'AUDITOR', 'RESOLVER']) {
    const session = collab.sessions[role];
    session.start = async function () { calls.push(`start:${role}`); this.state = 'connected'; };
    session.stop = async function () { calls.push(`stop:${role}`); this.state = 'stopped'; };
  }
  assert.equal((await collab.startSessions()).connected, true);
  assert.equal(collab.getStatus().connected, true);
  await collab.stopSessions();
  assert.deepEqual(calls.filter(x => x.startsWith('stop:')).sort(), ['stop:AUDITOR', 'stop:RECON', 'stop:RESOLVER']);
  assert.equal(collab.getStatus().connected, false);
});

test('startup failure records disconnected status and cleans every role session', async () => {
  const collab = new SwitchCollaboration({ env: configuredEnv(), sessionFactory: options => ({ ...options, state: 'disconnected', start: async function () { if (options.agentName === 'AUDITOR') throw Object.assign(new Error('connection failed'), { code: 'unreachable' }); this.state = 'connected'; }, stop: async function () { this.state = 'stopped'; } }) });
  await assert.rejects(collab.startSessions(), /connection failed/);
  assert.equal(collab.getStatus().connected, false);
  assert.equal(collab.getStatus().sessions.AUDITOR.state, 'stopped');
  assert.match(collab.getStatus().error, /disconnected.*reconnect/i);
});

test('Switch task handler correlates an addressed task, processes it once, and hands original case plus report to the next agent', async () => {
  const caseRecord = seed().cases[0];
  const calculations = reconcileCase(caseRecord);
  const calls = [], stages = [], events = [], rolesRun = [];
  const collab = new SwitchCollaboration({
    env: { SWITCH_API_URL: 'https://switch.example/api', SWITCH_ROOM_ID: 'room', SWITCH_RECON_ID: 'recon', SWITCH_RECON_API_KEY: 'fixture', SWITCH_AUDITOR_ID: 'auditor', SWITCH_AUDITOR_API_KEY: 'fixture', SWITCH_RESOLVER_ID: 'resolver', SWITCH_RESOLVER_API_KEY: 'fixture' },
    reasoningAgents: { run: async (role, input) => { rolesRun.push({ role, input }); return modelOutput(role, input.taskId, input.caseRecord.id); } }
  });
  collab.sessions = {
    RECON: { agentId: 'recon', state: 'connected', participants: [{ id: 'resolver', name: 'RESOLVER' }], operation: async (name, args) => { calls.push({ from: 'RECON', name, args }); return { event_id: 'audit-task-event', target_statuses: { AUDITOR: 'live' } }; } },
    AUDITOR: { agentId: 'auditor', state: 'connected', participants: [], operation: async () => ({}) },
    RESOLVER: { agentId: 'resolver', state: 'connected', participants: [], operation: async () => ({}) }
  };
  collab.runs.set('run-1', {
    runId: 'run-1', caseRecord, calculations, workflow: { recon: { existing: true }, auditor: { disputedFindings: [] } },
    threadId: 'root-event', expectedRole: 'RECON', reports: {}, stageOutputs: {},
    resolveCompletion() {}, rejectCompletion() {},
    onStage: async (role, update) => stages.push({ role, update }),
    onEvent: async event => events.push(event)
  });
  const frame = { event: 'message', data: { room_id: 'room', payload: { addressed: true, message_id: 'root-event', thread_id: null, sender: 'resolver', sender_name: 'RESOLVER', body: JSON.stringify({ type: 'matchpoint.investigation.task', version: 1, task_id: 'run-1', stage_task_id: 'run-1:RECON', case_id: caseRecord.id, role: 'RECON', case: caseRecord, reports: {} }) } } };
  await collab.receive('RECON', frame);
  await collab.receive('RECON', frame);
  assert.deepEqual(rolesRun.map(x => x.role), ['RECON']);
  assert.equal(rolesRun[0].input.caseRecord.invoice.total, caseRecord.invoice.total);
  assert.equal(stages.at(-1).update.status, 'complete');
  assert.equal(events.filter(x => x.title === 'Report addressed to AUDITOR').length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'send_targeted_message');
  const handoff = JSON.parse(calls[0].args.body);
  assert.equal(handoff.task_id, 'run-1');
  assert.equal(handoff.case_id, caseRecord.id);
  assert.equal(handoff.role, 'AUDITOR');
  assert.equal(handoff.stage_task_id, 'run-1:AUDITOR');
  assert.equal(handoff.case.invoice.total, caseRecord.invoice.total);
  assert.equal(handoff.reports.recon?.agent, 'RECON', JSON.stringify(handoff));
  assert.equal(calls[0].args.thread_id, 'root-event');
});

test('Switch task handler ignores unaddressed, wrong-sender, wrong-role, and mismatched-correlation messages', async () => {
  let reasoningCalls = 0;
  const collab = new SwitchCollaboration({ reasoningAgents: { run: async () => { reasoningCalls++; return {}; } } });
  collab.sessions = { RECON: { participants: [{ id: 'expected', name: 'RESOLVER' }] }, AUDITOR: {}, RESOLVER: { agentId: 'resolver' } };
  collab.runs.set('run-1', { runId: 'run-1', caseRecord: { id: 'CASE-001' }, expectedRole: 'RECON', threadId: 'root', reports: {}, stageOutputs: {} });
  const makeFrame = ({ addressed = true, sender = 'expected', role = 'RECON', caseId = 'CASE-001', taskId = 'run-1' } = {}) => ({ event: 'message', data: { room_id: 'room', payload: { addressed, message_id: `m-${addressed}-${sender}-${role}-${caseId}-${taskId}`, sender, sender_name: 'RESOLVER', body: JSON.stringify({ type: 'matchpoint.investigation.task', version: 1, task_id: taskId, stage_task_id: `${taskId}:${role}`, case_id: caseId, role, case: { id: caseId, invoice: {}, purchaseOrder: {}, goodsReceived: {}, evidence: [] }, reports: {} }) } } });
  await collab.receive('RECON', makeFrame({ addressed: false }));
  await collab.receive('RECON', makeFrame({ sender: 'unexpected' }));
  await collab.receive('RECON', makeFrame({ role: 'AUDITOR' }));
  await collab.receive('RECON', makeFrame({ caseId: 'CASE-OTHER' }));
  assert.equal(reasoningCalls, 0);
});

test('Switch collaboration routes all three role payloads and returns the final thread report (unit transport fixture)', async () => {
  const caseRecord = seed().cases[0];
  const roleNames = { RECON: 'RECON', AUDITOR: 'AUDITOR', RESOLVER: 'RESOLVER' };
  const participants = Object.entries(roleNames).map(([role, name]) => ({ id: `id-${role}`, name }));
  const sessions = {};
  const agentInputs = [];
  let eventNumber = 0;
  const collab = new SwitchCollaboration({
    env: { SWITCH_API_URL: 'https://switch.example/api', SWITCH_ROOM_ID: 'room', SWITCH_RECON_ID: 'id-RECON', SWITCH_RECON_API_KEY: 'fixture', SWITCH_AUDITOR_ID: 'id-AUDITOR', SWITCH_AUDITOR_API_KEY: 'fixture', SWITCH_RESOLVER_ID: 'id-RESOLVER', SWITCH_RESOLVER_API_KEY: 'fixture' },
    sessionFactory: options => {
      const role = Object.keys(roleNames).find(key => options.agentId === `id-${key}`);
      const session = { ...options, role, state: 'disconnected', participants, start: async () => { session.state = 'connected'; return { connected: true }; }, stop: async () => { session.state = 'stopped'; } };
      session.operation = async (name, args) => {
        if (name === 'connect_to_room') return { room_id: 'room', participants };
        const eventId = `switch-event-${++eventNumber}`;
        if (name === 'send_targeted_message') {
          const targetRole = Object.keys(roleNames).find(key => roleNames[key] === args.target_names[0]);
          await sessions[targetRole].onEvent({ event: 'message', id: String(eventNumber), data: { room_id: 'room', payload: { addressed: true, message_id: eventId, thread_id: args.thread_id || null, sender: `id-${role}`, sender_name: roleNames[role], body: args.body } } });
          return { event_id: eventId, target_statuses: { [args.target_names[0]]: 'live' } };
        }
        if (name === 'post_message') {
          await sessions.RESOLVER.onEvent({ event: 'message', id: String(eventNumber), data: { room_id: 'room', payload: { addressed: false, message_id: eventId, thread_id: args.thread_id, sender: 'id-RESOLVER', sender_name: 'RESOLVER', body: args.body } } });
          return { event_id: eventId };
        }
        throw new Error(`unexpected operation ${name}`);
      };
      sessions[role] = session;
      return session;
    },
    reasoningAgents: { run: async (role, input) => { agentInputs.push({ role, input }); return modelOutput(role, input.taskId, input.caseRecord.id); } }
  });
  const stages = [];
  const result = await collab.execute({ runId: 'run-e2e', caseRecord, calculations: reconcileCase(caseRecord), onStage: async (role, update) => stages.push({ role, update }), onEvent: async () => {} });
  assert.deepEqual(agentInputs.map(x => x.role), ['RECON', 'AUDITOR', 'RESOLVER']);
  assert.equal(agentInputs[0].input.caseRecord.invoice.total, caseRecord.invoice.total);
  assert.equal(agentInputs[1].input.caseRecord.invoice.total, caseRecord.invoice.total);
  assert.equal(agentInputs[1].input.recon.agent, 'RECON');
  assert.equal(agentInputs[2].input.auditor.agent, 'AUDITOR');
  assert.equal(agentInputs[2].input.recon.agent, 'RECON');
  assert.equal(result.threadId, 'switch-event-1');
  assert.equal(result.resolver.modelOutput.agent, 'RESOLVER');
  assert.deepEqual(stages.filter(x => x.update.status === 'complete').map(x => x.role), ['RECON', 'AUDITOR', 'RESOLVER']);
});
