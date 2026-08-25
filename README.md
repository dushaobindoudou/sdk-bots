# sdk-bots

Headless multi-bot orchestration SDK, extracted from the Grok Bot 0.18 reverse-engineering reconstruction. **No Electron UI** — just the local gateway + multi-agent group-chat orchestration core, with third-party inference providers (Claude Code / Codex / OpenRouter).

> **License / provenance:** this code derives from an unofficial reverse-engineered reconstruction
> of a commercial product (Grok Bot / Cursor by Anysphere). It is published as **UNLICENSED**
> (all rights reserved) pending a formal legal review — see [`NOTICE.md`](NOTICE.md).
> Treat it as source-available for evaluation, not open-source-licensed software.

## What you get

- `source/host` — pure-Node `node:http` gateway (JSON-RPC `POST /api/<method>` + SSE `GET /events` + `/health`)
- `source/node-agent-coordinator` — inference router, transcript routing, MCP bridge
- `source/shared`, `source/packages`, `source/internal` — protocol / inference / execution libs
- `src/host` — headless bootstrap (replaces electron-main)
- `src/sdk` — `SdkBotsClient` + `startHost()` programmatic API
- Bundled runtime artifacts (built by `npm run build`): loopback box exec-daemon + 4 `worker_threads` bundles

Zero `import "electron"` in the core (verified).

## Install

```bash
npm install sdk-bots
```

Requires **Node >= 22** (uses `node:sqlite`). Two native modules (`tree-sitter`, `tree-sitter-bash`)
are installed from npm — prebuilt binaries cover macOS/arm64 and common Linux; from source otherwise.

```ts
import { startHost, SdkBotsClient } from "sdk-bots";

const host = await startHost();          // data at ~/.sdk-bots (never ~/.cursor)
const sdk = host.client;                 // pre-wired SdkBotsClient
// or connect to an already-running host:
// const sdk = new SdkBotsClient({ baseUrl: "http://127.0.0.1:7331", token });

const a1 = await sdk.createAgent({ name: "researcher", description: "research" });
const a2 = await sdk.createAgent({ name: "writer", description: "writes" });
const group = await sdk.createGroup({ name: "war room", memberIds: [a1.agent.id, a2.agent.id] });

// sendPrompt needs a configured third-party provider (set inferenceProvider in host settings),
// or the mock provider for tests (SAND_AGENT_MOCK_RESPONSE, see below)
await sdk.sendPrompt({ agentId: group.agent.id, prompt: "discuss the topic" });

// stream events (SSE): transcript updates, agent lifecycle, outline, ...
const dispose = sdk.subscribe(ev => console.log(ev.channel, ev.payload));
```

`startHost()` options: `{ dataDir?, port?, token?, startupTimeoutMs? }` — resolves once the
gateway is listening (the host reports its actual port/token via `<dataDir>/gateway.json`,
atomically written and pid-stamped; stale discovery files are rejected).

### Zero-credential testing with the mock provider

Set `SAND_AGENT_MOCK_RESPONSE` before `startHost()` to run full turn loops with no
provider credentials — ideal for CI and integration tests:

```ts
process.env.SAND_AGENT_MOCK_RESPONSE = "MOCK-REPLY: hello from the mock model";
```

Accepts a plain string (assistant reply), or `{"sendMessage": "..."}` / `{"toolCalls": [...]}`
script shapes (see `parseSandMockScript`).

## Tests

```bash
npm run test:unit        # 40 unit tests (no host needed): client transport, header wiring,
                         #   gateway parameter mapping (memberIds -> memberAgentIds),
                         #   SSE parsing incl. cross-chunk framing, discovery polling,
                         #   inference-router transcript store, Codex direct Responses
                         #   transport, routed MCP JSON -> protobuf Struct
npm run test:smoke       # e2e smoke: boot + health + createAgent x2 + createGroup
                         #   + setGroupMembers + updateAgent + deleteAgent x3 + SSE
npm run test:e2e         # credential-free group-chat loop with the mock inference provider
npm run test:integration # full integration matrix (each case isolated: own process + dataDir)
```

- Unit tests live in `test/unit/*.test.ts`, run with `node --import tsx --test` (no framework dependency).
- `SdkBotsClient` tests inject a fake `fetch`, so they never touch the network or disk state.
- `entry.test.ts` covers `waitForDiscovery` (stale-pid rejection, port validation, late-write polling, timeout).
- `inference-router-transcript` / `codex-direct-responses` / `backend-mcp-exec-json` are migrated
  from the original project's recovery tests. The fourth recovery test (`router-settings`) targets
  the desktop frontend's router overlay, which is out of scope for this headless SDK.
- Integration cases live in `test/integration/` — see that directory's README for the matrix.
  Host-requiring scripts auto-build the daemon/worker bundles first (npm `pre` hooks).

> If your environment injects a `NODE_OPTIONS` preload (e.g. sandboxed agent shells), run tests with
> `NODE_OPTIONS="--use-system-ca" npm test` so recursive `fs.rm` in agent cleanup is not intercepted.

## Build artifacts

```bash
npm run build         # bundles box-exec-daemon + 4 host workers, tsc-emits dist/, copies assets
npm run typecheck     # full-tree tsc (known pre-existing errors in generated proto code)
```

- `src/host-workers/*.cjs` — `agent-store-worker`, `transcript-mirror-worker`,
  `search-index-worker`, `box-store-vacuum-worker`: standalone CJS bundles loaded via
  `worker_threads`. The original resolvers assumed a single-bundle dist layout; the shared
  resolver in `source/host/worker-entry.ts` probes `src/host-workers/`, `dist/host-workers/`
  and the packaged layout automatically.
- `src/box-exec-daemon/main.cjs` — loopback box exec-daemon (shell/file tool sandbox).
  `startHost()` points the host at it when present; packaged copies land in
  `dist/box-exec-daemon/`.

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
| `SAND_AGENT_MOCK_RESPONSE` | mock inference script for credential-free turn execution |
| `SAND_BOX_EXEC_DAEMON_ENTRY` | override path for the loopbox box exec-daemon bundle |
| `SAND_USE_EXISTING_BOX_EXEC_DAEMON` | `1` = skip spawning the daemon (shell/file tools degraded) |

## Status

Tested end-to-end (2026-08): headless boot, all 37 host extensions start in graph order,
gateway serves `/health`, `POST /api/*` (createAgent / createGroup / setGroupMembers /
updateAgent / deleteAgent / listAgents / countAgents), SSE `GET /events` delivers live
events, and **full turn execution works credential-free** with the mock provider — including
multi-turn state persistence across a host restart and token-authenticated access (covered
by the integration suite).

Notes:
- Real-provider `sendPrompt` requires a configured credential (see table above).
- State lives under the SDK data root: `~/.sdk-bots` by default, or the `dataDir` you pass to
  `startHost()` / `SAND_DATA_ROOT` (agents, transcripts, gateway discovery at
  `<dataDir>/gateway.json`). The SDK never writes to `~/.cursor`.
