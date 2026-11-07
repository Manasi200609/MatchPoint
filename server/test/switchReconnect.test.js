import test from 'node:test';
import assert from 'node:assert/strict';
import { shutdownHttpServer, startHttpServer } from '../src/app.js';
import { switchReconnectHandler } from '../src/routes.js';
import { SwitchCollaboration } from '../src/switch/SwitchCollaboration.js';
import { InvestigationService } from '../src/services/InvestigationService.js';

const env = { SWITCH_MODE: 'live', INVESTIGATION_ENGINE: 'switch', SWITCH_API_URL: 'https://switch.invalid', SWITCH_ROOM_ID: 'fixture-room', SWITCH_RECON_ID: 'r', SWITCH_RECON_API_KEY: 'secret-r', SWITCH_AUDITOR_ID: 'a', SWITCH_AUDITOR_API_KEY: 'secret-a', SWITCH_RESOLVER_ID: 'z', SWITCH_RESOLVER_API_KEY: 'secret-z' };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function setup(start) {
  const calls = { starts: [], stops: [], groq: 0 };
  const collab = new SwitchCollaboration({ env, reasoningAgents: { run: async () => { calls.groq++; } }, sessionFactory: options => ({ ...options, state: 'disconnected', start: async function () { calls.starts.push(options.agentName); return start(this, options); }, stop: async function () { calls.stops.push(options.agentName); this.state = 'stopped'; } }) });
  const service = new InvestigationService({}, { env, switchCollaboration: collab, reasoningAgents: { run: async () => { calls.groq++; } } });
  return { calls, collab, service };
}
async function invokeReconnect(service) {
  const result = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await switchReconnectHandler(service)({}, result);
  return result;
}

test('HTTP API listen begins before initial Switch startup settles; failed startup is captured safely', async () => {
  const gate = deferred(); let listening = false;
  const fakeServer = {};
  const app = { listen() { listening = true; return fakeServer; } };
  const service = { start: () => gate.promise };
  const started = startHttpServer(app, service, 4000, () => {});
  assert.equal(listening, true);
  gate.reject(Object.assign(new Error('private credential detail'), { code: 'unreachable', role: 'RECON' }));
  await started.initialStart;
  assert.equal(started.server, fakeServer);
});

test('failed initial session startup keeps accurate disconnected status without exposing details', async () => {
  const { calls, service, collab } = setup(async (session, options) => { session.state = 'connected'; if (options.agentName === 'AUDITOR') throw Object.assign(new Error('private detail secret-a'), { code: 'unreachable', role: 'AUDITOR' }); });
  await assert.rejects(service.start());
  const status = await service.integrationStatus();
  assert.equal(status.connected, false);
  assert.equal(status.sessions.AUDITOR.state, 'stopped');
  assert.doesNotMatch(JSON.stringify(status), /private detail|secret-a/);
  assert.equal(calls.groq, 0);
  await service.shutdown();
  assert.equal(collab.getStatus().connected, false);
});

test('POST /switch/reconnect retries all three sessions successfully without investigation work', async () => {
  let attempts = 0;
  const { calls, service } = setup(async session => { attempts++; session.state = 'connected'; });
  const response = await invokeReconnect(service);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status.connected, true);
  assert.equal(attempts, 3);
  assert.equal(calls.groq, 0);
  await service.shutdown();
});

test('failed reconnect returns safe 503 status and leaves Switch disconnected', async () => {
  const { service } = setup(async (session, options) => { session.state = 'connected'; if (options.agentName === 'RECON') throw Object.assign(new Error('secret credential detail'), { code: 'unreachable', role: 'RECON' }); });
  const response = await invokeReconnect(service);
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.status.connected, false);
  assert.doesNotMatch(JSON.stringify(response.body), /secret credential detail|secret-r/);
  await service.shutdown();
});

test('concurrent reconnect calls share one attempt', async () => {
  const gate = deferred(); let starts = 0;
  const { service } = setup(async session => { starts++; await gate.promise; session.state = 'connected'; });
  const first = service.reconnect(), second = service.reconnect();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(starts, 3);
  gate.resolve();
  const results = await Promise.all([first, second]);
  assert.equal(results[0].connected, true);
  assert.equal(results[1].connected, true);
  assert.equal(starts, 3);
  await service.shutdown();
});

test('mock mode rejects reconnect and shutdown stops every Switch session', async () => {
  const { calls, service } = setup(async session => { session.state = 'connected'; });
  service.mode = 'SIMULATED';
  const response = await invokeReconnect(service);
  assert.equal(response.statusCode, 409);
  await service.shutdown();
  assert.deepEqual(calls.stops.sort(), ['AUDITOR', 'RECON', 'RESOLVER']);
  assert.equal(service.switchCollaboration.getStatus().connected, false);
});

test('shutdown stops sessions before closing the HTTP server', async () => {
  const order = [];
  await shutdownHttpServer({ shutdown: async () => { order.push('sessions'); } }, { close: callback => { order.push('server'); callback(); } });
  assert.deepEqual(order, ['sessions', 'server']);
});
