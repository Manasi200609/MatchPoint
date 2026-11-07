
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export class SwitchSessionError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.name = 'SwitchSessionError';
    this.code = code;
    this.status = status;
  }
}

export class SwitchRoleSession {
  constructor({
    apiUrl,
    agentId,
    apiKey,
    agentName,
    roomId,
    timeoutMs = 12000,
    fetchImpl = fetch,
    WebSocketImpl = WebSocket,
    onEvent = async () => {},
    onStatus = () => {},
    connectionId = randomUUID(),
    clientVersion = '1.0.0'
  } = {}) {
    this.apiUrl = String(apiUrl || '').replace(/\/$/, '');
    this.agentId = agentId || '';
    this.apiKey = apiKey || '';
    this.agentName = agentName || '';
    this.roomId = roomId || '';
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
    this.WebSocketImpl = WebSocketImpl;
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this.connectionId = connectionId;
    this.clientVersion = clientVersion;

    this.state = 'disconnected';
    this.phase = 'idle';
    this.lastError = null;
    this.generation = null;
    this.position = {};
    this.cursor = 0;
    this.participants = [];

    this.stopped = true;
    this.socket = null;

    this.loopPromise = null;
    this.startPromise = null;
    this.readyPromise = null;
    this.readyResolve = null;
    this.readyReject = null;
    this.readySettled = false;
  }

  get configured() {
    return Boolean(
      this.apiUrl &&
      this.agentId &&
      this.apiKey &&
      this.agentName &&
      this.roomId
    );
  }

  headers(json = false, accept = 'application/json', operation = false) {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: accept,
      ...(json ? { 'Content-Type': 'application/json' } : {}),
      ...(operation
        ? { 'X-Switch-Connection-Id': this.connectionId }
        : {})
    };
  }

  async request(
    path,
    {
      method = 'GET',
      body,
      signal,
      accept = 'application/json',
      operation = false
    } = {}
  ) {
    let response;

    try {
      const timeoutSignal = AbortSignal.timeout(this.timeoutMs);

      response = await this.fetch(`${this.apiUrl}${path}`, {
        method,
        headers: this.headers(Boolean(body), accept, operation),
        body: body ? JSON.stringify(body) : undefined,
        signal: signal
          ? AbortSignal.any([signal, timeoutSignal])
          : timeoutSignal
      });
    } catch (error) {
      throw new SwitchSessionError(
        error?.name === 'TimeoutError' || error?.name === 'AbortError'
          ? 'timeout'
          : 'unreachable',
        'Switch request could not be completed.'
      );
    }

    if (response.status === 401) {
      throw new SwitchSessionError(
        'authentication',
        'Switch rejected a role agent credential.',
        401
      );
    }

    if (response.status === 403) {
      throw new SwitchSessionError(
        'authorization',
        'Switch denied a role agent operation.',
        403
      );
    }

    if (response.status === 404) {
      throw new SwitchSessionError(
        'not_found',
        'Switch could not find the role agent, room, or operation.',
        404
      );
    }

    if (response.status === 409) {
      throw new SwitchSessionError(
        'conflict',
        'Switch refused the role agent connection or operation.',
        409
      );
    }

    if (!response.ok) {
      throw new SwitchSessionError(
        'switch_error',
        `Switch returned an error (${response.status}).`,
        response.status
      );
    }

    return response;
  }

  async operation(name, args = {}) {
    const response = await this.request(
      `/agents/${encodeURIComponent(this.agentId)}/ops/${encodeURIComponent(name)}`,
      {
        method: 'POST',
        body: args,
        signal: AbortSignal.timeout(this.timeoutMs),
        operation: true
      }
    ).then(async r => ({ payload: await r.json() }));

    if (!Object.hasOwn(response.payload || {}, 'result')) {
      throw new SwitchSessionError(
        'invalid_response',
        `Switch operation ${name} returned an unexpected envelope.`
      );
    }

    return response.payload.result;
  }

  // Concurrent callers share one startup attempt.
  start() {
    if (!this.configured) {
      return Promise.reject(
        new SwitchSessionError(
          'configuration',
          `Switch ${this.agentName || 'role'} session needs an API URL, agent ID, agent credential and room ID.`
        )
      );
    }

    if (this.loopPromise) {
      return this.readyPromise;
    }

    if (this.startPromise) {
      return this.startPromise;
    }

    this.stopped = false;
    this.readySettled = false;
    this.phase = 'verify_operations';

    const attempt = this.startInternal();

    this.startPromise = attempt;

    attempt.then(
      () => {
        if (this.startPromise === attempt) {
          this.startPromise = null;
        }
      },
      () => {
        if (this.startPromise === attempt) {
          this.startPromise = null;
        }
      }
    );

    return attempt;
  }

  async startInternal() {
    try {
      const response = await this.request(
        `/agents/${encodeURIComponent(this.agentId)}/ops`
      );

      const body = await response.json().catch(() => null);

      const available =
        body?.operations &&
        typeof body.operations === 'object'
          ? body.operations
          : null;

      if (
        !available ||
        ![
          'connect_to_room',
          'send_targeted_message',
          'post_message'
        ].every(name => Object.hasOwn(available, name))
      ) {
        throw new SwitchSessionError(
          'operations_unavailable',
          `Switch ${this.agentName} does not expose the required room and message operations.`
        );
      }
    } catch (error) {
      error.role = this.agentName;
      error.phase = this.phase;

      this.lastError = {
        role: this.agentName,
        phase: this.phase,
        message: error.message
      };

      this.stopped = true;
      throw error;
    }

    // stop() may have been called while operation discovery was pending.
    if (this.stopped) {
      throw new SwitchSessionError(
        'stopped',
        `Switch ${this.agentName} session startup was cancelled.`
      );
    }

    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    this.loopPromise = this.runLoop();

    return this.readyPromise;
  }

  setState(state, error = null) {
    this.state = state;

    if (error) {
      this.lastError = {
        role: this.agentName,
        phase: this.phase,
        message: error
      };
    } else if (state === 'connected') {
      this.lastError = null;
    }

    this.onStatus({
      role: this.agentName,
      state,
      connectionId: this.connectionId,
      phase: this.phase,
      error
    });
  }

  async runLoop() {
    let backoff = 500;

    while (!this.stopped) {
      try {
        await this.readConnection();

        if (!this.stopped) {
          throw new SwitchSessionError(
            'stream_closed',
            'Switch WebSocket closed.'
          );
        }

        backoff = 500;
      } catch (error) {
        if (this.stopped) break;

        this.setState('disconnected', error.message);

        if (!this.readySettled) {
          this.readySettled = true;

          error.role ??= this.agentName;
          error.phase ??= this.phase;

          this.lastError = {
            role: this.agentName,
            phase: this.phase,
            message: error.message
          };

          this.readyReject?.(error);
          break;
        }

        if (
          [
            'authentication',
            'authorization',
            'configuration',
            'operations_unavailable',
            'invalid_connection_state',
            'protocol_mismatch',
            'connection_refused',
            'conflict',
            'taken_over'
          ].includes(error.code)
        ) {
          break;
        }

        await delay(backoff);
        backoff = Math.min(backoff * 2, 10000);
      }
    }

    this.loopPromise = null;
  }

  async readConnection() {
    this.phase = 'open_websocket';

    const httpUrl = new URL(
      `${this.apiUrl}/agents/${encodeURIComponent(this.agentId)}/connection/ws`
    );

    httpUrl.protocol =
      httpUrl.protocol === 'https:' ? 'wss:' : 'ws:';

    const params = httpUrl.searchParams;

    params.set('connection_id', this.connectionId);
    params.set('scope', 'single');
    params.set('filter', 'all');
    params.set('rooms', this.roomId);
    params.set('protocol', '9');
    params.set('protocol_accepts', '1');
    params.set('client', 'matchpoint-switch-role-session');
    params.set('client_version', this.clientVersion);
    params.set(
      'start_at',
      Object.keys(this.position).length
        ? JSON.stringify(this.position)
        : 'head'
    );

    await new Promise((resolve, reject) => {
      const socket = new this.WebSocketImpl(httpUrl, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`
        }
      });

      this.socket = socket;
      // Respond to WebSocket-level ping control frames.
      socket.on('ping', () => {
        if (socket.readyState === this.WebSocketImpl.OPEN) {
          socket.pong();
        }
      });

      let initialized = false;
      let settled = false;
      let dispatch = Promise.resolve();

      const finishReady = (error, value) => {
        if (settled) return;

        settled = true;

        if (error) reject(error);
        else resolve(value);
      };

      const handle = async raw => {
        let frame;

        try {
          frame = JSON.parse(String(raw));
        } catch {
          throw new SwitchSessionError(
            'invalid_event',
            'Switch sent a non-JSON WebSocket frame.'
          );
        }

        if (
          !frame ||
          typeof frame.event !== 'string' ||
          !frame.data ||
          typeof frame.data !== 'object'
        ) {
          throw new SwitchSessionError(
            'invalid_event',
            'Switch sent a malformed WebSocket frame.'
          );
        }

        const data = frame.data;

        if (frame.event === 'connection_state') {
          if (
            initialized ||
            data.connection_id !== this.connectionId ||
            data.agent_id !== this.agentId ||
            !Array.isArray(data.rooms) ||
            !data.rooms.includes(this.roomId) ||
            !Number.isInteger(data.generation)
          ) {
            throw new SwitchSessionError(
              'invalid_connection_state',
              'Switch connection state did not match the requested role connection and room.'
            );
          }

          if (
            Number.isInteger(data.protocol) &&
            data.protocol < 9
          ) {
            throw new SwitchSessionError(
              'protocol_mismatch',
              'Switch does not support the required Agent Bridge protocol.'
            );
          }

          this.generation = data.generation;
          this.position = {
            ...(data.position || this.position)
          };

          this.cursor = Number.isInteger(data.cursor)
            ? data.cursor
            : this.cursor;

          this.phase = 'bind_room';

          const connectedRoom = await this.operation(
            'connect_to_room',
            { room_id: this.roomId }
          );

          if (this.stopped) {
            throw new SwitchSessionError(
              'stopped',
              `Switch ${this.agentName} session was stopped during room binding.`
            );
          }

          if (connectedRoom?.room_id !== this.roomId) {
            throw new SwitchSessionError(
              'room_mismatch',
              'Switch connected the role session to a different room.'
            );
          }

          this.participants = Array.isArray(
            connectedRoom.participants
          )
            ? connectedRoom.participants
            : [];

          initialized = true;
          this.phase = 'receive_events';

          this.setState('connected');

          if (!this.readySettled) {
            this.readySettled = true;

            this.readyResolve?.({
              connected: true,
              roomId: this.roomId,
              connectionId: this.connectionId
            });
          }

          return;
        }

        if (!initialized) {
          throw new SwitchSessionError(
            'invalid_event_order',
            'Switch sent an event before connection state.'
          );
        }

        if (Number.isInteger(frame.id)) {
          this.cursor = frame.id;
        }

        if (
          data.position &&
          typeof data.position === 'object'
        ) {
          this.position = {
            ...this.position,
            ...data.position
          };
        }

        if (frame.event === 'ping') {
        socket.send(
          JSON.stringify({
            type: 'pong',
            cursor: this.cursor
          })
        );

        return;
      }
        

        if (
          frame.event === 'evicted' ||
          frame.event === 'refused'
        ) {
          const code =
            frame.event === 'refused'
              ? ({
                  401: 'authentication',
                  403: 'authorization',
                  409: 'conflict'
                }[data.status] || 'connection_refused')
              : data.code || 'connection_closed';

          throw new SwitchSessionError(
            code,
            `Switch ${frame.event}: ${data.reason || data.detail || 'connection unavailable'}.`,
            data.status || 0
          );
        }

        if (frame.event !== 'keepalive') {
          await this.onEvent({
            event: frame.event,
            id: frame.id == null ? null : String(frame.id),
            data
          });
        }
      };

      socket.on('message', raw => {
        dispatch = dispatch
          .then(() => handle(raw))
          .catch(error => {
            if (!this.readySettled) {
              this.readySettled = true;
              this.readyReject?.(error);
            }

            finishReady(error);

            if (
              socket.readyState < this.WebSocketImpl.CLOSING
            ) {
              socket.close(1011, 'invalid Switch event');
            }
          });
      });

      socket.once('open', () => {});

      socket.once('error', error => {
        const sessionError = new SwitchSessionError(
          'unreachable',
          error?.message === 'Unexpected server response'
            ? 'Switch refused the WebSocket handshake.'
            : 'Could not open the Switch WebSocket.'
        );

        if (!this.readySettled) {
          this.readySettled = true;
          this.readyReject?.(sessionError);
        }

        finishReady(sessionError);
        reject(sessionError);
      });

      socket.once('close', (code, reason) => {
        if (this.socket === socket) {
          this.socket = null;
        }

        if (!this.stopped) {
          const text =
            reason?.toString() || `close code ${code}`;

          const error = new SwitchSessionError(
            code === 4001
              ? 'authentication'
              : 'stream_closed',
            `Switch WebSocket closed (${text}).`
          );

          if (!this.readySettled) {
            this.readySettled = true;
            this.readyReject?.(error);
          }

          finishReady(error);
          reject(error);
        } else {
          finishReady(null, true);
        }
      });
    });
  }

  async stop() {
    this.stopped = true;

    const startup = this.startPromise;

    // Do not leave callers waiting forever for initial readiness.
    if (!this.readySettled && this.readyReject) {
      this.readySettled = true;

      this.readyReject(
        new SwitchSessionError(
          'stopped',
          `Switch ${this.agentName} session was stopped during startup.`
        )
      );
    }

    const socket = this.socket;
    this.socket = null;

    if (
      socket &&
      socket.readyState < this.WebSocketImpl.CLOSING
    ) {
      socket.close(1000, 'client stopped');
    }

    if (startup) {
      await startup.catch(() => {});
    }

    if (this.loopPromise) {
      await this.loopPromise;
    }

    this.setState(
      'stopped',
      this.lastError?.message || null
    );
  }
}
