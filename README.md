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

In mock mode, the same sequence executes with explicit `SIMULATED` labels. The roles derive their outputs from the actual case and deterministic reconciliation service; the UI never presents them as Switch messages.

## Switch integration

The live adapter uses Switch's documented Agent Bridge operations surface: `GET /agents/{agent_id}/ops` and `POST /agents/{agent_id}/ops/{operation}` with a bearer agent credential and `X-Switch-Connection-Id`. Operation arguments are sent as JSON and the response must use Switch's `{ "result": ... }` envelope. It calls `connect_to_room`, `list_participants`, `send_targeted_message` and `read_context`. The configured names are matched against `type: agent` room participants. Each task is addressed to one name; Switch's send-time `target_statuses` must report a reachable state, then MATCHPOINT polls `read_context` for a reply from that exact participant in the task's event thread. Reachability is not treated as completion. The three stages run sequentially, and AUDITOR receives RECON's validated output while RESOLVER receives both earlier outputs. A missing, malformed, unrelated, or invalid response leaves the run `incomplete`; live mode never falls back to simulated outputs.

Switch expects rooms and agents to be provisioned in Switch Console, with their runtimes connected. MATCHPOINT does not register agents, create a room, or start Codex sessions. The configured orchestrator agent must be a room member, its API key must be enabled for the Agent Bridge, and its connection ID must refer to a live connection for that agent. RECON, AUDITOR and RESOLVER must be registered Switch agents in the same room and have runtimes available to answer targeted messages. Agent names are exact Switch participant names.

Official references:

- [Switch Rooms quickstart](https://docs.switchagents.ai/switch-rooms/getting-started) explains server access, agent setup and rooms.
- [Switch Agent Bridge operations in source](https://github.com/sandbox-quantum/switch/blob/main/core/switch_core/bridges/agent/api/operations.py) documents the HTTP operations front door and authentication context.
- [Switch Agent Bridge authentication in source](https://github.com/sandbox-quantum/switch/blob/main/core/switch_core/bridges/agent/auth.py) documents Bearer agent API key authentication.
- [Switch room operations in source](https://github.com/sandbox-quantum/switch/blob/main/core/switch_core/bridges/agent/operations/definitions.py) documents `connect_to_room`, `send_targeted_message`, and `read_context`.
- The [Agent Bridge protocol](https://github.com/sandbox-quantum/switch/blob/main/docs/old/api/AGENT_PROTOCOL.md) labels itself partly out of date; current source is authoritative for transport changes. MATCHPOINT does not implement the agent event transport. A Switch Console/runtime connection must already be active and provide its current connection ID.

This workspace has no configured live Switch server or credentials. Therefore live calls are implemented against the published source contract but have not been verified against a running server. The adapter expects each agent to post its structured JSON answer as a reply in the same Switch thread; that behavior must be confirmed with the deployed agent runtimes. When live mode is selected without a working configuration, the run is recorded as incomplete with a connection/configuration error.

## Environment variables

Copy `.env.example` to `.env` in the project root. Mock mode works with the defaults and needs no network connection.

| Variable | Purpose |
| --- | --- |
| `SWITCH_MODE` | `mock` (default) or `live` |
| `SWITCH_API_URL` | Switch Agent Bridge API base URL (not the Gateway URL) |
| `SWITCH_AGENT_ID` | Registered MATCHPOINT orchestrator agent ID |
| `SWITCH_AGENT_API_KEY` | Agent API credential; keep it only in server `.env` |
| `SWITCH_CONNECTION_ID` | Active connection ID belonging to the configured orchestrator agent |
| `SWITCH_ROOM_ID` | Existing shared Switch room ID |
| `SWITCH_RECON_NAME` | Exact participant name for RECON |
| `SWITCH_AUDITOR_NAME` | Exact participant name for AUDITOR |
| `SWITCH_RESOLVER_NAME` | Exact participant name for RESOLVER |
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

- Live operation requires a provisioned Switch room, registered orchestrator credentials, a currently active orchestrator connection ID, and all three named agents available in that room. Those values are not configured in this project.
- Switch responses must be JSON matching the documented role contract. Invalid, absent or late responses stop the run as incomplete and preserve earlier stages.
- Mock agents are deterministic rule-based simulations, not LLM outputs or Switch activity.
- CASE-001 is synthetic demonstration data. No actual vendor documents or payment system are connected.
