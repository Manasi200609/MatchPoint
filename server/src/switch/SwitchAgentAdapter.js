/**
 * Adapter for Switch's documented Agent Bridge operations API.
 * It uses the same operation names as Switch's MCP surface, via
 * POST /agents/{agent_id}/ops/{operation}. A live agent API key and an active
 * connection ID belonging to that agent are required; this module does not
 * invent room-management endpoints or register agents on the user's behalf.
 */
export class SwitchAdapterError extends Error {
  constructor(code, message, status = 0) { super(message); this.name = 'SwitchAdapterError'; this.code = code; this.status = status; }
}

export class SwitchAgentAdapter {
  constructor({ apiUrl, agentId, apiKey, connectionId, roomId, agentNames, timeoutMs = 12000, fetchImpl = fetch }) {
    this.apiUrl = String(apiUrl || '').replace(/\/$/, '');
    this.agentId = agentId || '';
    this.apiKey = apiKey || '';
    this.connectionId = connectionId || '';
    this.roomId = roomId || '';
    this.agentNames = agentNames || {};
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
  }

  get configured() { return Boolean(this.apiUrl && this.agentId && this.apiKey && this.connectionId && this.roomId && this.agentNames.recon && this.agentNames.auditor && this.agentNames.resolver); }

  async request(path, { method = 'GET', body, signal } = {}) {
    let response;
    try {
      response = await this.fetch(`${this.apiUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(this.connectionId ? { 'X-Switch-Connection-Id': this.connectionId } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: signal || AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      throw new SwitchAdapterError(timedOut ? 'timeout' : 'unreachable', timedOut ? 'Switch did not respond before the configured timeout.' : 'Could not connect to Switch. Check the Switch API URL and server availability.');
    }
    if (response.status === 401) throw new SwitchAdapterError('authentication', 'Switch rejected the configured agent credential.', 401);
    if (response.status === 403) throw new SwitchAdapterError('authorization', 'The configured Switch agent is not allowed to access this resource.', 403);
    if (response.status === 404) throw new SwitchAdapterError('not_found', 'Switch could not find the configured agent, room, or operation.', 404);
    if (!response.ok) throw new SwitchAdapterError('switch_error', `Switch returned an error (${response.status}).`, response.status);
    try { return await response.json(); } catch { throw new SwitchAdapterError('invalid_response', 'Switch returned an invalid response.'); }
  }

  async operation(name, args = {}) {
    const result = await this.request(`/agents/${encodeURIComponent(this.agentId)}/ops/${encodeURIComponent(name)}`, { method: 'POST', body: args });
    if (!Object.hasOwn(result || {}, 'result')) throw new SwitchAdapterError('invalid_response', `Switch operation ${name} returned an unexpected response.`);
    return result.result;
  }

  async checkConnection() {
    if (!this.configured) return { connected: false, mode: 'LIVE', error: 'Live Switch mode needs the API URL, registered orchestrator agent credentials, active connection ID, room ID, and three agent names.' };
    try {
      const listed = await this.request(`/agents/${encodeURIComponent(this.agentId)}/ops`);
      if (!listed?.operations || typeof listed.operations !== 'object') throw new SwitchAdapterError('invalid_response', 'Switch did not return its documented agent operation list.');
      const room = await this.operation('connect_to_room', { room_id: this.roomId });
      const participants = await this.operation('list_participants');
      if (!Array.isArray(participants)) throw new SwitchAdapterError('invalid_response', 'Switch list_participants returned an unexpected response.');
      const agents = participants.filter(p => p?.type === 'agent');
      const names = new Set(agents.map(p => String(p.name || '').toLowerCase()));
      const missing = Object.values(this.agentNames).filter(name => !names.has(String(name).toLowerCase()));
      if (missing.length) throw new SwitchAdapterError('agents_missing', `Required agents are not members of the configured room: ${missing.join(', ')}.`);
      return { connected: true, mode: 'LIVE', roomId: this.roomId, roomName: room?.name || null, agents };
    } catch (error) {
      return { connected: false, mode: 'LIVE', roomId: this.roomId, error: error instanceof SwitchAdapterError ? error.message : 'Switch connection check failed.' };
    }
  }

  async sendTask({ role, prompt, threadId }) {
    const target = this.agentNames[role.toLowerCase()];
    if (!target) throw new SwitchAdapterError('agent_unavailable', `No Switch participant is configured for ${role}.`);
    const result = await this.operation('send_targeted_message', { body: prompt, target_names: [target], ...(threadId ? { thread_id: threadId } : {}) });
    if (!result || typeof result.event_id !== 'string' || !result.event_id || !result.target_statuses || typeof result.target_statuses !== 'object') {
      throw new SwitchAdapterError('invalid_response', 'Switch send_targeted_message returned an unexpected response.');
    }
    const delivery = result.target_statuses[target];
    if (!delivery) throw new SwitchAdapterError('agent_unavailable', `Switch did not report a delivery status for ${target}.`);
    if (['no_session', 'disconnected'].includes(delivery)) throw new SwitchAdapterError('agent_unavailable', `${target} is ${delivery} in Switch and cannot receive this task.`);
    if (!['live', 'awaiting_manual_poll', 'not_permitted'].includes(delivery)) throw new SwitchAdapterError('agent_unavailable', `Switch reported unsupported delivery status for ${target}: ${delivery}.`);
    return { ...result, target, delivery };
  }

  async readUpdates({ since } = {}) {
    const context = await this.operation('read_context', { room_id: this.roomId, limit: 100, ...(since ? { since: new Date(since).toISOString() } : {}) });
    if (!context || !Array.isArray(context.threads)) throw new SwitchAdapterError('invalid_response', 'Switch read_context returned an unexpected response.');
    return context.threads.flatMap(thread => {
      if (!thread?.root || !Array.isArray(thread.replies)) throw new SwitchAdapterError('invalid_response', 'Switch read_context returned a malformed thread.');
      const threadId = thread.root.id;
      return [thread.root, ...thread.replies].map(message => ({ id: message.id, sender: message.sender_name, body: message.body, timestamp: message.timestamp, timestampMs: typeof message.timestamp === 'number' ? message.timestamp : Date.parse(message.timestamp), kind: message.kind || 'message', source: 'switch', threadId }));
    }).filter(message => typeof message.id === 'string' && typeof message.sender === 'string' && typeof message.body === 'string' && Number.isFinite(message.timestampMs));
  }

  async waitForAgentReply({ role, after, threadId, timeoutMs = 120000, pollMs = 1500 }) {
    const expected = this.agentNames[role.toLowerCase()].toLowerCase();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const messages = await this.readUpdates({ since: after });
      const found = messages.find(message => message.kind === 'message' && String(message.sender || '').toLowerCase() === expected && message.timestampMs >= after && (!threadId || message.threadId === threadId) && message.id !== threadId);
      if (found) return found;
      await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
    }
    throw new SwitchAdapterError('agent_timeout', `${role} did not respond before the configured agent timeout.`);
  }

  async getInvestigationUpdates() { return this.readUpdates(); }
}
