# Identities, roles and credentials (milestone 34)

Decision record: [ADR 0026](../decisions/0026-azure-infrastructure-and-credentials.md).

## Workload identities

The template creates one user-assigned managed identity per workload. AKS workload identity
federates each one with exactly one Kubernetes service account in namespace `portfolio-pilot`:

- Issuer: the cluster OIDC issuer.
- Subject: `system:serviceaccount:portfolio-pilot:<sa>`.
- Audience: `api://AzureADTokenExchange`.

Milestone 35 creates these service accounts with the `azure.workload.identity/client-id`
annotation and labels the pods `azure.workload.identity/use: "true"`
([deploy/kubernetes](../../deploy/kubernetes/), [ADR 0027](../decisions/0027-kubernetes-gateway-and-release.md)).

| Identity | Service account | PostgreSQL | Redis | Blob | Key Vault secrets (per-secret `Key Vault Secrets User`) | Other |
| --- | --- | --- | --- | --- | --- | --- |
| `id-pp-dev-api` | `pp-api` | Entra role, member of `pp_runtime` (DML) | Entra user | — | `auth-secret`, `entra-client-secret`, `observability-actor-key`, `anthropic-api-key` (milestone 35) | — |
| `id-pp-dev-ingestion` | `pp-ingestion` | same | same | — | `alpaca-api-key`, `alpaca-api-secret`, `observability-actor-key` | — |
| `id-pp-dev-outbox` | `pp-outbox` | same | same | — | `observability-actor-key`, `anthropic-api-key` (milestone 35) | — |
| `id-pp-dev-agent` | `pp-agent` | same | same | `Storage Blob Data Contributor` on container `session-artifacts` only | `anthropic-api-key`, `observability-actor-key` | — |
| `id-pp-dev-migrate` | `pp-migrate` | password role `pp_migrator` (owner) | — | — | `database-migrator-url` | — |
| `id-pp-dev-otel` | `pp-otel-collector` | — | — | — | `appinsights-connection-string` | `Monitoring Metrics Publisher` on Application Insights |
| `id-pp-dev-tls` (milestone 35) | `pp-tls-sync` | — | — | — | `gateway-tls-crt`, `gateway-tls-key` | — |

**Milestone 35 corrections.**

- The shared article analysis (ADR 0014) is a model call made by the API (on demand) and by the outbox
  dispatcher (on delivery), not only by the agent worker. With `AGENT_MODE=claude`, those two
  identities need `anthropic-api-key` too.
- The SecretProviderClasses mount it for all three, so the Key Vault secret must exist even in mock
  mode (a placeholder value is fine there).
- `id-pp-dev-tls` is new. It reads only the gateway certificate, so the add-on's shared node identity
  never needs Key Vault access.

Other principals:

| Principal | Role | Scope |
| --- | --- | --- |
| AKS control-plane identity (`id-pp-dev-aks-control-plane`) | Network Contributor | AKS subnet only (to join it) |
| AKS kubelet identity (created by AKS) | AcrPull | the registry |
| Operator Entra group | AKS Cluster User + AKS RBAC Cluster Admin; Key Vault Secrets Officer; PostgreSQL Entra administrator | cluster; vault; server |
| `id-pp-dev-gh-registry` (GitHub environment `release-registry`) | AcrPush | the registry |
| `id-pp-dev-gh-deploy` (GitHub environment `production`) | AKS Cluster User (Bicep) + AKS RBAC Writer (namespace `portfolio-pilot`, provisioning command) | cluster / namespace |

All role definition IDs were checked against Microsoft's built-in role JSON on 2026-10-03.
`npm run validate:infra` fails on any GUID outside that verified set. The production config change
in this milestone means worker roles no longer need the session or OIDC client secret
(`WORKER_ROLE` set ⇒ only `DATABASE_URL` and the shared `OBSERVABILITY_ACTOR_KEY`).

## How each client gets and refreshes credentials

### PostgreSQL (Prisma through `@prisma/adapter-pg`)

- **Runtime (`DATABASE_AUTH=azure-workload-identity`).**
  - `DATABASE_URL` carries no password:
    `postgresql://id-pp-dev-api@<server>.postgres.database.azure.com:5432/portfolio_pilot?sslmode=verify-full`.
    The user is the managed identity name, created by `sql/01-entra-principals.sql`.
  - node-postgres calls the password callback for **every new physical connection**. The callback
    returns an Entra token for `https://ossrdbms-aad.database.windows.net/.default`, which comes
    from exchanging the projected service-account token at `login.microsoftonline.com`.
  - Tokens are cached until five minutes before expiry, with one exchange in flight at a time.
    The kubelet-rotated assertion file is re-read on each exchange.
  - Azure checks the token only at sign-in, so established connections keep working after it
    expires. Pool churn picks up new tokens without a restart.
  - Implementation: [packages/db/src/azure-credentials.ts](../../packages/db/src/azure-credentials.ts).
    pg's connection-string parser turns a missing password into `''`, which would override the
    callback, so Entra mode passes discrete host, port, user and database fields.
  - TLS `verify-full` is mandatory; `sslmode=disable` is accepted only for loopback test servers.
- **Migrations (`pp_migrator`).**
  - The Prisma schema engine needs a URL with a password, so the migration role uses a password
    stored as the Key Vault secret `database-migrator-url`, read through the CSI driver by the
    migration Job (milestone 35).
  - The password reaches PostgreSQL only as a SCRAM-SHA-256 verifier computed on the operator's
    machine ([scram-verifier.mjs](../../infra/azure/scripts/scram-verifier.mjs)).
  - **Rotation:** generate a new password, re-run step 2 with the new verifier (the old password
    stops working immediately), then `az keyvault secret set` the new URL. The next Job run reads
    the new version.
- **Local admin (`ppbreakglass`).**
  - Its password is a secure deployment parameter, generated per deployment and never stored.
  - It is used once, for bootstrap steps 2 and 3. Break-glass access goes through the operator
    Entra group (token via `az account get-access-token --resource-type oss-rdbms`). An Owner can
    also reset the local password through ARM if needed.

### Redis (node-redis 5.10 against Azure Managed Redis)

- **Runtime (`REDIS_AUTH=azure-workload-identity`).**
  - `REDIS_URL=rediss://<cache>.<region>.redis.azure.net:10000` contains no credentials.
  - The user name is the identity's object (principal) ID (`REDIS_ENTRA_OBJECT_ID`); the password
    is an Entra token for `https://redis.azure.com/.default`
    ([Azure Managed Redis Entra docs](https://learn.microsoft.com/azure/redis/entra-for-authentication)).
- **Refresh.**
  - Azure requires a fresh `AUTH` before the token expires (at least three minutes early) or it
    disconnects the client.
  - The app supplies node-redis's `streaming-credentials-provider`. It fetches a new token five
    minutes before expiry plus up to one minute of jitter, and node-redis sends `AUTH` on the live
    connection. Failures are retried every 10 seconds until expiry, then reported.
  - Reconnect handshakes always use the newest token. Only the newest subscription stays active
    across reconnects.
- **Compatibility.**
  - Clustering policy `EnterpriseCluster` exposes a single proxy endpoint, so the existing
    non-cluster client works.
  - Every application command touches one key (single-key `MULTI`, `EVAL`, `DEL`, `XADD`/`XRANGE`).
    No `BLOCK` reads or pub/sub are used, so re-authentication is never deferred.
- Access keys are disabled (`accessKeysAuthentication: Disabled`).

### Blob Storage

Unchanged from milestone 28 and already tested with fixtures:

- The agent worker exchanges its federated token for `https://storage.azure.com/.default`.
- The token is cached until 60 seconds before expiry.
- Shared keys are disabled on the account.

### Provider secrets (Key Vault)

- Pods read secrets through the AKS Secrets Store CSI driver, authenticated with their own workload
  identity (`clientID` in each `SecretProviderClass`, milestone 35; `npm run validate:k8s` checks that
  every pod mounts only classes bound to its own identity).
- Milestone 35 mounts them as **files**: the `objectAlias` is the environment variable name. The
  container command exports each file and then `exec`s node. No `secretObjects`, so no application
  secret is copied into a Kubernetes Secret. The one exception is the gateway TLS certificate, which
  the Gateway API requires as a Secret.
- The add-on polls every 2 minutes (`enableSecretRotation`), so mounted files update in place.
- Values exposed as environment variables (Kubernetes Secret sync) do **not** change in running
  processes: rotating them requires `kubectl rollout restart`.
- The application reads its configuration once at start, so the rotation procedure for
  `ANTHROPIC_API_KEY`, the Alpaca keys, `AUTH_SECRET` and the Entra client secret is:
  1. Set the new version.
  2. Wait one poll interval.
  3. Rolling-restart the affected Deployment.
  4. Revoke the old value at the provider.

  For `AUTH_SECRET`, restarting invalidates existing sessions and signed SSE cursors by design.

## What is tested and what is not

| Path | Evidence |
| --- | --- |
| Entra token exchange (request shape, caching, single-flight, assertion re-read, error redaction) | `packages/db/test/azure-credentials.test.ts` (unit, fake token endpoint) |
| Redis refresh schedule, retries, expiry reporting, reconnect subscription handling | same file (fake timers) |
| Prisma signs each new PostgreSQL connection in with the current credential; stale credential rejected | `packages/db/test/credential-rotation.integration.test.ts` against real PostgreSQL 17.6 (password rotated under a live client) |
| node-redis sends `AUTH` on the live connection with the refreshed credential, keeps its connection ID, and reconnects with the newest one after the old is revoked | same suite against real Redis 7.4.5 ACL users |
| Bootstrap SQL, migrations as `pp_migrator`, runtime DML-only privileges, migrator rotation | `npm run verify:postgres-roles` (non-superuser admin, like Azure) |
| **Azure accepting the tokens** (Entra admin, `pgaadauth`, access policy assignments, CSI driver) | **Not verified.** It needs provisioned resources. Smoke commands are in [provisioning.md](provisioning.md#9-smoke-tests-after-milestone-35-manifests) |

Until those smoke tests pass, the documented fallback works without Entra on the data plane:

- PostgreSQL: `DATABASE_AUTH=url`, using a password role per workload created like `pp_migrator`.
- Redis: `REDIS_AUTH=url`, after redeploying with `redisAccessKeysAuthentication=Enabled`, using
  the access key stored in Key Vault.

Both fallbacks rotate by "set the new version, then restart".
