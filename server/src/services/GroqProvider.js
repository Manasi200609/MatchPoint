const DEFAULT_BASE_URL = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_MODEL = 'openai/gpt-oss-120b';

export class GroqError extends Error {
  constructor(code, message, status = 0) { super(message); this.name = 'GroqError'; this.code = code; this.status = status; }
}

export class GroqProvider {
  constructor({ apiKey, model = DEFAULT_MODEL, baseUrl = DEFAULT_BASE_URL, timeoutMs = 45000, fetchImpl = fetch } = {}) {
    this.apiKey = apiKey || '';
    this.model = model || DEFAULT_MODEL;
    this.baseUrl = baseUrl || DEFAULT_BASE_URL;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
  }

  get configured() { return Boolean(this.apiKey && this.model && this.baseUrl); }

  async complete({ system, user, responseFormat = 'json_object' }) {
    if (!this.configured) throw new GroqError('configuration', 'Groq requires GROQ_API_KEY.');
    let response;
    try {
      response = await this.fetch(this.baseUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ model: this.model, temperature: 0.1, response_format: { type: responseFormat }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      throw new GroqError(timedOut ? 'timeout' : 'unreachable', timedOut ? 'Groq request timed out.' : 'Could not connect to Groq.');
    }
    if (response.status === 401) throw new GroqError('authentication', 'Groq rejected the configured API key.', 401);
    if (response.status === 429) throw new GroqError('rate_limit', 'Groq rate limit reached.', 429);
    if (!response.ok) throw new GroqError('provider_error', `Groq returned an error (${response.status}).`, response.status);
    let payload;
    try { payload = await response.json(); } catch { throw new GroqError('invalid_response', 'Groq returned invalid JSON.'); }
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new GroqError('invalid_response', 'Groq response did not contain a message.');
    return content;
  }
}

export const groqDefaults = { baseUrl: DEFAULT_BASE_URL, model: DEFAULT_MODEL };
