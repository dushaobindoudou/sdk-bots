# sdk-bots

Headless multi-bot host: a local HTTP gateway, group-chat orchestration, and directory-scoped tools. **No Electron UI.** Models come from you (OpenRouter / local OpenAI-compatible / Claude Code / Codex).

npm package: **[`multibot-sdk`](https://www.npmjs.com/package/multibot-sdk)** (`sdk-bots` was already taken on the registry).

> **License / provenance:** derived from an unofficial reconstruction of a commercial product (Grok Bot / Cursor by Anysphere). Published as **UNLICENSED** (source-available for evaluation) — see [`NOTICE.md`](NOTICE.md) and [`LICENSE`](LICENSE). Not affiliated with Anysphere.

## Install

```bash
pnpm add multibot-sdk
# npm install multibot-sdk
```

Requires **Node >= 22** (`node:sqlite`). Native modules `tree-sitter` / `tree-sitter-bash` ship prebuilds for macOS arm64 and common Linux.

```ts
import { startHost, SdkBotsClient } from "multibot-sdk";

const host = await startHost();          // data at ~/.sdk-bots (never ~/.cursor)
const sdk = host.client;

const a1 = await sdk.createAgent({ name: "researcher", description: "research" });
const a2 = await sdk.createAgent({ name: "writer", description: "writes" });
const group = await sdk.createGroup({ name: "war room", memberIds: [a1.agent.id, a2.agent.id] });

await sdk.setHostSettings({ inferenceProvider: "openrouter" });
await sdk.sendPrompt({ agentId: group.agent.id, prompt: "@researcher pick a plan" });

const dispose = sdk.subscribe(ev => console.log(ev.channel, ev.payload));
```

Console (when the host is running): [http://127.0.0.1:7331/](http://127.0.0.1:7331/) if you set `SAND_HOST_PORT=7331`.

Demo:

```bash
NODE_OPTIONS="--use-system-ca" npm run example:group-chat
NODE_OPTIONS="--use-system-ca" npm run example:group-chat -- 帮我想一个周末徒步计划
```

See [`examples/README.md`](examples/README.md).

`startHost()` options: `{ dataDir?, port?, token?, startupTimeoutMs? }`. Discovery is `<dataDir>/gateway.json` (pid-stamped; stale files are ignored).

### Sandbox

There is a local **box exec-daemon** (loopback, default port `1337`). File tools map `/workspace` → `~/.sdk-bots/box-workspace`. Paths that escape that directory are rejected. That is the intended sandbox: **restrict to a directory**, not a VM.

`Shell` starts with `cwd` inside that folder. It is still a normal shell, so treat the host as a trusted local process and keep the gateway on loopback.

### Tools and third-party models

Turns use **this host's tool loop**, not a plug-in of some other agent runtime (LangGraph, CrewAI, …). You swap the **model**:

| `inferenceProvider` | transport | tools |
|---|---|---|
| `openrouter` | OpenAI-compatible `/chat/completions` (local freeroute or OpenRouter cloud) | `SendMessage`, `SendToAgent`, `Shell`, `Read`, `Write`, `Grep`, … |
| `claude-code` | Claude Agent SDK / CLI | Claude's tools + optional MCP |
| `codex` | Codex Responses API | Codex tool surface |
| mock (`SAND_AGENT_MOCK_RESPONSE`) | no network | scripted `SendMessage` / tool calls |

Set `localToolPermission: "always"` in host `settings.json` (or `setHostSettings`) so file/shell tools do not wait on a UI prompt. The user-visible reply is still `SendMessage`.

Group chat: `@name` addresses one member; omit `@` or use `@所有人` for everyone.

### Zero-credential mock

```ts
process.env.SAND_AGENT_MOCK_RESPONSE = "MOCK-REPLY: hello from the mock model";
```

Plain string, or `{"sendMessage": "..."}` / `{"toolCalls": [...]}` (see `parseSandMockScript`).

## Tests

```bash
npm run test:unit      # no host
npm run test:smoke     # boot + CRUD + SSE
npm run test:e2e       # mock group-chat loop
npm run test:integration # isolated host per case
```

Host-requiring scripts build the daemon/worker bundles first (`pre` hooks).

If a parent shell injects a `NODE_OPTIONS` preload, run tests with `NODE_OPTIONS="--use-system-ca"` so recursive `fs.rm` is not intercepted.

## Build

```bash
npm run build          # clean + daemon + workers + tsc (JS + public d.ts)
npm run typecheck
```

Generated (gitignored): `dist/box-exec-daemon/main.cjs`, `dist/host-workers/*.cjs` — built into the single `dist/` output; nothing generated lives inside `src/`.

## Environment

| var | purpose |
|---|---|
| `SAND_DATA_ROOT` | host data root (default `~/.sdk-bots`) |
| `SAND_GATEWAY_TOKEN` | gateway auth token |
| `SAND_HOST_PORT` | gateway port |
| `SAND_GATEWAY_BIND_HOST` | bind host (default `127.0.0.1`) |
| `SAND_OPENROUTER_BASE_URL` | default `http://127.0.0.1:3080/freeroute/v1` |
| `SAND_OPENROUTER_MODEL` | default `auto` locally |
| `OPENROUTER_API_KEY` | required only for official OpenRouter cloud |
| `SAND_AGENT_MOCK_RESPONSE` | mock inference script |
| `SAND_BOX_EXEC_DAEMON_ENTRY` | daemon bundle path |
| `SAND_USE_EXISTING_BOX_EXEC_DAEMON` | `1` = do not spawn the daemon |
| `SAND_BOX_EXEC_DAEMON_HOST` | host connects here (default `127.0.0.1`; non-loopback = remote box, no local spawn) |
| `SAND_BOX_EXEC_DAEMON_BIND_HOST` | daemon listen address (default loopback; `0.0.0.0` to accept remote clients) |
| `SAND_BOX_EXEC_DAEMON_PORT` | daemon port (default `1337`) |
| `SAND_BOX_EXEC_DAEMON_AUTH_TOKEN` | daemon bearer token (default `local`) |
| `SAND_LOCAL_EXEC_GATEWAY_URL` | standalone `multibot-host --local-exec-daemon` attach URL |
| `SAND_LOCAL_EXEC_ADVERTISE_HOST` | host written into the local-exec connection file (defaults to loopback when the gateway binds `0.0.0.0`) |

## Layout

- `src/sdk` — `SdkBotsClient` + `startHost()` (public entry)
- `src/bootstrap` — headless CLI bootstrap + shared host composition (`composition.ts`)
- `src/host` — gateway, group chat, inference (recovered runtime)
- `src/lib` — recovered library shelf (agent tools, `agent-exec`, chat-inference, …)
- `src/box-exec-daemon` — sandbox process for Shell/Read/Write (the remote computer **is** this box; bind/connect via `SAND_BOX_EXEC_DAEMON_*`)
- `src/host/local-exec` — in-process ExternalShell/ExternalRead provider backed by the same box daemon (also `multibot-host --local-exec-daemon` for a standalone SSE attach)
- `src/proto` — generated protobuf closures (`generated/` + `redacted/`; machine-owned, never hand-edit)
- `src/shared` — shared kernel: contracts (`host-extensions`), path policy (`sand-paths`), backend clients
- `test/unit` — no host; `test/integration` — isolated host per case

Strict layering: `sdk → bootstrap → host → {lib, proto, shared}`; `shared` never imports `host`.

CLI (host process): `npx multibot-host` after installing this package, or `npm start` in this repo.

## Status

Headless boot, 37 host extensions, gateway `/health` + `POST /api/*` + SSE, mock turns, and live OpenRouter/freeroute turns are exercised in-tree. See [`CHANGELOG.md`](CHANGELOG.md).

This is **not** MIT/Apache. Evaluate locally; do not assume you may ship it as a dependency in a commercial product until provenance is reviewed.
