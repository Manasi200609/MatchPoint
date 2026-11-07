import test from 'node:test';
import assert from 'node:assert/strict';
import { GroqProvider } from '../src/services/GroqProvider.js';
import { ReasoningAgents, validateReasoningOutput } from '../src/services/reasoningAgents.js';

const reply = content => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
const valid = (agent, task_id, case_id) => JSON.stringify({ agent, task_id, case_id, status: 'complete', findings: agent === 'AUDITOR' ? [{ title: 'Independent calculation', evidence: ['source-record'] }] : [], evidence: [], calculations: [], unresolved_questions: [], recommendation: 'Hold', reasoning_summary: 'Checked source data.', ...(agent === 'RESOLVER' ? { human_approval_required: true, payment_authorized: false } : {}) });

test('Groq uses configurable model, endpoint, bearer auth and timeout', async () => {
  let request;
  const provider = new GroqProvider({ apiKey: 'private', model: 'configured-model', baseUrl: 'https://groq.example/chat', timeoutMs: 500, fetchImpl: async (url, options) => { request = { url, options }; return reply('ok'); } });
  assert.equal(await provider.complete({ system: 'role', user: '{}' }), 'ok');
  assert.equal(request.url, 'https://groq.example/chat');
  assert.equal(request.options.headers.Authorization, 'Bearer private');
  assert.equal(JSON.parse(request.options.body).model, 'configured-model');
  assert.equal(request.options.signal.aborted, false);
});

test('Groq rejects missing credentials, timeouts, rate limits and malformed responses', async () => {
  await assert.rejects(new GroqProvider().complete({ system: '', user: '' }), e => e.code === 'configuration');
  const timeout = new GroqProvider({ apiKey: 'x', fetchImpl: async () => { throw Object.assign(new Error(), { name: 'TimeoutError' }); } });
  await assert.rejects(timeout.complete({ system: '', user: '' }), e => e.code === 'timeout');
  const limited = new GroqProvider({ apiKey: 'x', fetchImpl: async () => new Response('{}', { status: 429 }) });
  await assert.rejects(limited.complete({ system: '', user: '' }), e => e.code === 'rate_limit');
  const malformed = new GroqProvider({ apiKey: 'x', fetchImpl: async () => new Response('{"choices":[]}', { status: 200 }) });
  await assert.rejects(malformed.complete({ system: '', user: '' }), e => e.code === 'invalid_response');
});

test('all role outputs enforce correlation; RESOLVER enforces human approval', () => {
  for (const role of ['RECON', 'AUDITOR']) assert.equal(validateReasoningOutput(role, valid(role, 'task-1', 'CASE-001'), { taskId: 'task-1', caseId: 'CASE-001' }).agent, role);
  assert.equal(validateReasoningOutput('RESOLVER', valid('RESOLVER', 'task-1', 'CASE-001'), { taskId: 'task-1', caseId: 'CASE-001' }).payment_authorized, false);
  assert.throws(() => validateReasoningOutput('RECON', valid('RECON', 'wrong', 'CASE-001'), { taskId: 'task-1', caseId: 'CASE-001' }), /correlation/);
  assert.throws(() => validateReasoningOutput('RESOLVER', valid('RESOLVER', 'task-1', 'CASE-001').replace('"payment_authorized":false', '"payment_authorized":true'), { taskId: 'task-1', caseId: 'CASE-001' }), /human approval/);
});

test('AUDITOR regression: real response shape is rejected specifically for status reviewed', () => {
  const actualFailureShape = JSON.stringify({ agent: 'AUDITOR', task_id: 'task-1', case_id: 'CASE-001', status: 'reviewed', findings: [{ title: 'Independent check' }], evidence: [], calculations: [], unresolved_questions: [], recommendation: 'Hold', reasoning_summary: 'Recalculated from source data.' });
  assert.throws(() => validateReasoningOutput('AUDITOR', actualFailureShape, { taskId: 'task-1', caseId: 'CASE-001' }), /status must be "complete" or "needs_review"/);
});

test('AUDITOR accepts fenced JSON with harmless whitespace and case variation', () => {
  const wrapped = '\uFEFF  \n```JSON\n  ' + valid('AUDITOR', 'task-1', 'CASE-001') + '  \n```  ';
  assert.equal(validateReasoningOutput('AUDITOR', wrapped, { taskId: 'task-1', caseId: 'CASE-001' }).agent, 'AUDITOR');
});

test('AUDITOR prompt requires independent arithmetic and exact output schema', async () => {
  let request;
  const agents = new ReasoningAgents({ provider: { complete: async input => { request = input; return valid('AUDITOR', 'audit-1', 'CASE-001'); } } });
  await agents.run('AUDITOR', { taskId: 'audit-1', caseRecord: { id: 'CASE-001', invoice: { total: 100 }, purchaseOrder: { total: 90 }, goodsReceived: { total: 80 }, evidence: [] }, recon: {} });
  assert.match(request.system, /status \(exactly complete or needs_review\)/);
  assert.match(request.system, /independently calculate invoice total minus PO total/);
  assert.match(request.system, /Do not copy RECON/);
  assert.match(request.system, /at least one finding/);
});

test('AUDITOR still rejects absent required findings', () => {
  const missingFindings = JSON.stringify({ agent: 'AUDITOR', task_id: 'task-1', case_id: 'CASE-001', status: 'complete', findings: [], evidence: [], calculations: [], unresolved_questions: [], recommendation: 'Hold', reasoning_summary: 'Checked source data.' });
  assert.throws(() => validateReasoningOutput('AUDITOR', missingFindings, { taskId: 'task-1', caseId: 'CASE-001' }), /at least one finding/);
});

test('each role sends distinct instructions and original case context to Groq', async () => {
  const requests = [];
  const provider = { complete: async input => { requests.push(input); const role = /You are (RECON|AUDITOR|RESOLVER)/.exec(input.system)[1]; const context = JSON.parse(input.user); return valid(role, context.task_id, context.case_id); } };
  const agents = new ReasoningAgents({ provider });
  const caseRecord = { id: 'CASE-001', vendor: 'Apex' };
  const recon = await agents.run('RECON', { taskId: 'one', caseRecord });
  const auditor = await agents.run('AUDITOR', { taskId: 'two', caseRecord, recon });
  await agents.run('RESOLVER', { taskId: 'three', caseRecord, recon, auditor });
  assert.equal(requests.length, 3);
  assert.notEqual(requests[0].system, requests[1].system);
  assert.match(requests[1].user, /RECON/);
});
