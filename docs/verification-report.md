# Verification report

Current, reproducible verification of PortfolioPilot. Updated at milestone 35 (2026-10-04).
Historical per-milestone results remain in [project-state.md](project-state.md); this file states
how to verify the system **now** and what that does and does not prove.

## The three commands

Run from the repository root with Node 24.21.0 / npm 11.19.0 after `npm ci`.

| Command | What it runs | Needs | Builds first |
| --- | --- | --- | --- |
| `npm run test:unit` | Every workspace's Vitest suite except `*.integration.test.ts`, plus the local-proxy `node:test` suite | Nothing else: no database, Redis, browser or credentials | `npm run build:types` |
| `npm run test:integration` | All 17 PostgreSQL/Redis acceptance suites, real worker processes, mock agent | Docker, **or** `TEST_POSTGRES_URL` + `TEST_REDIS_URL` | `build:types` + worker |
| `npm run test:browser` | All 17 Playwright spec files in Chrome against two API replicas, two agent workers and an outbox worker behind one origin (phases `main`, `limits`, `observability`, `outages`) | Docker (or the two URLs above) and Google Chrome | `npm run build` |
| `npm run eval:mock` | The versioned AI evaluation dataset through the deterministic mock agent (lesson 32) | Nothing else | agent workspace |
| `npm run eval:live -- --budget-usd <n>` | The same dataset against live Claude, optionally `--judge`; **billed** | `ANTHROPIC_API_KEY`, `EVAL_MODEL_ID` or `AGENT_MODEL_ID`, an explicit budget | agent workspace |

Each command prints a summary table, lists every **skipped** test by name, and exits `0` (all
passed), `1` (a failure) or `2` (a prerequisite is missing, so nothing was verified). A suite that runs
zero tests is reported as a failure, not a pass.

Options: `TEST_SKIP_BUILD=true` (reuse existing build output; refused if it is missing),
`TEST_KEEP_INFRA=true` (leave containers for inspection), `TEST_INTEGRATION_CONCURRENCY` (default
3), `TEST_BROWSER_TRACE=true` (keep Playwright traces of failures),
`TEST_BROWSER_SKIP_OUTAGES=true`. Arguments filter by name, for example
`npm run test:integration -- approvals outbox` or `npm run test:browser -- fanout chat`.

### Isolation and determinism

- **Disposable infrastructure.** By default each integration or browser run starts its own
  `postgres:17.6-alpine` and `redis:7.4.5-alpine` containers (the compose images) on free loopback
  ports and removes them at the end. Shared development services (`portfolio-pilot-local`, earlier
  `*_verify` containers) are never touched. In CI, set `TEST_POSTGRES_URL` (a maintenance database
  whose role may create and drop databases) and `TEST_REDIS_URL` (a test-only Redis; logical
  databases 1–15 are flushed).
- **One fresh database per suite.** A template database is migrated once with
  `prisma migrate deploy`. Every integration suite file, and every browser phase, gets its own
  `CREATE DATABASE … TEMPLATE` copy and its own flushed Redis logical database. Suites refuse any
  database that is not loopback and named `pp_test_*` (or the lesson's legacy `*_verify` name), via
  `tests/support/disposable-database.ts`.
- **Clocks.** Domain/property tests use fixed timestamps and fixed seeds; the demo seed uses its
  fixture clock; provider mocks are clock-driven, and the browser harness sets a shared
  `MOCK_START_AT` so both API replicas serve the same mock schedule. The session-expiry browser
  test controls the browser clock (`page.clock`). PostgreSQL and Redis timing rules use the
  servers' own clocks (`clock_timestamp()`, Redis `TIME`), which matters on Docker Desktop for
  Windows, where the container clock was measured about 0.85 s ahead of the host.
- **Mock agent and provider fixtures.** `AGENT_MODE=mock` and `DATA_MODE=mock` everywhere; recorded
  SDK and Alpaca fixtures are used by unit suites. No credential, paid API or network service is
  needed. The suites remove credential-like variables (`ANTHROPIC_API_KEY`, `ALPACA_*`,
  `RUN_LIVE_*`, other `DATABASE_URL`s) from their child environment.

## Latest results (2026-10-03, Windows 11, Docker Desktop, Chrome)

| Check | Result |
| --- | --- |
| `npm run typecheck` | passed |
| `npm run check:browser-boundary` | passed |
| `npm run test:unit` | **369 passed, 0 failed, 4 skipped** (the four live tests below) |
| `npm run test:integration` | **129 passed, 0 failed, 0 skipped** across 17 suites, each on its own database |
| `npm run test:browser` | **30 passed, 0 failed, 0 skipped**: main 26, limits 1, observability 2, outages 1 |
| `npm run eval:mock` | **gates 7/7 cases**, mean quality score 0.907 (see lesson 32 for the per-check table) |
| `npm run eval:live` | **not run**: no `ANTHROPIC_API_KEY` in this environment, and spending needs authorization |
| Collector configs | `otelcol-contrib:0.161.0 validate` exit 0 for both files; a deliberately broken copy exits 1 |
| OTLP → Jaeger 2.21.0 | Two linked spans exported over OTLP/HTTP and read back from `/api/v3/traces/<id>` |

### Skipped by design: live tests (not verified)

| Test | Opt-in | Needs |
| --- | --- | --- |
| `packages/agent/test/live-session-artifacts.test.ts` › LIVE Claude | `RUN_LIVE_SDK_RESTART=true` | `ANTHROPIC_API_KEY`, `AGENT_MODEL_ID` |
| `packages/agent/test/live-session-artifacts.test.ts` › LIVE Azure Blob | `RUN_LIVE_BLOB_ARTIFACTS=true` | existing private container, `SESSION_BLOB_CONTAINER_URL`, `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_FEDERATED_TOKEN_FILE` |
| `packages/agent/test/research-comparison.live.test.ts` | `RUN_LIVE_RESEARCH_COMPARE=true` | Anthropic credentials (billed) |
| `packages/agent/test/skills.live.test.ts` | `RUN_LIVE_SKILLS_TEST=true` | Anthropic credentials (billed) |

Run one with, for example,
`RUN_LIVE_SDK_RESTART=true node node_modules/vitest/vitest.mjs run packages/agent/test/live-session-artifacts.test.ts -t "LIVE Claude"`
(lesson 28 has the PowerShell form). Live Alpaca market data and Microsoft Entra sign-in are also
unverified; they have no automated live test, only recorded-contract tests.

### Release images (milestone 33)

| Command | What it proves | Needs |
| --- | --- | --- |
| `npm run verify:containers` | Builds and starts `compose.production.yaml` under its own project, then runs eight checks: non-root / read-only / no-capability posture; read-only code with a writable SDK workspace; single origin (SPA fallback, caching, CSP, `/api` proxy, readiness); trade → outbox → Redis → SSE through nginx; question → agent worker → streamed answer → persisted message; a real Claude Code CLI turn against a local HTTP fixture in the API and worker images with `--network none`; production refusal of demo auth; SIGTERM drains every role to exit 0. Removes the stack afterwards | Docker, free port 8080 |
| `npm run inspect:images [-- --self-test]` | Every layer, the image config and the build history of all four images: no secrets (credential shapes and the literal values in local `.env` files or secret-named variables), `.env` files, transcripts, session artifacts, agent settings or source maps; browser assets free of server configuration. `--self-test` must detect seven planted violations | Docker, built images |

Results (2026-10-03, Windows 11, Docker Desktop 28.5.2, linux/amd64): `verify:containers` **8/8**,
`inspect:images` **PASS** (4 images), `--self-test` **7/7 detected**. linux/arm64 is not verified on this
machine (no emulation); `ci.yml` builds it natively. The workflows passed `actionlint` 1.7.12 but have not
run on GitHub (no remote repository here).

### Azure infrastructure (milestone 34)

| Command | What it proves | Needs |
| --- | --- | --- |
| `npm run validate:infra [-- --self-test] [-- --azure]` | `infra/azure` builds and lints with zero Bicep diagnostics (resource types and properties type-checked against the pinned API versions); the dev parameter file builds; every name meets its service's length and character rules; no secret literals in infra files, `docs/azure` or built parameters; template policy (no preview APIs except diagnostic settings, only verified built-in role GUIDs, private PostgreSQL/Redis/Storage, Entra-only Storage, RBAC Key Vault, AKS without local accounts, no secret outputs, no `list*()`). `--self-test` plants 10 violations. `--azure` adds read-only `az deployment sub validate` + `what-if`, only when signed in and no `REPLACE_` placeholders remain | Azure CLI with Bicep; `--azure` needs a usable sign-in |
| `npm run verify:postgres-roles` | On a disposable PostgreSQL 17.6 with a non-superuser admin (like Azure's): bootstrap SQL steps 2–3, Prisma migrations as `pp_migrator` authenticated through a client-side SCRAM verifier, runtime role DML-only (seeds; DDL, role creation and migration ledger denied), migrator password rotation | Docker |
| `packages/db/test/credential-rotation.integration.test.ts` (in `test:integration`) | Prisma's Entra mode asks for a password per new connection and uses the rotated value (stale value rejected); node-redis re-sends `AUTH` on the live connection (same client ID, `ACL LOG` shows the attempt) and reconnects with the newest token after the old one is revoked | Docker |

Results (2026-10-03): `validate:infra` **17 passed, 0 failed, 1 skipped** (Azure validate/what-if:
the CLI refresh token had expired, AADSTS700082; nobody signed in during this milestone);
`verify:postgres-roles` **14/14**; credential rotation suite **2/2**. Azure accepting the tokens,
the CSI driver, the `pgaadauth` step and the deployment itself are **not verified**.

### Kubernetes release (milestone 35)

| Command | What it proves | Needs |
| --- | --- | --- |
| `npm run validate:k8s [-- --self-test] [-- --release-env <file>]` | Every overlay renders (`aks`, `aks-migrate`, `local`, `local-migrate`, `local-data`). Pod policy: restricted security fields, non-root, read-only root, no token, requests and limits, probes, termination grace above each drain deadline, PDBs that cannot block a drain, no `replicas` on autoscaled Deployments. AKS releases: images by digest, no Kubernetes Secrets or `secretKeyRef`, no secret literals or leftover placeholders, the migration Job one-shot and release-named. Each pod mounts only Key Vault classes bound to its own identity. One HTTPS origin, with `/api/events` (timeout `0s`) ahead of the bounded `/api`. Every workload's rendered environment passes the app's own config schema. `--self-test` plants 15 violations; `--release-env` also refuses example values | `kubectl`; `@portfolio-pilot/config` built |
| `npm run test:k8s` | `release.env` generation from deployment outputs; example, secret, mutable-tag and shared-identity rejection | Nothing else |
| `npm run verify:k8s-local` | On kind (Kubernetes 1.35.8, 3 nodes) with Gateway API v1.4.1 and Istio 1.30.5: the real release function (dry run → migration Job awaited → app → rollouts → Gateway), Pod Security, posture, an 8-flow NetworkPolicy matrix, the public-origin smoke test with a 330 s idle SSE stream, an API rolling restart and a node drain under load, worker drains with an agent run in flight, and the AKS overlays server-side dry run ([local-verification.md](kubernetes/local-verification.md)) | Docker, `kubectl`, kind 0.33, istioctl 1.30.5, openssl, the `:local` images |

Results (2026-10-04):

- `validate:k8s --self-test`: **30/30** (self-test 15/15). `test:k8s`: **5/5**.
- **`verify:k8s-local`: 15/15**, from scratch; the cluster was then deleted.
  - Idle SSE stream held 330 s, with 20 heartbeats 15.6–15.9 s apart.
  - API rolling restart: 67 OK, 0 failed; the stream resumed on a new replica.
  - Node drain (evicting both API pods): 36 OK, 0 failed.
  - The agent run in flight completed during the worker rollout.

**Not verified:** anything on AKS. That covers the managed `approuting-istio` class, Cilium, the
Key Vault CSI driver with workload identity, Entra sign-in, the Azure Load Balancer and TLS from
Key Vault. Nothing is provisioned, and a release needs authorization
([release-runbook.md](kubernetes/release-runbook.md)).

### Not part of the three commands

`npm run verify:distributed` (milestone 30) remains a separate, slower script: it kills API and
worker processes and stops dedicated containers repeatedly while it checks invariants. The browser
command covers cross-replica fan-out, and its outage phase covers the user-visible Redis/PostgreSQL
outage behavior.

## Critical invariants and where they are checked

U = unit, I = integration (real PostgreSQL/Redis), B = browser (two API replicas).

| Invariant | Tests |
| --- | --- |
| Decimal domain arithmetic | U `packages/domain/src/valuation.test.ts` (reference amounts, rounding), **`valuation.property.test.ts`** (600 seeded ledgers against an independent exact-rational model), `portfolio-facts`, `exposure`, `largest-holding`; I `portfolio` (ten-place amounts); B `portfolio.spec`, `fanout.spec` |
| Chronological oversell | U `valuation.test.ts`, `ledger.test.ts`, property test (≈20% deliberately oversold ledgers must be rejected); I `portfolio` (backdated changes against later sales, equal-time order), `outbox` (oversell rolls back its event) |
| Idempotency | I `portfolio` (simultaneous retries, key reuse), `outbox` (crash between publish and ack), `alerts` (concurrent/repeated delivery), `approvals`; U `db/outbox-cache` (UUID dedupe); B `article-recommendation.spec` (redelivered article), `fanout.spec` (answer shown once) |
| Concurrent sales | I `portfolio` › serializes conflicting concurrent sales and archive races; bounded lock retries |
| Ownership | I `auth`, `portfolio`, `agent-tools`, `chat`, `research`, `alerts`, `approvals`; U `events`, `tools`, `sdk-registration`, `security`; B foreign-ID 404s in `fanout`, `chat`, `research`, `alerts`, `approvals`, `article-recommendation`, `portfolio` |
| Authentication expiry | I `auth` › rejects expired database sessions; U `events` › closes on revocation/expiry; B **`session-expiry.spec`** (server-expired session signs the browser out and clears account data; the user's other session keeps working) |
| Provider normalization | U `providers/alpaca` (decimal digits, ambiguous identities, null URLs, window pinning), `providers/mock`, `api/market-service`; B `providers.spec` |
| Outbox rollback and retry | I `outbox` (atomic commit/rollback, bounded backoff, dead events), `operations` (audited requeue); U `worker/outbox` (fenced acknowledgement) |
| SSE replay and reset | U `api/events`, `events/route`, `web/stream-manager`; I `events` (two hubs, once per UUID), `outbox` (retention, trimmed/expired/foreign-epoch reset); B `streaming.spec`, `alerts.spec` (offline recovery), `chat.spec` (reload) |
| Partial/final text reconciliation | U `agent/streaming`, `api/agent-run-events`, `web/agent-runs`; I `chat` (recorded SDK fixtures: partial+final, duplicate frames); B `chat.spec`, `fanout.spec` |
| Approval consumption | I `approvals` (double click/concurrent consume → one mutation, expiry, cancellation race), `agent-jobs` (idempotent, fenced); U `agent/approvals`; B `approvals.spec` |
| Worker fencing | I `agent-jobs` (stale completion/heartbeat cannot overwrite), `operations` (recovery fences the hung worker), `ingestion` (replica fencing); U `worker/outbox` |
| Credential rotation (Entra mode) | U `db/azure-credentials` (token exchange, cache, refresh schedule, expiry error, reconnect subscription); I `credential-rotation` (real PostgreSQL password and Redis ACL rotation under live clients); script `verify:postgres-roles` (migrator rotation) |
| Session artifact version conflicts | I `session-artifacts` (two workers racing, generation mismatch rolls back), `conversation-sessions` (compare-and-set); U `agent/session-artifacts` (simultaneous saves keep immutable versions) |

| AI evaluation checks can fail | U `packages/agent/test/eval.test.ts`: scripted adversarial agents trip injection, unsupported figure, unread citation, interpretation bounds, missing quote, privacy, stale-news and unreported-cost checks; the mock baseline passes every gate |
| Telemetry carries no user data | U `observability/telemetry.test.ts` (attribute/label allowlists, actor pseudonym, sanitizing exporter drops URLs/SQL/exception events from library spans, redacted logs), `prometheus.test.ts` (scraped labels allowlisted); B `observability.spec` (every exported attribute in both traces is exportable; no user ID, URL or query) |
| Trace continuity across durable hops | B **`observability.spec`**: article ingestion → fan-out → owner delivery → `sse.send` → event received by the page; API request → queued job → `agent.run` → `agent.tool` → `agent.message.persist` → outbox → `sse.send` → final message rendered; exact parent/child IDs across four processes |

### End-to-end scenarios (browser)

| Scenario | Spec |
| --- | --- |
| Portfolio creation and valuation | `portfolio.spec` (reference trades → exact holdings/valuation, liquidation, archive), `fanout.spec` (trade on replica 1 updates holdings viewed through replica 0) |
| New article → recommendation | **`article-recommendation.spec`**: ingestion CLI → running outbox worker → mock analysis → owner recommendation and alert, live over SSE; redelivery changes nothing; Bob gets nothing; `alerts.spec`, `research.spec` |
| Follow-up chat | `chat.spec` › follow-up continues the same assistant session |
| Explicit cancellation | `chat.spec` › Cancel answer; `approvals.spec`; `durable-workers.spec`; `budgets.spec` |
| Disconnect / reconnect | `chat.spec` › reload mid-answer; `alerts.spec` (offline, then recovery); `streaming.spec`; `durable-workers.spec`; `distributed-recovery.spec` (Redis/PostgreSQL outages) |
| Two-user isolation | `fanout.spec`, `portfolio.spec`, `news-live.spec`, `alerts.spec`, `research.spec`, `approvals.spec`, `article-recommendation.spec` |
| Two-API fan-out | **`fanout.spec`**: sessions are pinned to replica 0 or 1 (verified from the proxy's `x-pp-upstream` header); a portfolio and a trade accepted by one replica reach the owner's page on the other live; an answer requested through replica 0 streams to the conversation open on replica 1 exactly once; Bob, on either replica, receives nothing |

## Known limitations of this verification

- Single Windows host. Milestone 33 added `.github/workflows/ci.yml`, but it has not run yet: this
  workspace is not a Git repository and has no GitHub remote.
- Browser specs run sequentially (one Playwright worker) because they share the demo users' limits
  and state; the suite takes several minutes.
- During development of this milestone, one `outbox` integration run (out of 12) failed 5/9 tests
  and took 161 s. The output was not kept and it was not reproduced in 10 further runs. The other
  intermittent failure is understood and fixed (see lesson 31). Watch for recurrence.
- Live Claude, Azure Blob, Alpaca and Entra remain unverified (see the table above), and so do the
  live evaluation and the judge rubric (`npm run eval:live`) and export to a real Azure Monitor resource.
- Milestone 32: `chat.spec` › reloading mid-answer asserted `running` immediately after reload and
  failed in 2 of 4 runs with `queued` (a worker had not yet polled). It now asserts the actual
  invariant (not cancelled; `queued` or `running`; later `completed`). It passed 4/4 and in the final
  full run. Tracing overhead changing the timing was not ruled out.
