# 0026. Azure infrastructure, private networking and data-plane credentials

- Status: Accepted
- Date: 2026-10-03
- Milestone: 34

## Context

PortfolioPilot targets the Azure services fixed in AGENTS.md: AKS, Azure Container Registry,
PostgreSQL Flexible Server, Azure Managed Redis, Key Vault, Blob Storage and monitoring. Milestone 34
must describe them as parameterized Bicep, validate them without creating anything, and define how
each client obtains and refreshes credentials. It may not claim identity support without a tested
integration path.

Facts verified on 2026-10-03 (Microsoft Learn, the Bicep 0.41.2 type library, the Retail Prices API
and installed package code):

- **Azure Managed Redis**
  - Entra authentication: the user is the identity's **object ID**, the password a token for
    `https://redis.azure.com/.default`.
  - Clients must send `AUTH` with a fresh token before expiry (at least three minutes early) or be
    disconnected. Access keys can be disabled per database.
  - Clustering: `OSSCluster`, the default, needs a cluster-aware client. `EnterpriseCluster` exposes
    one proxy endpoint and allows only `DEL/MSET/MGET/EXISTS/UNLINK/TOUCH` across slots.
- **PostgreSQL Flexible Server**
  - The Entra token is the password, for scope `https://ossrdbms-aad.database.windows.net`. It is
    valid 5–60 minutes and checked at sign-in.
  - Roles for managed identities come from `pgaadauth_create_principal_with_oid`, run by an Entra
    administrator.
  - B1ms allows only 35 user connections; B2s allows 414.
- **node-redis 5.10** sends `AUTH` on the live connection whenever a `streaming-credentials-provider`
  emits new credentials. It re-subscribes on every reconnect handshake without disposing the previous
  subscription.
- **node-postgres 8.16** accepts `password` as an async function, called once per new `Client`.
  However, when a `connectionString` is also given, its parser sets `password = ''` and overrides
  the function.
- **Bicep 0.41.2** (the installed CLI) knows these newest stable API versions, and they are pinned:
  AKS `2025-10-01`, ACR `2025-11-01`, PostgreSQL `2025-08-01`, Managed Redis `2025-07-01`, Key Vault
  `2025-05-01`, Storage `2025-06-01`, Network `2025-05-01`.
  - Newer stable versions exist (AKS `2026-06-01`) but are not in this type library. Using them
    would turn type checking into "type not available" warnings.
  - Diagnostic settings use `2021-05-01-preview`, the only version with category groups.

## Decision

1. **One subscription-scoped Bicep entry point** (`infra/azure/main.bicep`).
   - It creates the resource group and calls a resource-group module, so one `what-if` covers
     everything.
   - Dev sizes: 2–3 × `Standard_D2s_v6` Azure Linux nodes (Free tier), Burstable B2s PostgreSQL 17,
     Balanced B0 Redis without HA, Basic ACR.
   - Dev durability defaults: 7-day backups, no geo-redundancy, no purge protection.
   - Globally unique names share a 6-character `uniqueString` suffix.
2. **Private data plane.**
   - PostgreSQL, Redis, Key Vault and Blob each have a private endpoint, a linked private DNS zone
     and public access disabled. The exception is Key Vault, which can allow `operatorIpRanges`.
   - The private-endpoint subnet NSG admits only the AKS node subnet on 5432, 10000 and 443.
   - Egress goes through a NAT gateway with a static IP; outbound destinations are documented.
   - The registry stays public: Basic has no private endpoint, and pulls and pushes still need Entra
     roles.
3. **One user-assigned identity per workload**, federated to one service account: API, ingestion,
   outbox, agent, migrate, OTel collector, and two GitHub environments.
   - Roles are scoped to the narrowest resource: subnet, registry, the session container, the
     cluster, a namespace (by command), and **individual Key Vault secrets** (by command, because the
     secrets do not exist at deployment time).
   - Every role GUID is checked against an allow-list verified from Microsoft's role JSON.
4. **Data-plane credentials.**
   - **Runtime: Entra tokens through workload identity.** `DATABASE_AUTH`/`REDIS_AUTH =
     azure-workload-identity`, implemented in `packages/db/src/azure-credentials.ts`.
     - PostgreSQL: a fresh token per new physical connection, with discrete pool fields.
     - Redis: a streaming provider that refreshes five minutes plus jitter before expiry and keeps
       only the newest subscription alive.
     - Redis uses `EnterpriseCluster`, valid because every application command is single-key.
   - **Default:** `url` mode is unchanged for local and Compose.
   - **Migrations:** a password role, `pp_migrator`, that owns the database. Its URL lives in Key
     Vault, and it is created from a client-side SCRAM verifier.
   - **The local admin password** is a per-deployment secure parameter that is never stored.
5. **The database is created by bootstrap SQL**, not ARM, so the migrator owns it. Runtime roles
   are members of `pp_runtime`, which has DML and sequence usage only. The migration ledger is
   revoked from it.
6. **Provider secrets** are Key Vault secrets mounted by the Secrets Store CSI driver (2-minute
   rotation poll). Rotation is "set the new version, then rolling restart", because configuration is
   read at start.
7. **Production workers no longer require sign-in secrets.** With `WORKER_ROLE` set, production
   requires only `DATABASE_URL` and a pseudonym key. The OIDC client secret and session secret stay
   with the API.
8. **The template creates no secret values.** No `Microsoft.KeyVault/vaults/secrets`, no `list*()`
   calls, no secret-like outputs, and the parameter file reads the one secure input from an
   environment variable. `npm run validate:infra` enforces all of this.

## Consequences

- **Tested locally:**
  - Token exchange: unit tests.
  - Per-connection PostgreSQL credentials and live Redis re-`AUTH`/reconnect under real credential
    rotation: an integration suite against PostgreSQL 17.6 and Redis 7.4.5.
  - The complete role model, including migrations as a non-superuser-created owner and runtime least
    privilege: `npm run verify:postgres-roles`.
- **Not tested:** that Azure accepts the tokens (Entra principals, access policy assignments, the
  CSI driver), and what-if/deployment. The CLI's refresh token had expired, and provisioning is not
  authorized. The documented fallback (`url` mode with Key Vault-held passwords or keys) avoids
  data-plane Entra until the smoke tests pass.
- Creating the per-secret Key Vault grants and the namespace RBAC are imperative steps in
  `docs/azure/provisioning.md`, not Bicep.
- The registry is reachable from the internet (authenticated). Making it private means upgrading to
  Premium.
- Raising the Bicep CLI would allow AKS `2026-06-01`. Do it deliberately and record it in
  `docs/versions.md`.
