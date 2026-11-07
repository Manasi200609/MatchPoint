
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  SwitchRoleSession,
  SwitchSessionError
} from './SwitchRoleSession.js';

import {
  auditRecon,
  buildMockWorkflow,
  resolveFindings
} from '../services/agentWorkflow.js';

const roles = ['RECON', 'AUDITOR', 'RESOLVER'];

const nextRole = {
  RECON: 'AUDITOR',
  AUDITOR: 'RESOLVER'
};

const priorRole = {
  RECON: 'RESOLVER',
  AUDITOR: 'RECON',
  RESOLVER: 'AUDITOR'
};

const envelopeType = 'matchpoint.investigation.task';
const resultType = 'matchpoint.investigation.result';

const SAFE_PROCESSING_ERROR =
  'Agent processing failed. Retry the investigation.';

function parseMessage(body) {
  if (typeof body !== 'string') return null;

  try {
    // Switch prefixes targeted messages with the addressed participant
    // mention (for example "@recon {\"type\":...}"). Keep parsing strict
    // after removing that transport-level prefix.
    const content = body.replace(/^@[^\s]+\s+/, '');
    const parsed = JSON.parse(content);

    return parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function createStoppingError() {
  return new SwitchSessionError(
    'stopping',
    'Switch collaboration is shutting down.'
  );
}

function isValidRole(role) {
  return roles.includes(role);
}

function agentCasePayload(caseRecord) {
  return {
    id: caseRecord.id,
    synthetic: Boolean(caseRecord.synthetic),
    testCaseKey: caseRecord.testCaseKey || null,
    scenarioContext: caseRecord.investigationContext || null,
    vendor: caseRecord.vendor,
    invoice: caseRecord.invoice,
    purchaseOrder: caseRecord.purchaseOrder,
    goodsReceived: caseRecord.goodsReceived,
    evidence: caseRecord.evidence
  };
}

/**
 * The incoming case must be identical to the original case.
 * Matching only the case ID is insufficient because an agent
 * could otherwise alter financial values or supporting evidence.
 */
function isValidCasePayload(caseData, originalCase) {
  return (
    Boolean(caseData) &&
    typeof caseData === 'object' &&
    !Array.isArray(caseData) &&
    isDeepStrictEqual(caseData, agentCasePayload(originalCase))
  );
}

/**
 * Return only the reports that a role is permitted to receive.
 */
function expectedReportsForRole(role, state) {
  if (role === 'RECON') {
    return {};
  }

  if (role === 'AUDITOR') {
    return {
      recon: state.reports.recon
    };
  }

  if (role === 'RESOLVER') {
    return {
      recon: state.reports.recon,
      auditor: state.reports.auditor
    };
  }

  return null;
}

/**
 * Reports must match the outputs produced by this investigation.
 * Missing, modified, or unexpected previous reports are rejected.
 */
function hasValidReports(role, incomingReports, state) {
  if (
    !incomingReports ||
    typeof incomingReports !== 'object' ||
    Array.isArray(incomingReports)
  ) {
    return false;
  }

  const expected = expectedReportsForRole(role, state);

  if (!expected) {
    return false;
  }

  if (
    role === 'AUDITOR' &&
    !state.reports.recon
  ) {
    return false;
  }

  if (
    role === 'RESOLVER' &&
    (!state.reports.recon || !state.reports.auditor)
  ) {
    return false;
  }

  return isDeepStrictEqual(incomingReports, expected);
}

/**
 * Match a Switch message to the expected registered room participant.
 * Agent Bridge exposes a Matrix-style sender ID on messages but UUIDs in
 * room membership, so use Switch's canonical sender_name only after confirming
 * that exact name belongs to a registered agent participant.
 */
function isRegisteredSender(
  session,
  expectedAgentName,
  senderId,
  senderName
) {
  if (
    !session ||
    !Array.isArray(session.participants)
  ) {
    return false;
  }

  const participant = session.participants.find(item =>
    String(item.name || '').toLowerCase() ===
    String(expectedAgentName || '').toLowerCase()
  );

  if (!participant?.id) return false;

  // Switch's read_context sender is its Matrix-style actor ID, while
  // connect_to_room exposes the registered agent UUID. The canonical
  // sender_name is the bridge field that links a room message to that
  // registered participant; compare it exactly and case-insensitively.
  if (
    typeof senderName === 'string' &&
    senderName.toLowerCase() === String(participant.name).toLowerCase()
  ) {
    return true;
  }

  return typeof senderId === 'string' && String(participant.id) === senderId;
}

export class SwitchCollaboration {
  constructor({
    env = process.env,
    reasoningAgents,
    fetchImpl = fetch,
    sessionFactory = options => new SwitchRoleSession(options),
    onStage = async () => {},
    onEvent = async () => {},
    onStatus = () => {}
  } = {}) {
    this.env = env;
    this.reasoningAgents = reasoningAgents;

    this.onStage = onStage;
    this.onEvent = onEvent;
    this.onStatus = onStatus;

    this.apiUrl =
      env.SWITCH_API_URL ||
      env.SWITCH_SERVER_URL ||
      '';

    this.roomId = env.SWITCH_ROOM_ID || '';

    this.timeoutMs =
      Number(env.SWITCH_REQUEST_TIMEOUT_MS) || 12000;
    this.agentTimeoutMs =
      Number(env.SWITCH_AGENT_TIMEOUT_MS) || 120000;

    this.agentNames = {
      RECON: env.SWITCH_RECON_NAME || 'RECON',
      AUDITOR: env.SWITCH_AUDITOR_NAME || 'AUDITOR',
      RESOLVER: env.SWITCH_RESOLVER_NAME || 'RESOLVER'
    };

    this.sessions = {};
    this.connectionIds = {};

    this.runs = new Map();

    this.processedMessageIds = new Set();
    this.inFlightMessageIds = new Set();
    this.pendingDeliveries = new Map();
    this.pollPromise = null;

    this.starting = null;
    this.lastError = null;
    this.stopping = false;

    this.configured = Boolean(
      this.apiUrl &&
      this.roomId &&
      roles.every(role =>
        env[`SWITCH_${role}_ID`] &&
        env[`SWITCH_${role}_API_KEY`]
      )
    );

    if (this.configured) {
      for (const role of roles) {
        this.connectionIds[role] =
          env[`SWITCH_${role}_CONNECTION_ID`] ||
          randomUUID();
      }

      if (
        new Set(Object.values(this.connectionIds)).size !==
        roles.length
      ) {
        throw new Error(
          'Switch role connection IDs must be distinct.'
        );
      }

      for (const role of roles) {
        this.sessions[role] = sessionFactory({
          apiUrl: this.apiUrl,
          agentId: env[`SWITCH_${role}_ID`],
          apiKey: env[`SWITCH_${role}_API_KEY`],
          agentName: this.agentNames[role],
          roomId: this.roomId,
          connectionId: this.connectionIds[role],
          timeoutMs: this.timeoutMs,
          fetchImpl,

          // Agent work can take longer than Switch's WebSocket heartbeat
          // window. Dispatch it in the background so the role session keeps
          // consuming ping and control frames while Groq is running.
          onEvent: frame => {
            void this.receive(role, frame).catch(error => {
              console.error('MATCHPOINT Switch event handler failed.', {
                role,
                event: frame?.event || null,
                messageId: frame?.data?.payload?.message_id || null,
                code: error?.code || 'unknown'
              });
            });
          },

          onStatus: status => this.onStatus(status)
        });
      }
    }
  }

  getStatus() {
    const sessions = Object.fromEntries(
      roles.map(role => [
        role,
        {
          state: this.sessions[role]?.state || 'unconfigured',
          phase: this.sessions[role]?.phase || null,
          error: this.sessions[role]?.lastError
            ? 'Switch session is unavailable.'
            : null
        }
      ])
    );

    const connected =
      this.configured &&
      roles.every(
        role => this.sessions[role]?.state === 'connected'
      );

    return {
      mode: 'SWITCH',
      connected,
      roomId: this.roomId || null,
      transport: 'websocket',
      sessions,
      error: !this.configured
        ? 'Switch role agent identities, API URL and room ID must be configured.'
        : this.lastError
          ? 'Switch collaboration is disconnected. Reconnect to retry.'
          : null
    };
  }

  async startSessions() {
    if (!this.configured) {
      throw new SwitchSessionError(
        'configuration',
        'Switch collaboration needs the API URL, room ID and all three role agent credentials.'
      );
    }

    if (this.stopping) {
      throw createStoppingError();
    }

    if (this.starting) {
      return this.starting;
    }

    if (
      roles.every(
        role => this.sessions[role].state === 'connected'
      )
    ) {
      return this.getStatus();
    }

    this.starting = Promise.all(
      roles.map(role => this.sessions[role].start())
    )
      .then(() => {
        if (this.stopping) {
          throw createStoppingError();
        }

        const status = this.getStatus();

        if (!status.connected) {
          throw new SwitchSessionError(
            'not_connected',
            'Not all Switch role sessions are connected.'
          );
        }

        this.lastError = null;

        return this.getStatus();
      })
      .catch(async error => {
        this.lastError = {
          role: error?.role || null,
          phase: error?.phase || null,
          code: error?.code || 'unknown'
        };

        await Promise.allSettled(
          roles.map(role => this.sessions[role]?.stop())
        );

        throw error;
      })
      .finally(() => {
        this.starting = null;
      });

    return this.starting;
  }

  async reconnect() {
    if (this.stopping) {
      throw createStoppingError();
    }

    return this.startSessions();
  }

  async stopSessions() {
    this.stopping = true;

    if (this.starting) {
      await this.starting.catch(() => {});
    }

    const results = await Promise.allSettled(
      roles.map(role => this.sessions[role]?.stop())
    );

    const failed = results.some(
      result => result.status === 'rejected'
    );

    if (failed) {
      this.lastError = {
        role: null,
        phase: 'shutdown',
        code: 'session_stop_failed'
      };

      throw new SwitchSessionError(
        'shutdown_failed',
        'One or more Switch sessions could not be stopped.'
      );
    }

    return this.getStatus();
  }

 
  async sendTargeted(
    fromRole,
    targetRole,
    body,
    threadId = null
  ) {
    if (this.stopping) {
      throw createStoppingError();
    }

    if (
      !isValidRole(fromRole) ||
      !isValidRole(targetRole)
    ) {
      throw new SwitchSessionError(
        'invalid_target',
        'The requested Switch role is invalid.'
      );
    }

    const sender = this.sessions[fromRole];

    if (!sender || sender.state !== 'connected') {
      throw new SwitchSessionError(
        'not_connected',
        `${fromRole} Switch session is not connected.`
      );
    }

    const targetName = this.agentNames[targetRole];

    const result = await sender.operation(
      'send_targeted_message',
      {
        body: JSON.stringify(body),
        target_names: [targetName],
        ...(threadId ? { thread_id: threadId } : {})
      }
    );

    if (
      typeof result?.event_id !== 'string' ||
      !result.event_id ||
      !result.target_statuses ||
      typeof result.target_statuses !== 'object'
    ) {
      throw new SwitchSessionError(
        'invalid_response',
        'Switch targeted-message response did not include an event ID and target status.'
      );
    }

    const delivery = result.target_statuses[targetName];

    // A queued message is accepted, but it is NOT an agent response.
    // The workflow still waits for the correlated incoming message.
    if (!['live', 'awaiting_manual_poll'].includes(delivery)) {
      throw new SwitchSessionError(
        'delivery_failed',
        `Switch could not deliver or queue the message for ${targetName}${delivery ? ` (${delivery})` : ''}.`
      );
    }

    if (delivery === 'awaiting_manual_poll') {
  this.pendingDeliveries.set(result.event_id, {
    eventId: result.event_id,
    targetRole,
    taskId: body.task_id,
    threadId: threadId || result.event_id,
      failures: 0,
      deadlineAt: Date.now() + this.agentTimeoutMs
  });

  this.startQueuedPolling();
}

    return {
      eventId: result.event_id,
      threadId: threadId || result.event_id,
      delivery
    };
  }

  startQueuedPolling() {
  if (this.pollPromise || this.stopping) return;

  this.pollPromise = this.pollQueuedDeliveries()
    .finally(() => {
      this.pollPromise = null;

      // Restart if another queued task arrived while polling.
      if (this.pendingDeliveries.size && !this.stopping) {
        this.startQueuedPolling();
      }
    });
}

async pollQueuedDeliveries() {
  while (!this.stopping && this.pendingDeliveries.size > 0) {
    for (const pending of [...this.pendingDeliveries.values()]) {
      if (this.stopping) break;

      const state = this.runs.get(pending.taskId);

      if (!state) {
        this.pendingDeliveries.delete(pending.eventId);
        continue;
      }

      if (Date.now() >= pending.deadlineAt) {
        this.pendingDeliveries.delete(pending.eventId);
        state.rejectCompletion(new SwitchSessionError(
          'agent_timeout',
          `Switch did not deliver the task to ${this.agentNames[pending.targetRole]} before the configured timeout.`
        ));
        continue;
      }

      const session = this.sessions[pending.targetRole];

      if (!session || session.state !== 'connected') {
        continue;
      }

      try {
        const context = await session.operation('read_context', {
          room_id: this.roomId,
          limit: 100
        });

        if (!context || !Array.isArray(context.threads)) {
          throw new SwitchSessionError(
            'invalid_response',
            'Switch read_context returned an unexpected response.'
          );
        }

        let found = null;

        for (const thread of context.threads) {
          if (!thread?.root || !Array.isArray(thread.replies)) {
            continue;
          }

          for (const message of [thread.root, ...thread.replies]) {
            if (message?.id === pending.eventId) {
              found = {
                ...message,
                threadId: thread.root.id
              };
              break;
            }
          }

          if (found) break;
        }

        if (!found) continue;

        if (
          typeof found.body !== 'string' ||
          typeof found.sender !== 'string'
        ) {
          throw new SwitchSessionError(
            'invalid_response',
            'Switch returned an incomplete queued message.'
          );
        }

        // The exact event ID was returned by our own targeted send.
        // This is the proof that this message was addressed to this role.
        this.pendingDeliveries.delete(pending.eventId);

        await this.receive(pending.targetRole, {
          event: 'message',
          data: {
            room_id: this.roomId,
            payload: {
              message_id: found.id,
              sender: found.sender,
              sender_name: found.sender_name,
              body: found.body,
              thread_id: found.threadId,
              addressed: true
            }
          }
        });

        if (state.expectedRole === pending.targetRole) {
          state.rejectCompletion(new SwitchSessionError(
            'invalid_task_message',
            `Switch returned a message that did not match the pending ${pending.targetRole} task.`
          ));
        }
      } catch (error) {
        pending.failures += 1;

        if (pending.failures >= 3) {
          this.pendingDeliveries.delete(pending.eventId);
          state.rejectCompletion(error);
        }
      }
    }

    if (this.pendingDeliveries.size > 0 && !this.stopping) {
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  }
}

  async execute({
    runId,
    caseRecord,
    calculations,
    onStage = this.onStage,
    onEvent = this.onEvent
  }) {
    if (this.stopping) {
      throw createStoppingError();
    }

    if (!runId || !caseRecord?.id) {
      throw new SwitchSessionError(
        'invalid_task',
        'A valid investigation run ID and case are required.'
      );
    }

    if (this.runs.has(runId)) {
      throw new SwitchSessionError(
        'duplicate_run',
        'An investigation with this run ID is already active.'
      );
    }

    await this.startSessions();

    if (this.stopping) {
      throw createStoppingError();
    }

    const workflow = buildMockWorkflow(caseRecord);

    let resolveCompletion;
    let rejectCompletion;

    const completion = new Promise((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });

    // Attach a rejection handler immediately. The original promise
    // remains rejectable and is still awaited below.
    completion.catch(() => {});

    const state = {
      runId,
      caseRecord,
      calculations,
      workflow,

      threadId: null,
      expectedRole: 'RECON',

      reports: {},
      stageOutputs: {},

      resolveCompletion,
      rejectCompletion,
      completion,

      onStage,
      onEvent
    };

    this.runs.set(runId, state);

    try {
      const kickoff = await this.sendTargeted(
        'RESOLVER',
        'RECON',
        {
          type: envelopeType,
          version: 1,
          task_id: runId,
          stage_task_id: `${runId}:RECON`,
          case_id: caseRecord.id,
          role: 'RECON',
          case: agentCasePayload(caseRecord),
          reports: {}
        }
      );

      // A synchronous test transport or very fast agent may already
      // have populated the thread ID while the kickoff was in flight.
      state.threadId ||= kickoff.threadId;

      await onEvent({
        actor: this.agentNames.RESOLVER,
        kind: 'switch',
        title: 'Task addressed to RECON',
        summary: kickoff.delivery === 'live'
            ? 'Switch delivered the CASE task to RECON.'
            : 'Switch queued the CASE task for RECON to retrieve.',
        body: kickoff.eventId,
        switchMessageId: kickoff.eventId,
        threadId: kickoff.threadId,
        source: 'switch'
      });

      return await completion;
    } catch (error) {
      rejectCompletion(error);
      throw error;
    } finally {
      this.runs.delete(runId);
    }
  }

  async receive(role, frame) {
    if (
      !isValidRole(role) ||
      !frame ||
      frame.event !== 'message' ||
      !frame.data ||
      typeof frame.data !== 'object'
    ) {
      return;
    }

    if (frame.data.room_id !== this.roomId) {
      return;
    }

    const payload = frame.data.payload;

    if (
      !payload ||
      typeof payload.message_id !== 'string' ||
      !payload.message_id
    ) {
      return;
    }

    const messageId = payload.message_id;

    if (
      this.processedMessageIds.has(messageId) ||
      this.inFlightMessageIds.has(messageId)
    ) {
      return;
    }

    const body = parseMessage(payload.body);

    if (!body) {
      return;
    }

    this.inFlightMessageIds.add(messageId);

    try {
      await this.processMessage(
        role,
        payload,
        body,
        messageId
      );
    } finally {
      this.inFlightMessageIds.delete(messageId);
    }
  }

  async processMessage(role, payload, body, messageId) {
    // ------------------------------------------------------------
    // Final RESOLVER result
    // ------------------------------------------------------------

    if (role === 'RESOLVER' && body.type === resultType) {
      const state = this.runs.get(body.task_id);

      if (
        !state ||
        state.caseRecord.id !== body.case_id ||
        body.version !== 1 ||
        body.role !== 'RESOLVER' ||
        body.stage_task_id !== `${state.runId}:RESOLVER` ||
        body.thread_id !== state.threadId ||
        payload.thread_id !== state.threadId
      ) {
        return;
      }

      const resolverSenderMatches = isRegisteredSender(
        this.sessions.RESOLVER,
        this.agentNames.RESOLVER,
        payload.sender,
        payload.sender_name
      );

      if (!resolverSenderMatches) {
        return;
      }

      if (
        !state.stageOutputs.RECON ||
        !state.stageOutputs.AUDITOR ||
        !state.stageOutputs.RESOLVER ||
        !isDeepStrictEqual(
          body.report,
          state.reports.resolver
        )
      ) {
        return;
      }

      this.remember(messageId);
      state.finalResultReceived = true;

      state.resolveCompletion({
        recon: state.stageOutputs.RECON,
        auditor: state.stageOutputs.AUDITOR,
        resolver: state.stageOutputs.RESOLVER,
        threadId: state.threadId,
        calculations: state.calculations
      });

      return;
    }

    // ------------------------------------------------------------
    // Normal role task
    // ------------------------------------------------------------

    if (payload.addressed !== true) {
      return;
    }

    if (
      body.type !== envelopeType ||
      body.version !== 1 ||
      body.role !== role
    ) {
      return;
    }

    const state = this.runs.get(body.task_id);

    if (
      !state ||
      body.case_id !== state.caseRecord.id ||
      body.stage_task_id !== `${state.runId}:${role}` ||
      state.expectedRole !== role
    ) {
      return;
    }

    // Never trust an agent-provided replacement case.
    if (
      !isValidCasePayload(
        body.case,
        state.caseRecord
      )
    ) {
      return;
    }

    // Every stage receives only the reports it is supposed to see.
    if (
      !hasValidReports(
        role,
        body.reports,
        state
      )
    ) {
      return;
    }

    const expectedSenderRole = priorRole[role];
    const expectedSender = this.sessions[expectedSenderRole];

    const senderMatches = isRegisteredSender(
      expectedSender,
      this.agentNames[expectedSenderRole],
      payload.sender,
      payload.sender_name
    );

    if (!senderMatches) {
      return;
    }

    if (
      role !== 'RECON' &&
      state.threadId &&
      payload.thread_id !== state.threadId
    ) {
      return;
    }

    state.threadId ||= payload.thread_id || payload.message_id;
    state.expectedRole = null;

    try {
      await state.onStage(role, {
        role,
        status: 'working',
        startedAt: new Date().toISOString(),
        eventId: messageId,
        threadId: state.threadId,
        error: null
      });

      await state.onEvent({
        actor: payload.sender_name || role,
        kind: 'switch',
        title: `${role} task received`,
        summary: `Switch delivered the correlated task to ${role}.`,
        body: messageId,
        switchMessageId: messageId,
        threadId: state.threadId,
        source: 'switch'
      });

      if (!this.reasoningAgents?.run) {
        throw new SwitchSessionError(
          'reasoning_unavailable',
          'The reasoning agent service is unavailable.'
        );
      }

      // Use the original, server-held case record after validating
      // the incoming message, not the incoming object itself.
      const model = await this.reasoningAgents.run(role, {
        taskId: body.stage_task_id,
        caseRecord: agentCasePayload(state.caseRecord),
        recon: state.reports.recon,
        auditor: state.reports.auditor
      });

      if (
        !model ||
        typeof model !== 'object' ||
        Array.isArray(model)
      ) {
        throw new SwitchSessionError(
          'invalid_model_output',
          'The reasoning agent returned an invalid report.'
        );
      }

      const deterministic =
        role === 'RECON'
          ? state.workflow.recon
          : role === 'AUDITOR'
            ? auditRecon(
                state.caseRecord,
                state.workflow.recon,
                state.calculations
              )
            : resolveFindings(
                state.caseRecord,
                state.workflow.recon,
                state.workflow.auditor,
                state.calculations
              );

      const output = {
        ...deterministic,

        modelFindings: model.findings,
        modelEvidence: model.evidence,
        modelCalculations: model.calculations,
        modelUnresolvedQuestions: model.unresolved_questions,
        modelRecommendation: model.recommendation,
        reasoningSummary: model.reasoning_summary,

        modelOutput: model
      };

      state.reports[role.toLowerCase()] = model;
      state.stageOutputs[role] = output;

      await state.onStage(role, {
        status:
          role === 'AUDITOR' &&
          deterministic.verificationStatus === 'CHALLENGED'
            ? 'challenged'
            : 'complete',

        output,
        rawOutput: JSON.stringify(model),
        completedAt: new Date().toISOString(),
        error: null
      });

      await state.onEvent({
        actor: role,
        kind: 'switch',
        title: `${role} report produced`,
        summary: `The ${role} reasoning report was produced and combined with deterministic findings.`,
        body: JSON.stringify(model),
        switchMessageId: messageId,
        threadId: state.threadId,
        source: 'switch'
      });

      const following = nextRole[role];

      if (following) {
        if (this.stopping) {
          throw createStoppingError();
        }

        state.expectedRole = following;

        const reports = { ...state.reports };

        const sent = await this.sendTargeted(
          role,
          following,
          {
            type: envelopeType,
            version: 1,
            task_id: state.runId,
            stage_task_id: `${state.runId}:${following}`,
            case_id: state.caseRecord.id,
            role: following,
            case: agentCasePayload(state.caseRecord),
            reports
          },
          state.threadId
        );

        await state.onEvent({
          actor: this.agentNames[role],
          kind: 'switch',
          title: `Report addressed to ${following}`,
          summary: sent.delivery === 'live'
            ? `Switch delivered the ${role} report and original case data to ${following}.`
            : `Switch queued the ${role} report and original case data for ${following} to retrieve.`,
          body: sent.eventId,
          switchMessageId: sent.eventId,
          threadId: state.threadId,
          source: 'switch'
        });
      } else {
        if (this.stopping) {
          throw createStoppingError();
        }

        const finalOutput = {
          type: resultType,
          version: 1,
          task_id: state.runId,
          stage_task_id: `${state.runId}:RESOLVER`,
          case_id: state.caseRecord.id,
          thread_id: state.threadId,
          role: 'RESOLVER',
          report: model
        };

        const result = await this.sessions.RESOLVER.operation(
          'post_message',
          {
            body: JSON.stringify(finalOutput),
            thread_id: state.threadId
          }
        );

        if (
          typeof result?.event_id !== 'string' ||
          !result.event_id
        ) {
          throw new SwitchSessionError(
            'invalid_response',
            'Switch RESOLVER reply did not include a message event ID.'
          );
        }

        await state.onEvent({
          actor: this.agentNames.RESOLVER,
          kind: 'switch',
          title: 'RESOLVER report posted',
          summary:
            'Switch accepted the final correlated report in the investigation thread.',
          body: result.event_id,
          switchMessageId: result.event_id,
          threadId: state.threadId,
          source: 'switch'
        });

        await this.waitForFinalResult(state, result.event_id);
      }

      this.remember(messageId);
    } catch (error) {
      try {
        await state.onStage(role, {
          status: 'failed',
          error: SAFE_PROCESSING_ERROR,
          completedAt: new Date().toISOString()
        });
      } catch {
        // Preserve the original processing failure.
      }

      state.rejectCompletion(error);
    }
  }

  remember(id) {
    this.processedMessageIds.add(id);

    if (this.processedMessageIds.size > 10000) {
      const oldest =
        this.processedMessageIds.values().next().value;

      this.processedMessageIds.delete(oldest);
    }
  }

  async waitForFinalResult(state, eventId) {
    const deadline = Date.now() + this.agentTimeoutMs;
    while (!state.finalResultReceived && !this.stopping && Date.now() < deadline) {
      const context = await this.sessions.RESOLVER.operation('read_context', {
        room_id: this.roomId,
        limit: 100
      });
      if (!context || !Array.isArray(context.threads)) {
        throw new SwitchSessionError(
          'invalid_response',
          'Switch read_context returned an unexpected response while awaiting the final report.'
        );
      }

      let found = null;
      for (const thread of context.threads) {
        if (!thread?.root || !Array.isArray(thread.replies)) continue;
        for (const message of [thread.root, ...thread.replies]) {
          if (message?.id === eventId) {
            found = { ...message, threadId: thread.root.id };
            break;
          }
        }
        if (found) break;
      }

      if (found) {
        await this.receive('RESOLVER', {
          event: 'message',
          data: {
            room_id: this.roomId,
            payload: {
              message_id: found.id,
              sender: found.sender,
              sender_name: found.sender_name,
              body: found.body,
              thread_id: found.threadId,
              addressed: false
            }
          }
        });
        if (state.finalResultReceived) return;
      }

      await new Promise(resolve => setTimeout(resolve, 1500));
    }

    if (this.stopping) throw createStoppingError();
    if (!state.finalResultReceived) {
      throw new SwitchSessionError(
        'agent_timeout',
        'Switch did not return a correlated final RESOLVER result before the configured timeout.'
      );
    }
  }
}
