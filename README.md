# sdk-bots

Headless multi-bot orchestration SDK, extracted from the Grok Bot 0.18 reverse-engineering reconstruction. **No Electron UI** — just the local gateway + multi-agent group-chat orchestration core, with third-party inference providers (Claude Code / Codex / OpenRouter).

> **License / redistribution:** this code derives from an unofficial reverse-engineered reconstruction of a commercial product (Grok Bot / Cursor by Anysphere) and **carries no upstream source license**. The original `NOTICE.md` and `PROVENANCE.md` require an independent copyright / trademark / third-party / service-terms review **before any public redistribution**. Do not publish publicly without completing that review.

## What you get

- `source/host` — pure-Node `node:http` gateway (JSON-RPC `POST /api/<method>` + SSE `GET /events` + `/health`)
- `source/node-agent-coordinator` — inference router, transcript routing, MCP bridge
- `source/shared`, `source/packages`, `source/internal` — protocol / inference / execution libs
- `src/host` — headless bootstrap (replaces electron-main)
- `src/sdk` — `SdkBotsClient` + `startHost()` programmatic API

Zero `import "electron"` in the core (verified).

## Quick start

```bash
npm install
npm run dev            # start headless host (tsx)
npm test               # full suite: unit tests + smoke
```

> If your environment injects a `NODE_OPTIONS` preload (e.g. sandboxed agent shells), run tests with
> `NODE_OPTIONS="--use-system-ca" npm test` so recursive `fs.rm` in agent cleanup is not intercepted.

## Tests

```bash
npm run test:unit     # 33 unit tests (no host needed): client transport, header wiring,
                      #   gateway parameter mapping (memberIds -> memberAgentIds),
                      #   SSE parsing incl. cross-chunk framing, discovery polling
npm run test:smoke    # e2e smoke: boot + health + createAgent x2 + createGroup
                      #   + setGroupMembers + updateAgent + deleteAgent x3 + SSE
npm run test:e2e      # credential-free group-chat loop with the mock inference provider
```

- Unit tests live in `test/unit/*.test.ts`, run with `node --import tsx --test` (no framework dependency).
- `SdkBotsClient` tests inject a fake `fetch`, so they never touch the network or disk state.
- `entry.test.ts` covers `waitForDiscovery` (stale-pid rejection, port validation, late-write polling, timeout).

## SDK usage

```ts
import { startHost, SdkBotsClient } from "sdk-bots";

const host = await startHost();          // data at ~/.sdk-bots (never ~/.cursor)
const sdk = host.client;                 // pre-wired SdkBotsClient
// or connect to an already-running host:
// const sdk = new SdkBotsClient({ baseUrl: "http://127.0.0.1:7331", token });

const a1 = await sdk.createAgent({ name: "researcher", description: "research" });
const a2 = await sdk.createAgent({ name: "writer", description: "writes" });
const group = await sdk.createGroup({ name: "war room", memberIds: [a1.agent.id, a2.agent.id] });

// sendPrompt needs a configured third-party provider (set inferenceProvider in host settings)
await sdk.sendPrompt({ agentId: group.id, prompt: "discuss the topic" });

// stream events
const dispose = sdk.subscribe(ev => console.log(ev.channel, ev.payload));
```

`startHost()` options: `{ dataDir?, port?, token?, startupTimeoutMs? }` - resolves once the
gateway is listening (the host reports its actual port/token via `<dataDir>/gateway.json`).

## Inference providers (third-party, your credentials)

Configured via host settings `inferenceProvider`:

| provider | how | auth |
|---|---|---|
| `claude-code` | `@anthropic-ai/claude-agent-sdk` (CLI) | Claude login or `ANTHROPIC_API_KEY` |
| `codex` | HTTP → `chatgpt.com/backend-api/codex/responses` | `~/.codex/auth.json` |
| `openrouter` | `@ai-sdk/openai` → `openrouter.ai/api/v1` | `OPENROUTER_API_KEY` env or box-secrets |

Only the default `cursor` provider depends on a Cursor account — not used in headless mode.

## Environment

| var | purpose |
|---|---|
| `SAND_DATA_ROOT` | host data root (default `~/.sdk-bots`; isolated from any Cursor install) |
| `SAND_GATEWAY_TOKEN` | gateway auth token |
| `SAND_HOST_PORT` | gateway port (default: host picks a free port, reports it in `gateway.json`) |
| `SAND_GATEWAY_BIND_HOST` | bind host (default 127.0.0.1) |

## Status

Smoke-tested end-to-end (2026-08): headless boot, all 35 host extensions start in graph order, gateway serves `/health`, `POST /api/*` (createAgent / createGroup / setGroupMembers / updateAgent / deleteAgent / listAgents / countAgents), and the SSE event stream (`GET /events`) delivers live events.

Notes:
- `sendPrompt` end-to-end requires a configured provider credential (see table above).
- The box exec-daemon bundle (`src/box-exec-daemon/main.cjs`) is not shipped in source form; `startHost()` sets `SAND_USE_EXISTING_BOX_EXEC_DAEMON=1` so the host starts without it (local shell-exec tooling is degraded; agents / groups / transcripts unaffected).
- State lives under the SDK data root: `~/.sdk-bots` by default, or the `dataDir` you pass to `startHost()` / `SAND_DATA_ROOT` (agents, transcripts, gateway discovery at `<dataDir>/gateway.json`). The SDK never writes to `~/.cursor`.
