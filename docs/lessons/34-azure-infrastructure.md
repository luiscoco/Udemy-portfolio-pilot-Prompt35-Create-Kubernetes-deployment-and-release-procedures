# 34. Generate and validate Azure infrastructure

Decision record: [ADR 0026](../decisions/0026-azure-infrastructure-and-credentials.md).
Operator documentation lives in [docs/azure/](../azure/):

- [network design](../azure/network.md)
- [identities and credentials](../azure/credentials.md)
- [cost worksheet](../azure/cost-estimate.md)
- [manual choices](../azure/manual-choices.md)
- [provisioning and cleanup](../azure/provisioning.md)

**Nothing was provisioned.**

## What works

- **Parameterized Bicep** in `infra/azure/` that compiles and lints with **zero diagnostics**. It
  declares:
  - AKS: Entra-only, workload identity, Cilium overlay, NAT egress, Key Vault CSI with rotation,
    Container insights over managed identity.
  - ACR.
  - PostgreSQL 17 Flexible Server: Entra and password auth, private endpoint, 7-day backups,
    maintenance window.
  - Azure Managed Redis: TLS, `EnterpriseCluster`, access keys disabled, Entra users.
  - Key Vault: RBAC, firewall, private endpoint.
  - Blob Storage: Entra-only, private, lifecycle backstop.
  - Log Analytics and Application Insights.
  - VNet, NSG, NAT gateway and four private DNS zones.
  - Eight managed identities with federated credentials, least-privilege role assignments, and a
    budget.
- A **small dev parameter file** with tags and **no secrets**. The single secure input is read
  from `PP_PG_ADMIN_PASSWORD` at deployment time.
- **`npm run validate:infra`**:
  - Static checks: build, lint, parameter build, naming rules, secret scan, and template policy
    (stable APIs, verified role GUIDs, private data services, no secret outputs).
  - `--self-test` plants ten violations and proves each check catches its own.
  - `--azure` runs read-only `validate` and `what-if` when signed in.
- **Entra credential providers in the app** (`DATABASE_AUTH` / `REDIS_AUTH =
  azure-workload-identity`):
  - Prisma gets a fresh token per new PostgreSQL connection.
  - node-redis re-authenticates live connections before expiry.
  - Both are tested against real PostgreSQL and Redis with rotating credentials.
- **The PostgreSQL role model**: bootstrap SQL plus a client-side SCRAM verifier helper, verified by
  `npm run verify:postgres-roles` (14/14).
- **Least-privilege configuration fix**: production workers no longer require the OIDC client
  secret or the session secret.

## Part 1: Verify, don't invent

Every schema fact in the templates came from one of three places:

1. **Microsoft Learn's template reference.** Examples: Redis `accessKeysAuthentication`, the
   `accessPolicyAssignments` shape, PostgreSQL `authConfig`, the valid `version` values.
2. **The Bicep compiler's own type library.** We probed which API versions it knows by compiling
   `existing` references. Unknown versions report `BCP081`, so AKS `2026-06-01` was rejected in
   favour of `2025-10-01`, which the compiler can type-check.
3. **Package source in `node_modules`.** For example, how node-redis handles
   `streaming-credentials-provider`.

Role GUIDs were parsed from Microsoft's built-in role JSON. One remembered GUID turned out to belong
to a different role ("Cluster Monitoring User"), which is why the validator rejects any GUID outside
the verified set.

## Part 2: Private by default

- Data services have public access disabled. Each gets a private endpoint and a private DNS zone
  linked to the VNet, so apps keep the normal host names.
- An NSG on the endpoint subnet admits only the AKS node subnet. Pod-level policy follows in
  milestone 35.
- Outbound traffic leaves through a NAT gateway with a static IP. The table in
  [network.md](../azure/network.md) lists every destination the app needs: Anthropic, Alpaca, Entra
  and the AKS requirements.
- The API server is Entra-only. Its NAT IP is added to the authorized ranges, because node traffic
  to a public API server goes out through the outbound path.

## Part 3: Credentials that refresh

Two different expiry models:

- **PostgreSQL checks the token at sign-in only.** node-postgres can take an async password
  function, called per new connection. Trap: pg's connection-string parser sets `password: ''`
  when the URL has none, and that overrides the function. So Entra mode passes discrete fields; the
  integration test proves the stale value is rejected and the callback is really used.
- **Azure Managed Redis disconnects a client whose token expires.** The client must send `AUTH`
  before then. node-redis does this for a `streaming-credentials-provider`. Our provider fetches a
  token five minutes plus jitter before expiry and asks the token cache for enough validity that it
  cannot get the current token back. Because node-redis re-subscribes on every reconnect without
  disposing the old subscription, only the newest one is kept alive.

The integration test uses real servers and rotates the credential underneath live clients:

- `ALTER ROLE ... PASSWORD` for PostgreSQL.
- Redis ACL passwords for Redis. It proves the `AUTH` reached the live connection via `ACL LOG`
  and an unchanged `CLIENT ID`, and that the reconnect used the newest token after the old one was
  revoked.

What remains untested is Azure accepting the tokens, which needs real resources.

## Part 4: Database roles

- **`pp_migrator`** owns the database. It uses a password, because Prisma's schema engine needs a
  URL, and the password is stored in Key Vault.
- **Runtime identities** are Entra roles in `pp_runtime`, with DML and sequence usage only.
- **The local admin password** is generated per deployment, used for bootstrap, and never stored.

The verification runs the real SQL as a non-superuser `CREATEROLE`/`CREATEDB` admin, like Azure's.
It applies the real migrations as the migrator, seeds as a runtime role, and checks that DDL and the
migration ledger are denied.

The migrator password reaches PostgreSQL only as a SCRAM-SHA-256 verifier computed on the
operator's machine, so it cannot appear in statement logs.

## Part 5: Cost and manual choices

- [cost-estimate.md](../azure/cost-estimate.md) multiplies retail meters, queried today, by explicit
  quantities: ≈ USD 334/month expected and ≈ 472 at the upper bound.
- It flags what could not be confirmed: a new AKS Free-tier meter, whether Redis HA changes the
  price, and the private endpoint rate in eastus2.
- [manual-choices.md](../azure/manual-choices.md) lists every decision a human must make before
  `az deployment sub create`.

## Teaching points

- `what-if` is read-only, but it still needs a valid sign-in. A 90-day-idle refresh token
  (AADSTS700082) is "not authenticated", not an error to work around.
- Least privilege covers configuration too: a validator that requires every secret everywhere forces
  over-granting.
- Key Vault RBAC can be scoped to a single secret, but only once the secret exists. Do those grants
  after setting values.
- Prefer `EnterpriseCluster` (or a cluster-aware client) on Azure Managed Redis. Check your commands
  for cross-slot use first.

## Common mistakes

- Using the default `OSSCluster` policy with a non-cluster Redis client.
- Passing `connectionString` together with a password callback to node-postgres.
- Writing secrets with `Microsoft.KeyVault/vaults/secrets` from parameters. The values end up in
  parameter files or deployment inputs.
- Relying on `items()` order in Bicep: it sorts keys alphabetically.
- Creating the database with ARM, then discovering the migration role cannot own or grant on it.
- Forgetting that geo-redundant backup, Key Vault soft-delete retention and purge protection
  cannot be undone after creation.

## Changed files

**Created:**

- `infra/azure/main.bicep`, `infra/azure/bicepconfig.json` and
  `infra/azure/parameters/dev.bicepparam`.
- `infra/azure/modules/`: `workload`, `network`, `private-endpoint`, `monitoring`, `aks`,
  `registry`, `postgres`, `redis`, `keyvault`, `storage`, `federation` and `budget` (`.bicep`).
- `infra/azure/sql/01-entra-principals.sql`, `02-roles-and-database.sql` and
  `03-database-privileges.sql`.
- `infra/azure/scripts/scram-verifier.mjs`.
- `packages/db/src/azure-credentials.ts`.
- `packages/db/test/azure-credentials.test.ts` and
  `packages/db/test/credential-rotation.integration.test.ts`.
- `scripts/validate-infra.mjs` and `scripts/verify-postgres-roles.mjs`.
- `docs/azure/`: `network`, `credentials`, `cost-estimate`, `manual-choices` and `provisioning`
  (`.md`).
- ADR 0026 and this lesson.

**Modified:**

- `packages/db/src/index.ts`: credential-mode-aware pool and Redis options, plus
  `createDatabaseClient`.
- `packages/config/src/server.ts`: `DATABASE_AUTH`, `REDIS_AUTH`, `REDIS_ENTRA_OBJECT_ID`,
  `AZURE_AUTHORITY_HOST` and `WORKER_ROLE`, with worker-specific production rules.
- `packages/config/test/config.test.ts`.
- `scripts/test-integration.mjs`: the new suite, with the workspace derived from its path.
- `package.json`: `validate:infra` and `verify:postgres-roles`.
- `docs/versions.md`, `docs/decisions/README.md`, `docs/project-state.md` and
  `docs/verification-report.md`.
