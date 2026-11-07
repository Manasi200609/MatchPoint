import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DiscordIntegration } from '../src/discord/DiscordIntegration.js';

class FakeClient extends EventEmitter {
  constructor(channel) {
    super();
    this.channel = channel;
    this.channels = { fetch: async id => { this.fetchedChannelId = id; return channel; } };
    this.user = { id: 'bot-user' };
    this.destroyed = false;
  }
  async login(token) {
    this.tokenSeen = token;
    queueMicrotask(() => this.emit('clientReady'));
    return token;
  }
  destroy() { this.destroyed = true; }
}

function fixture({ mode = 'SWITCH' } = {}) {
  const sent = [];
  const replies = [];
  const channel = {
    isTextBased: () => true,
    isDMBased: () => false,
    permissionsFor: () => ({ has: () => true }),
    send: async content => { sent.push(content); return { id: `sent-${sent.length}` }; }
  };
  let latest = {
    id: 'run-persisted', status: 'completed', error: null,
    stages: { recon: { status: 'complete' }, auditor: { status: 'complete' }, resolver: { status: 'complete' } }
  };
  let starts = 0;
  let listener;
  const service = {
    mode,
    activeRuns: new Map(),
    addInvestigationEventListener(fn) { listener = fn; return () => { listener = null; }; },
    async getCase(id) { return id === 'CASE-001' ? { case: { id }, latestInvestigation: latest } : null; },
    async startInvestigation(id) {
      starts++;
      latest = { id: `run-${starts}`, status: 'running', stages: { recon: { status: 'waiting' }, auditor: { status: 'waiting' }, resolver: { status: 'waiting' } } };
      return latest;
    }
  };
  const client = new FakeClient(channel);
  const logs = [];
  const logger = Object.fromEntries(['info', 'warn', 'error'].map(level => [level, (...args) => logs.push([level, ...args])]));
  const bot = new DiscordIntegration(service, {
    env: { DISCORD_BOT_TOKEN: 'fixture-token', DISCORD_CHANNEL_ID: 'channel-1' },
    clientFactory: options => { client.options = options; return client; },
    logger
  });
  const message = (id, content, overrides = {}) => ({
    id,
    content,
    channelId: 'channel-1',
    author: { bot: false },
    reply: async value => { replies.push(value); },
    ...overrides
  });
  return { bot, client, service, sent, replies, logs, message, setLatest: value => { latest = value; }, getStarts: () => starts, getListener: () => listener };
}

test('Discord bot connects only to the configured text channel and stops cleanly', async () => {
  const f = fixture();
  const status = await f.bot.start();
  assert.equal(status.state, 'connected');
  assert.equal(f.client.tokenSeen, 'fixture-token');
  assert.equal(f.client.fetchedChannelId, 'channel-1');
  assert.equal(f.client.options.intents.includes(1 << 15), true); // MessageContent privileged intent
  assert.equal(f.bot.getStatus().channelId, 'channel-1');
  await f.bot.stop();
  assert.equal(f.client.destroyed, true);
  assert.equal(f.getListener(), null);
});

test('Discord commands provide help, persisted status, safe investigation start, and honest ask behavior', async () => {
  const f = fixture();
  await f.bot.start();
  await f.bot.handleMessage(f.message('help-1', '!help'));
  assert.match(f.replies.at(-1).content, /!investigate CASE-001/);

  await f.bot.handleMessage(f.message('status-1', '!status CASE-001'));
  assert.match(f.replies.at(-1).content, /CASE-001 · completed/);
  assert.match(f.replies.at(-1).content, /AUDITOR: \*\*complete\*\*/);

  await f.bot.handleMessage(f.message('bad-case', '!investigate anything'));
  assert.match(f.replies.at(-1).content, /form `CASE-001`/);
  await f.bot.handleMessage(f.message('unknown-case', '!status CASE-999'));
  assert.match(f.replies.at(-1).content, /not found/);

  await f.bot.handleMessage(f.message('start-1', '!investigate CASE-001'));
  assert.equal(f.getStarts(), 1);
  assert.match(f.replies.at(-1).content, /Started Switch investigation/);
  await f.bot.handleMessage(f.message('start-2', '!investigate CASE-001'));
  assert.equal(f.getStarts(), 1);
  assert.match(f.replies.at(-1).content, /did not create another investigation/);

  await f.bot.handleMessage(f.message('ask-1', '!ask CASE-001 Please verify the receipt.'));
  assert.match(f.replies.at(-1).content, /no safe human-input handoff/);
  assert.match(f.replies.at(-1).content, /not forwarded/);
  await f.bot.stop();
});

test('Discord bot ignores its own messages, other channels, non-commands, and duplicate message events', async () => {
  const f = fixture();
  await f.bot.start();
  await f.bot.handleMessage(f.message('bot-message', '!help', { author: { bot: true } }));
  await f.bot.handleMessage(f.message('other-channel', '!help', { channelId: 'other-channel' }));
  await f.bot.handleMessage(f.message('plain-text', 'hello'));
  await f.bot.handleMessage(f.message('one-help', '!help'));
  await f.bot.handleMessage(f.message('one-help', '!help'));
  assert.equal(f.replies.length, 1);
  await f.bot.stop();
});

test('Discord receives a correlated RECON report as readable MatchPoint embeds once', async () => {
  const f = fixture();
  await f.bot.start();
  const report = { agent: 'RECON', task_id: 'run-1:RECON', case_id: 'CASE-001', findings: ['Actual report content from the Switch workflow.'] };
  const payload = {
    caseId: 'CASE-001',
    investigationId: 'run-1',
    event: { id: 'event-1', title: 'RECON report produced', kind: 'switch', source: 'switch', body: JSON.stringify(report), switchMessageId: 'switch-message-1' }
  };
  await f.getListener()(payload);
  await f.getListener()(payload);
  assert.equal(f.sent.length, 1);
  const embeds = f.sent[0].embeds;
  assert.equal(embeds[0].title, 'Evidence Investigation Report');
  assert.match(embeds[0].description, /CASE-001/);
  assert.match(embeds[0].description, /run-1/);
  assert.match(embeds[0].description, /run-1:RECON/);
  assert.match(embeds.map(embed => `${embed.title}\n${embed.description || ''}`).join('\n'), /Actual report content from the Switch workflow/);
  assert.equal(embeds[1].title, 'Key Findings');
  await f.bot.stop();
});

test('AUDITOR and RESOLVER receive role-specific report sections with optional values represented clearly', async () => {
  const f = fixture();
  await f.bot.start();
  for (const role of ['AUDITOR', 'RESOLVER']) {
    const report = { agent: role, task_id: `run-2:${role}`, case_id: 'CASE-001', status: 'complete', findings: ['Reviewed ledger'], evidence_reviewed: ['Invoice 42'], calculations: 'Expected $1,200; paid $1,000', unresolved_questions: [], recommendation: 'Investigate the $200 variance', reasoning_summary: 'Amounts do not reconcile', ...(role === 'RESOLVER' ? { human_approval_required: true, payment_authorized: false, final_resolution_recommendation: 'Hold payment pending review' } : {}) };
    await f.getListener()({ caseId: 'CASE-001', investigationId: 'run-2', event: { id: `event-${role}`, title: `${role} report produced`, kind: 'switch', source: 'switch', body: JSON.stringify(report) } });
  }
  const allEmbeds = f.sent.flatMap(item => item.embeds);
  assert.ok(allEmbeds.some(embed => embed.title === 'Independent Audit Report'));
  assert.ok(allEmbeds.some(embed => embed.title === 'Final Resolution Report'));
  assert.ok(allEmbeds.some(embed => embed.title === 'Human Approval Required' && embed.description === 'true'));
  assert.ok(allEmbeds.some(embed => embed.title === 'Payment Authorized' && embed.description === 'false'));
  assert.ok(allEmbeds.some(embed => embed.title === 'Final Resolution Recommendation' && embed.description.includes('Hold payment')));
  assert.ok(allEmbeds.some(embed => embed.title === 'Unresolved Questions' && embed.description === 'Not provided'));
  assert.ok(allEmbeds.some(embed => embed.title === 'Calculations & Financial Discrepancies' && embed.description.includes('$1,200')));
  await f.bot.stop();
});

test('long report content is split across valid embed batches without losing findings or recommendation', async () => {
  const f = fixture();
  await f.bot.start();
  const finding = `Finding-${'important evidence '.repeat(60)}`;
  const recommendation = 'Review the unresolved financial variance.';
  const report = { agent: 'RECON', task_id: 'run-long:RECON', case_id: 'CASE-001', findings: [finding], recommendation };
  await f.getListener()({ caseId: 'CASE-001', investigationId: 'run-long', event: { id: 'event-long', title: 'RECON report produced', kind: 'switch', source: 'switch', body: JSON.stringify(report) } });
  const embeds = f.sent.flatMap(item => item.embeds);
  assert.ok(embeds.length > 7);
  assert.ok(embeds.some(embed => embed.title.startsWith('Key Findings')));
  assert.ok(embeds.some(embed => embed.title === 'Recommendation'));
  const findingsText = embeds.filter(embed => embed.title.startsWith('Key Findings')).map(embed => embed.description || '').join('').replace(/\n/g, '');
  const recommendationText = embeds.filter(embed => embed.title === 'Recommendation').map(embed => embed.description || '').join('');
  assert.equal(findingsText.includes(finding), true, 'all finding text is present across embed chunks');
  assert.equal(recommendationText.includes(recommendation), true, 'recommendation is preserved');
  for (const message of f.sent) {
    assert.ok(message.embeds.length <= 10);
    let total = 0;
    for (const embed of message.embeds) {
      assert.ok((embed.title || '').length <= 256);
      assert.ok((embed.description || '').length <= 4096);
      for (const field of embed.fields || []) {
        assert.ok(field.name.length <= 256);
        assert.ok(field.value.length <= 1024);
      }
      total += (embed.title?.length || 0) + (embed.description?.length || 0) + (embed.author?.name.length || 0) + (embed.fields || []).reduce((n, field) => n + field.name.length + field.value.length, 0);
      assert.ok(total <= 6000);
    }
  }
  await f.bot.stop();
});

test('Discord integration disables itself without credentials and does not log secret values', async () => {
  const f = fixture();
  const disabled = new DiscordIntegration(f.service, { env: {}, logger: f.bot.logger });
  assert.equal((await disabled.start()).state, 'disabled');

  const loggerCalls = [];
  const client = new FakeClient({ isTextBased: () => true, isDMBased: () => false, permissionsFor: () => ({ has: () => true }), send: async () => {} });
  client.login = async () => { throw new Error('fixture-token must not be logged'); };
  const broken = new DiscordIntegration(f.service, {
    env: { DISCORD_BOT_TOKEN: 'fixture-token', DISCORD_CHANNEL_ID: 'channel-1' },
    clientFactory: () => client,
    logger: { info() {}, warn() {}, error: (...args) => loggerCalls.push(args) }
  });
  await assert.rejects(broken.start(), /fixture-token must not be logged/);
  assert.equal(JSON.stringify(loggerCalls).includes('fixture-token'), false);
  await broken.stop();
});

test('Discord surfaces a rejected Message Content intent without waiting for the ready timeout', async () => {
  const f = fixture();
  const client = new FakeClient(f.client.channel);
  client.login = async () => {
    queueMicrotask(() => client.emit('shardDisconnect', { code: 4014 }, 0));
    return 'fixture-token';
  };
  const bot = new DiscordIntegration(f.service, {
    env: { DISCORD_BOT_TOKEN: 'fixture-token', DISCORD_CHANNEL_ID: 'channel-1' },
    clientFactory: () => client,
    logger: f.bot.logger,
    readyTimeoutMs: 60000
  });
  await assert.rejects(bot.start(), error => error.code === 'privileged_intent');
  assert.equal(bot.getStatus().state, 'error');
  await bot.stop();
});
