# Changelog

## 0.3.0

Architecture pass over the recovered runtime; breaking for anyone importing internals.

- Pruned code with **zero importers** from the headless entries (`sdk` / `bootstrap` / `host`), tests, or computed loaders — not “junk in the original desktop product”:
  - `node-agent-coordinator` (24 files): Electron coordinator process with its own `main.ts`; never a package `bin` / export. The still-used `shared/rpc/coordinator.ts` is only transcript-window types for the gateway.
  - 192-file island prune: desktop `packages/local-exec` + `packages/shell-exec` (seatbelt/bash islands), unused self-summary/compaction handlers, unused `agent-store-sync` internals, desktop shared strays (window-chrome, VNC, deep-link, …). Headless `host/local-exec` is restored: the box exec-daemon is the user computer (in-process provider + optional `--local-exec-daemon`), including a remote box via `SAND_BOX_EXEC_DAEMON_HOST`.
  - Live Shell/Read/Write and ExternalShell/ExternalRead go through `box-exec-daemon` + `lib/agent-exec`. The local-exec **bridge** (`host/extensions/local-exec`) registers the box as the live computer when the host starts.
- Strict layering restored: `sdk → bootstrap → host → {lib, proto, shared}`; the `shared → host` reverse edges are gone (`host-paths` sank into `shared/sand-paths`, provider-routing glue moved into the host inference extension)
- `internal/` (2 contract files, 118 imports) merged into `shared/` — one honest base layer
- Generated protobuf closures split out to `src/proto/` (`generated/` + `redacted/`) — machine-owned code is no longer shelved beside authored libraries
- `packages/` renamed to `lib/` (it is the recovered library shelf, not a package collection)
- New `multibot-host` bin (the headless CLI entry)

## 0.2.0

Project restructure; layout changes are breaking for anyone importing internals.

- Single `src/` tree (was `source/` + `src/`): `src/sdk` (public client), `src/bootstrap` (CLI + shared headless composition), `src/host` / `src/packages` / `src/shared` / … (recovered host runtime)
- Both entrypoints (`startHost()` and the CLI) now boot through one shared composition root (`src/bootstrap/composition.ts`)
- Generated artifacts (worker/daemon bundles) live only under `dist/`; nothing generated inside `src/`; builds start from a cleaned `dist/`
- Build: two-phase `tsc` — JS for the whole runtime, declarations for the public SDK surface only; TypeScript pinned to 5.9
- `typecheck` is now full-strict (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) and green; fixed the latent sync-call/async `image-type` MIME bug it surfaced
- Removed the unused `./host` package export; the CLI ships as `dist/bootstrap/index.js` (`npm start`)
- CI: npm-based, gates `typecheck` + `build` + `test:unit`

## 0.1.1

- Local OpenAI-compatible inference (default `http://127.0.0.1:3080/freeroute/v1`, model `auto`)
- Group chat roster `isGroup` / `memberIds`, `@mention` routing, local console
- Directory-scoped box exec-daemon for Shell/Read/Write
- Sandbox tool schemas passed through to third-party chat models
- SDK client `listAgents` shape, shutdown/exit test fixes

## 0.1.0

- Headless host, gateway, mock-provider turns, unit + integration tests
