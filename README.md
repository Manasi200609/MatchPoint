# MATCHPOINT

MATCHPOINT is a local-first accounts-payable exception investigation desk. The backend calculates financial values deterministically, orchestrates three distinct roles, keeps an auditable history, and prepares a decision for a human. MATCHPOINT never authorizes or executes payment.

## Architecture

```text
client/  React + Vite operations desk, investigation workspace and report
server/  Express API, business services, JSON repository and Switch adapters
```

The repository/service boundary keeps local JSON persistence replaceable. Each investigation is a separate run retained on the case record with stage outputs, mode, timestamps, collaboration events, errors and recommendation.

## Agent responsibilities and sequence

1. **RECON** inspects case data, evidence status and backend calculations, then reports the comparison and preliminary recommendation.
2. **AUDITOR** independently checks the source totals, challenges incorrect values or omitted evidence, and records verification status.
3. **RESOLVER** synthesizes the case and both prior outputs, explains disagreements, and prepares the next actions and vendor clarification.
4. A human reviews the result and records approval, rejection or further investigation with a reason. This business decision never releases or pays an invoice.

With `INVESTIGATION_ENGINE=rules` (the default), the same sequence executes with explicit `SIMULATED` labels and deterministic outputs. Set `INVESTIGATION_ENGINE=groq` to run the three role-specific Groq analyses sequentially while `SWITCH_MODE=mock` remains unchanged. `INVESTIGATION_ENGINE=switch` runs role-specific Groq analyses after each assigned task arrives on that role's authenticated Switch connection. Deterministic calculations and the human approval gate remain authoritative; Groq findings are retained alongside them. Groq requires `GROQ_API_KEY`, and a provider or validation failure leaves the run incomplete.

## Switch integration

The Switch collaboration engine opens one authenticated WebSocket for each role identity at `/agents/{agent_id}/connection/ws`, declares protocol 9, binds the configured room, answers Switch pings with pong frames, and resumes from the last event position after recoverable disconnects. Each role session uses its own credential and connection ID. Tasks and findings are JSON messages sent with `send_targeted_message` and `post_message`; MATCHPOINT correlates task ID, stage task ID, case ID, sender identity, and Switch thread ID. Registered agents do not start runtimes automatically: these three role runtimes are provided by the MATCHPOINT server, which runs the role's Groq reasoning only after Switch delivers its addressed task. A full investigation requires all three role connections to be live and the corresponding Switch operations to confirm task delivery.

Switch expects rooms and agents to be provisioned in Switch Console. MATCHPOINT does not register agents or create a room. RECON, AUDITOR and RESOLVER must be registered agents in the same room, and the role credentials must have Agent Bridge access. The role names used for targeted delivery must exactly match Switch participant names. `SWITCH_MODE=mock` remains the default; the `switch` investigation engine is opt-in and requires live role connections.

Official references:

- [Switch Rooms quickstart](https://docs.switchagents.ai/switch-rooms/getting-started) explains server access, agent setup and rooms.
- [Switch Agent Bridge operations in source](https://github.com/sandbox-quantum/switch/blob/main/core/switch_core/bridges/agent/api/operations.py) documents the HTTP operations front door and authentication context.
- [Switch Agent Bridge authentication in source](https://github.com/sandbox-quantum/switch/blob/main/core/switch_core/bridges/agent/auth.py) documents Bearer agent API key authentication.
- [Switch room operations in source](https://github.com/sandbox-quantum/switch/blob/main/core/switch_core/bridges/agent/operations/definitions.py) documents `connect_to_room`, `send_targeted_message`, and `read_context`.
- Switch v0.31.0 source implements WebSocket delivery at `/{agent_id}/connection/ws`; SSE is retained as a compatibility path. The running service's authenticated `/version` response reported version `0.31.0`, protocol `speaks: 9`, `accepts: 1`.

The Codespace root `.env` is the active configuration for workspace commands; this checkout has no `server/.env`. Existing per-agent credentials are present and preserved. Read-only requests confirmed the running service version and the configured RECON credential's operation-list access. Connection handling and message choreography are covered by local tests; no production case was dispatched, and this work did not verify an end-to-end Groq run against the live room. Keep mock mode until those runtime checks are performed.

## Environment variables

Copy `.env.example` to `.env` in the project root. Mock mode works with the defaults and needs no network connection.

| Variable | Purpose |
| --- | --- |
| `GROQ_API_KEY` | Server-only Groq credential |
| `GROQ_MODEL` | Configurable model (default: `openai/gpt-oss-120b`) |
| `GROQ_BASE_URL` | Optional chat completions endpoint |
| `GROQ_TIMEOUT_MS` | Maximum wait for a Groq completion |
| `INVESTIGATION_ENGINE` | `rules` (default), `groq`, or `switch`; `switch` runs the role analyses from each authenticated Switch-delivered task |
| `SWITCH_MODE` | `mock` (default) or `live` |
| `SWITCH_API_URL` | Switch Agent Bridge API base URL (not the Gateway URL) |
| `SWITCH_AGENT_ID` | Registered MATCHPOINT orchestrator agent ID |
| `SWITCH_AGENT_API_KEY` | Agent API credential; keep it only in server `.env` |
| `SWITCH_CONNECTION_ID` | Active connection ID belonging to the configured orchestrator agent |
| `SWITCH_ROOM_ID` | Existing shared Switch room ID |
| `SWITCH_RECON_NAME` | Exact participant name for RECON |
| `SWITCH_AUDITOR_NAME` | Exact participant name for AUDITOR |
| `SWITCH_RESOLVER_NAME` | Exact participant name for RESOLVER |
| `SWITCH_RECON_ID`, `SWITCH_RECON_API_KEY`, `SWITCH_RECON_CONNECTION_ID` | RECON identity, credential and unique persistent connection |
| `SWITCH_AUDITOR_ID`, `SWITCH_AUDITOR_API_KEY`, `SWITCH_AUDITOR_CONNECTION_ID` | AUDITOR identity, credential and unique persistent connection |
| `SWITCH_RESOLVER_ID`, `SWITCH_RESOLVER_API_KEY`, `SWITCH_RESOLVER_CONNECTION_ID` | RESOLVER identity, credential and unique persistent connection |
| `SWITCH_REQUEST_TIMEOUT_MS` | Timeout for a Switch operation request |
| `SWITCH_AGENT_TIMEOUT_MS` | Maximum wait for an agent reply |

Never put Switch credentials in `client/.env`, Vite variables, or browser code.

## Run on Windows (PowerShell)

```powershell
npm install
Copy-Item .env.example .env
npm run dev
```

Open http://localhost:5173. The API runs at http://localhost:4000. The default mode remains mock unless `SWITCH_MODE=live` is set in `.env`. Local data is stored in `server/data/matchpoint.json`.

Run tests with `npm test`; build the frontend with `npm run build`.

## Investigation API

- `POST /api/cases/:id/investigations` starts a new run and returns `202`.
- `GET /api/cases/:id/investigations` lists run history.
- `GET /api/cases/:id/investigations/:investigationId` retrieves a persisted run.
- `GET /api/health` reports mock/live connection state without exposing credentials.

## Known limitations

- Live operation requires a provisioned Switch room, registered orchestrator credentials, a currently active orchestrator connection ID, and all three named agents available in that room. Agent operation-list access was confirmed for all three role credentials, but their runtimes and a complete task/reply workflow are not verified.
- Switch responses must be JSON matching the documented role contract. Invalid, absent or late responses stop the run as incomplete and preserve earlier stages.
- With the default `rules` engine, mock agents are deterministic rule-based simulations, not LLM outputs or Switch activity. The opt-in `groq` engine calls Groq and records model analysis alongside deterministic policy checks.
- CASE-001 is synthetic demonstration data. No actual vendor documents or payment system are connected.
