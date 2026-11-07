import { Client, Events, GatewayIntentBits, PermissionFlagsBits } from 'discord.js';

const caseIdPattern = /^CASE-\d{3}$/;
const reportTitlePattern = /^(RECON|AUDITOR|RESOLVER) report produced$/;
const EMBED_FIELD_LIMIT = 1024;
const EMBED_DESCRIPTION_LIMIT = 4096;
const EMBED_TOTAL_LIMIT = 6000;
const EMBEDS_PER_MESSAGE = 10;
const ROLE_REPORTS = {
  RECON: 'Evidence Investigation Report',
  AUDITOR: 'Independent Audit Report',
  RESOLVER: 'Final Resolution Report'
};
const ROLE_COLORS = { RECON: 0x2878a8, AUDITOR: 0x6b7280, RESOLVER: 0x287a55 };

function chunks(text, maxLength) {
  const characters = Array.from(text);
  const parts = [];
  for (let offset = 0; offset < characters.length; offset += maxLength) {
    parts.push(characters.slice(offset, offset + maxLength).join(''));
  }
  return parts.length ? parts : [''];
}

function asText(value) {
  if (value == null || value === '') return '';
  if (Array.isArray(value)) return value.map(item => typeof item === 'string' ? item : JSON.stringify(item)).join('\n');
  if (typeof value === 'object') return Object.entries(value).map(([key, item]) => `${key}: ${asText(item)}`).join('\n');
  return String(value);
}

function firstValue(report, keys) {
  for (const key of keys) if (report[key] != null && report[key] !== '') return report[key];
  return '';
}

function splitField(text, limit = EMBED_FIELD_LIMIT) {
  const source = String(text || 'Not provided');
  const lines = source.split('\n');
  const result = [];
  let part = '';
  for (const line of lines) {
    const slices = chunks(line, limit);
    for (const slice of slices) {
      const next = part ? `${part}\n${slice}` : slice;
      if (next.length > limit) { result.push(part); part = slice; }
      else part = next;
    }
  }
  if (part || !result.length) result.push(part || 'Not provided');
  return result;
}

function reportEmbeds({ caseId, investigationId, role, report }) {
  const status = asText(firstValue(report, ['status', 'report_status'])) || 'Not provided';
  const sections = [
    ['Key Findings', firstValue(report, ['key_findings', 'findings'])],
    ['Evidence Reviewed', firstValue(report, ['evidence_reviewed', 'evidence'])],
    ['Calculations & Financial Discrepancies', firstValue(report, ['calculations', 'financial_discrepancies', 'discrepancies'])],
    ['Unresolved Questions', firstValue(report, ['unresolved_questions', 'open_questions', 'questions'])],
    ['Recommendation', firstValue(report, ['recommendation', 'recommendations'])],
    ['Reasoning Summary', firstValue(report, ['reasoning_summary', 'summary', 'reasoning'])]
  ];
  if (role === 'RESOLVER') sections.splice(4, 0,
    ['Human Approval Required', firstValue(report, ['human_approval_required'])],
    ['Payment Authorized', firstValue(report, ['payment_authorized'])],
    ['Final Resolution Recommendation', firstValue(report, ['final_resolution_recommendation', 'resolution_recommendation'])]
  );
  const embeds = [];
  const header = {
    color: ROLE_COLORS[role],
    author: { name: 'MatchPoint Investigation Reports' },
    title: ROLE_REPORTS[role],
    description: `**Case:** ${caseId}\n**Investigation:** ${investigationId}\n**Task:** ${report.task_id}\n**Agent:** ${role} · **Status:** ${status}`,
    fields: []
  };
  embeds.push(header);
  for (const [name, raw] of sections) {
    const value = asText(raw) || 'Not provided';
    const parts = splitField(value);
    parts.forEach((part, index) => {
      embeds.push({
        color: ROLE_COLORS[role],
        author: { name: 'MatchPoint Investigation Reports' },
        title: `${name}${parts.length > 1 ? ` (${index + 1}/${parts.length})` : ''}`,
        description: part.length <= EMBED_DESCRIPTION_LIMIT ? part : undefined,
        fields: part.length <= EMBED_DESCRIPTION_LIMIT ? [] : [{ name: 'Details', value: part }]
      });
    });
  }
  // Each embed is independently below Discord's per-embed total limit. Send
  // sequential batches so every report section is delivered without truncation.
  return embeds;
}

export class DiscordIntegration {
  constructor(service, {
    env = process.env,
    clientFactory = options => new Client(options),
    logger = console,
    readyTimeoutMs = 20000
  } = {}) {
    this.service = service;
    this.token = env.DISCORD_BOT_TOKEN || '';
    this.channelId = env.DISCORD_CHANNEL_ID || '';
    this.clientFactory = clientFactory;
    this.logger = logger;
    this.readyTimeoutMs = readyTimeoutMs;
    this.client = null;
    this.channel = null;
    this.state = 'stopped';
    this.starting = null;
    this.rejectReady = null;
    this.connectionFailure = null;
    this.stopping = false;
    this.seenMessageIds = new Set();
    this.publishedEventIds = new Set();
    this.pendingReports = [];
    this.flushingReports = false;
    this.unsubscribe = this.service.addInvestigationEventListener?.(
      payload => this.publishAgentResponse(payload)
    ) || null;
  }

  get configured() {
    return Boolean(this.token && this.channelId);
  }

  getStatus() {
    return {
      configured: this.configured,
      state: this.state,
      channelId: this.channelId || null
    };
  }

  async start() {
    if (!this.configured) {
      this.state = 'disabled';
      this.logger.info('MatchPoint Discord integration disabled: bot token or channel ID is not configured.');
      return this.getStatus();
    }
    if (this.starting) return this.starting;
    if (this.state === 'connected') return this.getStatus();
    if (this.stopping) throw new Error('Discord integration is shutting down.');

    this.state = 'connecting';
    this.client = this.clientFactory({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
      ]
    });
    this.client.on(Events.MessageCreate, message => {
      void this.handleMessage(message).catch(error => {
        this.logError('Discord command handling failed.', error);
      });
    });
    this.client.on(Events.Error, error => this.logError('Discord client error.', error));
    this.client.on(Events.Warn, warning => this.logger.warn('Discord client warning.', { warning: String(warning).slice(0, 300) }));
    this.client.on(Events.ShardReconnecting, shardId => {
      this.state = 'reconnecting';
      this.logger.warn('MatchPoint Discord reconnecting.', { shardId });
    });
    this.client.on(Events.ShardResume, (shardId, replayedEvents) => {
      this.state = 'connected';
      this.logger.info('MatchPoint Discord connection resumed.', { shardId, replayedEvents });
      void this.flushPendingReports();
    });
    this.client.on(Events.ShardDisconnect, (closeEvent, shardId) => {
      const rejectedIntent = closeEvent?.code === 4014;
      this.state = rejectedIntent ? 'error' : 'reconnecting';
      this.logger.warn('MatchPoint Discord disconnected; discord.js will reconnect.', {
        shardId,
        code: closeEvent?.code || null
      });
      if (rejectedIntent) {
        const error = Object.assign(
          new Error('Discord rejected the privileged Message Content intent. Enable Message Content Intent for the MatchPoint Agent application.'),
          { code: 'privileged_intent' }
        );
        this.connectionFailure = error;
        this.rejectReady?.(error);
      }
    });

    this.starting = this.connect().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async connect() {
    let readyTimer;
    this.connectionFailure = null;
    try {
      const ready = new Promise((resolve, reject) => {
        this.rejectReady = reject;
        readyTimer = setTimeout(() => reject(new Error('Discord did not become ready before the connection timeout.')), this.readyTimeoutMs);
        this.client.once(Events.ClientReady, async () => {
          try {
            const channel = await this.client.channels.fetch(this.channelId);
            if (!channel?.isTextBased?.() || channel.isDMBased?.() || typeof channel.send !== 'function') {
              throw new Error('Configured Discord channel is not a sendable guild text channel.');
            }
            const permissions = channel.permissionsFor?.(this.client.user);
            const requiredPermissions = [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.ReadMessageHistory,
              PermissionFlagsBits.SendMessages
            ];
            if (permissions && !requiredPermissions.every(permission => permissions.has(permission))) {
              throw new Error('MatchPoint Agent needs View Channel, Read Message History, and Send Messages in the configured Discord channel.');
            }
            this.channel = channel;
            this.state = 'connected';
            this.rejectReady = null;
            this.logger.info('MatchPoint Discord connected.', {
              botUserId: this.client.user?.id || null,
              channelId: this.channelId
            });
            void this.flushPendingReports();
            resolve();
          } catch (error) {
            reject(error);
          }
        });
      });
      // A privileged-intent close can reject readiness while login() is
      // still settling. Attach immediately so Node does not report an
      // unhandled rejection before the awaited login promise returns.
      ready.catch(() => {});

      await this.client.login(this.token);
      await ready;
      return this.getStatus();
    } catch (error) {
      this.state = 'error';
      const failure = this.connectionFailure || error;
      this.logError('MatchPoint Discord connection failed.', failure);
      this.client?.destroy();
      throw failure;
    } finally {
      this.rejectReady = null;
      this.connectionFailure = null;
      clearTimeout(readyTimer);
    }
  }

  async stop() {
    this.stopping = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.starting) await this.starting.catch(() => {});
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }
    this.channel = null;
    this.state = 'stopped';
  }

  async handleMessage(message) {
    if (
      !message ||
      message.author?.bot ||
      message.channelId !== this.channelId ||
      !message.id ||
      this.seenMessageIds.has(message.id)
    ) return;

    const content = String(message.content || '').trim();
    if (!content.startsWith('!')) return;
    this.remember(this.seenMessageIds, message.id);

    const [command = '', ...args] = content.split(/\s+/);
    const normalized = command.toLowerCase();
    try {
      if (normalized === '!help') return this.reply(message, this.helpText());
      if (normalized === '!investigate') return this.investigate(message, args[0]);
      if (normalized === '!status') return this.status(message, args[0]);
      if (normalized === '!ask') return this.ask(message, content);
      return this.reply(message, 'Unknown command. Use `!help` to see available commands.');
    } catch (error) {
      this.logError('Discord command failed.', error);
      return this.reply(message, 'The command could not be completed. Check the MatchPoint backend logs.');
    }
  }

  helpText() {
    return [
      '**MatchPoint investigation commands**',
      '`!help` — show this help',
      '`!investigate CASE-001` — start a Switch-backed investigation',
      '`!status CASE-001` — show persisted investigation and stage status',
      '`!ask CASE-001 <message>` — check whether a running investigation can accept a human instruction'
    ].join('\n');
  }

  async investigate(message, caseId) {
    if (!this.validCaseId(caseId)) return this.reply(message, 'Use a case ID in the form `CASE-001`.');
    if (this.service.mode !== 'SWITCH') {
      return this.reply(message, 'Live Switch investigations are not enabled in MatchPoint; no investigation was started.');
    }

    const record = await this.service.getCase(caseId);
    if (!record) return this.reply(message, `Case \`${caseId}\` was not found.`);
    const latest = record.latestInvestigation;
    if (latest?.status === 'running') {
      return this.reply(message, `Investigation \`${latest.id}\` for ${caseId} is already marked running. I did not create another investigation. Use \`!status ${caseId}\` for its persisted stage states.`);
    }

    const run = await this.service.startInvestigation(caseId);
    if (!run) return this.reply(message, `Case \`${caseId}\` was not found.`);
    return this.reply(message, `Started Switch investigation \`${run.id}\` for ${caseId}. Use \`!status ${caseId}\` to check progress.`);
  }

  async status(message, caseId) {
    if (!this.validCaseId(caseId)) return this.reply(message, 'Use a case ID in the form `CASE-001`.');
    const record = await this.service.getCase(caseId);
    if (!record) return this.reply(message, `Case \`${caseId}\` was not found.`);
    const run = record.latestInvestigation;
    if (!run) return this.reply(message, `No investigation is recorded for ${caseId}.`);
    const stages = ['recon', 'auditor', 'resolver']
      .map(role => `${role.toUpperCase()}: **${run.stages?.[role]?.status || 'unknown'}**`)
      .join(' · ');
    const error = run.error ? `\nError: ${run.error}` : '';
    return this.reply(message, `**${caseId} · ${run.status}**\nInvestigation: \`${run.id}\`\n${stages}${error}`);
  }

  async ask(message, content) {
    const match = content.match(/^!ask\s+(\S+)\s+([\s\S]+)$/i);
    if (!match) return this.reply(message, 'Usage: `!ask CASE-001 <message>`');
    const [, caseId] = match;
    if (!this.validCaseId(caseId)) return this.reply(message, 'Use a case ID in the form `CASE-001`.');
    const record = await this.service.getCase(caseId);
    if (!record) return this.reply(message, `Case \`${caseId}\` was not found.`);
    if (record.latestInvestigation?.status !== 'running') {
      return this.reply(message, `No active investigation is accepting instructions for ${caseId}. Your message was not forwarded.`);
    }
    return this.reply(message, `Investigation \`${record.latestInvestigation.id}\` is active, but the current Switch workflow has no safe human-input handoff. Your message was not forwarded to an agent.`);
  }

  async publishAgentResponse({ caseId, investigationId, event }) {
    const match = event?.title?.match(reportTitlePattern);
    if (!this.configured || !match || event.source !== 'switch' || event.kind !== 'switch' || !event.id || this.publishedEventIds.has(event.id)) return;

    let report;
    try {
      report = JSON.parse(event.body);
    } catch {
      this.logger.error('Switch report could not be published to Discord: invalid JSON body.', { caseId, investigationId, eventId: event.id });
      return;
    }
    const [, role] = match;
    if (
      report.agent !== role ||
      report.case_id !== caseId ||
      report.task_id !== `${investigationId}:${role}`
    ) {
      this.logger.error('Switch report did not match its investigation correlation.', { caseId, investigationId, role, eventId: event.id });
      return;
    }
    this.remember(this.publishedEventIds, event.id);
    this.pendingReports.push({ caseId, investigationId, event, role, report });
    if (this.pendingReports.length > 1000) this.pendingReports.shift();
    await this.flushPendingReports();
  }

  async flushPendingReports() {
    if (this.flushingReports || !this.channel || this.state !== 'connected') return;
    this.flushingReports = true;
    try {
      while (this.pendingReports.length && this.channel && this.state === 'connected') {
        const payload = this.pendingReports.shift();
        const { caseId, investigationId, event, role, report } = payload;
        try {
          const embeds = reportEmbeds({ caseId, investigationId, role, report });
          for (let index = 0; index < embeds.length; index += EMBEDS_PER_MESSAGE) {
            const batch = embeds.slice(index, index + EMBEDS_PER_MESSAGE);
            // Keep each message's aggregate embed text under Discord's 6000-character limit.
            let messageEmbeds = [];
            let total = 0;
            for (const embed of batch) {
              const size = (embed.title?.length || 0) + (embed.description?.length || 0) + (embed.fields || []).reduce((sum, field) => sum + field.name.length + field.value.length, 0) + (embed.author?.name.length || 0);
              if (messageEmbeds.length && total + size > EMBED_TOTAL_LIMIT) {
                await this.channel.send({ embeds: messageEmbeds, allowedMentions: { parse: [] } });
                messageEmbeds = [];
                total = 0;
              }
              messageEmbeds.push(embed);
              total += size;
            }
            if (messageEmbeds.length) await this.channel.send({ embeds: messageEmbeds, allowedMentions: { parse: [] } });
          }
          this.logger.info('Switch agent report posted to Discord.', {
            caseId,
            investigationId,
            role,
            taskId: report.task_id,
            switchEventId: event.switchMessageId || null,
            discordEventId: event.id
          });
        } catch (error) {
          this.pendingReports.unshift(payload);
          this.logError('Switch report could not be posted to Discord; it remains queued.', error);
          return;
        }
      }
    } finally {
      this.flushingReports = false;
    }
  }

  async reply(message, content) {
    await message.reply({ content, allowedMentions: { parse: [] } });
  }

  validCaseId(value) {
    return typeof value === 'string' && caseIdPattern.test(value);
  }

  remember(set, value) {
    set.add(value);
    if (set.size > 10000) set.delete(set.values().next().value);
  }

  logError(message, error) {
    this.logger.error(message, {
      name: error?.name || 'Error',
      code: error?.code || error?.status || 'unknown',
      ...(error?.code === 'privileged_intent' ? { hint: 'Enable Message Content Intent in the Discord Developer Portal.' } : {})
    });
  }
}
