# Contributing

Thanks for looking. This repo is a headless multi-bot host: a local HTTP gateway, group-chat orchestration, and a directory-scoped tool sandbox.

## Setup

Requires **Node.js 22+** and **npm** (the repo lockfile is `package-lock.json`).

```bash
npm install
npm run test:unit
```

Do not run `npm run test:integration` or live-model examples unless you mean to. Those boot a host and may call third-party inference.

## How to work

- Keep changes small and related. Sandbox path checks live in `src/box-exec-daemon/`; do not broaden them without a test.
- Public API is `src/sdk/entry.ts` (`startHost`, `SdkBotsClient`). Gateway methods live in `src/host/host-gateway-api.ts`.
- Tests: `test/unit/*.test.ts` (no host), `test/smoke.mjs` / `test/integration/` (host).
- Do not commit `dist/`, generated daemon/worker bundles, `.env`, or credentials.

## Pull requests

Open a PR against `main` with:

1. What changed and why
2. How you tested it (`npm run test:unit` at minimum; `npm run typecheck` and `npm run build` must stay green)

## License

See `LICENSE` and `NOTICE.md`. Contributions are accepted under the same source-available terms.
