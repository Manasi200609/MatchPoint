import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { SwitchRoleSession } from '../src/switch/SwitchRoleSession.js';

class FakeWebSocket extends EventEmitter {
  static instances = [];
  static CLOSING = 2;
  static CLOSED = 3;
  constructor(url, options) {
    super();
    this.url = String(url);
    this.options = options;
    this.readyState = 1;
    this.sent = [];
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.emit('open'));
  }
  send(value) { this.sent.push(JSON.parse(value)); }
  frame(event, data, id) { this.emit('message', Buffer.from(JSON.stringify({ event, data, ...(id == null ? {} : { id }) }))); }
  close(code = 1000, reason = '') {
    if (this.readyState >= FakeWebSocket.CLOSING) return;
    this.readyState = FakeWebSocket.CLOSED;
    queueMicrotask(() => this.emit('close', code, Buffer.from(reason)));
  }
}

const fixture = () => {
  FakeWebSocket.instances = [];
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/ops')) return new Response(JSON.stringify({ operations: { connect_to_room: {}, post_message: {}, send_targeted_message: {} } }));
    if (String(url).endsWith('/ops/connect_to_room')) return new Response(JSON.stringify({ result: { room_id: 'room', participants: [{ id: 'recon', name: 'RECON' }] } }));
    throw new Error('unexpected request');
  };
  const session = new SwitchRoleSession({ apiUrl: 'http://switch.example', agentId: 'role-agent', apiKey: 'secret-fixture', agentName: 'RECON', roomId: 'room', connectionId: 'independent-connection', fetchImpl, WebSocketImpl: FakeWebSocket });
  return { session, calls };
};

test('role session opens an authenticated room-scoped WebSocket and binds the same connection identity', async () => {
  const { session, calls } = fixture();
  const started = session.start();
  const socket = await new Promise(resolve => setImmediate(() => resolve(FakeWebSocket.instances[0])));
  socket.frame('connection_state', { connection_id: 'independent-connection', agent_id: 'role-agent', generation: 3, rooms: ['room'], position: { s: 0, 'r:room': 0 }, cursor: 0, protocol: 9 });
  const status = await started;
  assert.equal(status.connected, true);
  assert.equal(session.state, 'connected');
  const url = new URL(socket.url);
  assert.equal(url.pathname, '/agents/role-agent/connection/ws');
  assert.equal(url.searchParams.get('connection_id'), 'independent-connection');
  assert.equal(url.searchParams.get('scope'), 'single');
  assert.equal(url.searchParams.get('filter'), 'all');
  assert.equal(url.searchParams.get('rooms'), 'room');
  assert.equal(url.searchParams.get('protocol'), '9');
  assert.equal(url.searchParams.get('protocol_accepts'), '1');
  assert.deepEqual(socket.options.headers, { Authorization: 'Bearer secret-fixture' });
  assert.equal(session.state, 'connected');
  const roomCall = calls.find(call => call.url.endsWith('/ops/connect_to_room'));
  assert.equal(roomCall.options.headers['X-Switch-Connection-Id'], 'independent-connection');
  assert.deepEqual(JSON.parse(roomCall.options.body), { room_id: 'room' });
  socket.frame('ping', {}, 11);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(socket.sent.at(-1), { type: 'pong', cursor: 11 });
  await session.stop();
  assert.equal(session.state, 'stopped');
});

test('role session fails closed when Switch returns a connection state for another identity', async () => {
  const { session } = fixture();
  const started = session.start();
  const socket = await new Promise(resolve => setImmediate(() => resolve(FakeWebSocket.instances[0])));
  socket.frame('connection_state', { connection_id: 'wrong', agent_id: 'wrong', generation: 1, rooms: ['room'], protocol: 9 });
  await assert.rejects(started, /did not match the requested role connection/);
  await session.stop();
});

test('role session reconnects from the last delivered position after an unexpected close', async () => {
  const { session } = fixture();
  const started = session.start();
  const first = await new Promise(resolve => setImmediate(() => resolve(FakeWebSocket.instances[0])));
  first.frame('connection_state', { connection_id: 'independent-connection', agent_id: 'role-agent', generation: 4, rooms: ['room'], position: { s: 2, 'r:room': 5 }, cursor: 7, protocol: 9 });
  await started;
  first.frame('message', { position: { 'r:room': 6 }, payload: { message_id: 'message-1' } }, 8);
  await new Promise(resolve => setImmediate(resolve));
  first.close(1012, 'restart');
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(FakeWebSocket.instances.length, 2);
  const resumedAt = JSON.parse(new URL(FakeWebSocket.instances[1].url).searchParams.get('start_at'));
  assert.deepEqual(resumedAt, { s: 2, 'r:room': 6 });
  await session.stop();
});

test('concurrent start calls share one operation verification and WebSocket', async () => {
  const { session, calls } = fixture();

  const firstStart = session.start();
  const secondStart = session.start();

  const socket = await new Promise(resolve =>
    setImmediate(() => resolve(FakeWebSocket.instances[0]))
  );

  assert.equal(
    calls.filter(call => call.url.endsWith('/ops')).length,
    1
  );
  assert.equal(FakeWebSocket.instances.length, 1);

  socket.frame('connection_state', {
    connection_id: 'independent-connection',
    agent_id: 'role-agent',
    generation: 3,
    rooms: ['room'],
    position: { s: 0, 'r:room': 0 },
    cursor: 0,
    protocol: 9
  });

  const [first, second] = await Promise.all([firstStart, secondStart]);

  assert.equal(first.connected, true);
  assert.equal(second.connected, true);
  assert.equal(FakeWebSocket.instances.length, 1);

  await session.stop();
});
test('stopping during initial connection rejects readiness and cleans up', async () => {
  const { session } = fixture();

  const started = session.start();

  const socket = await new Promise(resolve =>
    setImmediate(() => resolve(FakeWebSocket.instances[0]))
  );

  assert.ok(socket);

  const stopping = session.stop();

  await assert.rejects(started, /stopped during startup/);
  await stopping;

  assert.equal(session.state, 'stopped');
  assert.equal(session.stopped, true);
  assert.equal(socket.readyState, FakeWebSocket.CLOSED);
});