# Contributing

Thanks for looking. This repo is a headless multi-bot host: a local HTTP gateway, group-chat orchestration, and a directory-scoped tool sandbox.

## Setup

Requires **Node.js 22+** and **pnpm**.

```bash
pnpm install
pnpm test:unit
```

Do not run `pnpm test:integration` or live-model examples unless you mean to. Those boot a host and may call third-party inference.

## How to work

- Keep changes small and related. Sandbox path checks live in `source/box-exec-daemon/`; do not broaden them without a test.
- Public API is `src/sdk/entry.ts` (`startHost`, `SdkBotsClient`). Gateway methods live in `source/host/host-gateway-api.ts`.
- Tests: `test/unit/*.test.ts` (no host), `test/smoke.mjs` / `test/integration/` (host).
- Do not commit `dist/`, generated daemon/worker bundles, `.env`, or credentials.

## Pull requests

Open a PR against `main` with:

1. What changed and why
2. How you tested it (`pnpm test:unit` at minimum)

## License

See `LICENSE` and `NOTICE.md`. Contributions are accepted under the same source-available terms.
