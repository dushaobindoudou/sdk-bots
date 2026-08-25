# Integration suite

Each case runs in its **own process** with its **own isolated `dataDir`** (mkdtemp) so the
in-process host shuts down cleanly via SIGTERM — one in-process host per process is the
supported shape. The runner (`run.mjs`) executes cases sequentially and prints a pass/fail
matrix; a case fails if its process exits non-zero (each case self-reports via
`finish(tag, error?)`).

```bash
npm run test:integration            # full matrix (~2-4 min; builds daemon/worker bundles first)
npm run test:integration -- token   # run cases whose filename contains "token"
IT_CASE_TIMEOUT_MS=600000 npm run test:integration   # per-case timeout (default 240s)
```

## Matrix

| case | verifies |
|---|---|
| `01-lifecycle-crud` | boot, health, createAgent x2, listAgents growth, createGroup, setGroupMembers, updateAgent, empty transcript tail, deleteAgent x3, deletion visible in listAgents |
| `02-single-agent-turn` | full single-agent turn with the mock provider: sendPrompt → reply on the SSE transcript channel → persisted transcript tail contains the reply |
| `03-group-turn` | group turn: the mock reply's author id is one of the member agents, never the group container |
| `04-multi-turn-state` | 3 sequential turns serialize through the exclusive run queue; transcript accumulates ≥3 mock replies |
| `05-token-auth` | pinned gateway token: token-wired client works; raw fetch without/with wrong token is 401/403; tokenless client throws |
| `06-error-cases` | sendPrompt to nonexistent agent throws; createGroup without members rejected mentioning "member"; unknown method surfaces a gateway error |
| `07-restart-persistence` | two phases on a shared `IT_DATA_DIR`: phase 1 creates an agent + runs a turn and shuts down cleanly; phase 2 boots a fresh host on the same data — agent restored, pre-restart transcript intact, new turn executes |

## Conventions

- Mock inference: cases set `SAND_AGENT_MOCK_RESPONSE` (via `boot({ reply })`) with a
  case-unique marker; no provider credentials are needed anywhere in the suite.
- Markers like `IT02-MOCK-REPLY …` make assertions independent of surrounding prose.
- `helpers.mjs` owns the shared `boot` / `waitTranscript` / `finish` / assertion helpers —
  cases stay declarative.
- Case 07 is the only two-phase case; the runner passes `IT_PHASE=1|2` and a shared
  `IT_DATA_DIR`.
