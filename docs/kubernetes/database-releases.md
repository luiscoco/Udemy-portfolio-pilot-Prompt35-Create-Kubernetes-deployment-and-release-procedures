# Database changes in a release (milestone 35)

Decision record: [ADR 0027](../decisions/0027-kubernetes-gateway-and-release.md). The migration
mechanics are in [deploy/kubernetes/migrate/job.yaml](../../deploy/kubernetes/migrate/job.yaml).

## How a migration runs

1. The release renders two units from the same `release.env`: the migration Job
   `db-migrate-<RELEASE_ID>` and the application.
2. The Job runs `prisma migrate deploy` once, as the owner role `pp_migrator`. Its URL is read from
   Key Vault (`database-migrator-url`) into the process; it never becomes a Kubernetes Secret, a pod
   environment entry or a log line.
3. `scripts/k8s-lib.mjs#releaseToCluster` waits for `Complete`. Only then does it apply the
   application. If the Job reports `Failed`, or runs longer than 15 minutes, the release stops and
   the running application is untouched.
4. API pods never migrate:
   - The runtime identities belong to `pp_runtime`, which has DML privileges only, so they *cannot*
     run DDL (milestone 34, `verify:postgres-roles`).
   - Prisma takes a PostgreSQL advisory lock during `migrate deploy`, so even an accidental second Job
     waits rather than applying twice.
5. `backoffLimit: 0`: a failed migration is not retried by Kubernetes.
   - Prisma records the failure in `_prisma_migrations`, and a blind retry would fail the same way or
     act on a half-applied change.
   - Look at the log first:
     `kubectl -n portfolio-pilot logs job/db-migrate-<RELEASE_ID>`.
   - Then decide with `prisma migrate resolve --rolled-back|--applied <migration>`. Run it from a
     one-off pod using the same image and secret mount as the Job.
   - Release again with a **new** `RELEASE_ID`.
6. After the **first** migration of a new environment, re-run bootstrap SQL step 3
   ([provisioning.md](../azure/provisioning.md#7-bootstrap-postgresql-roles-and-the-database)). It
   grants `pp_runtime` access to the tables the migration just created.
   - Later migrations inherit those grants through the default privileges set by step 3.

## Expand / contract: every schema change must work with two application versions

During a rolling update, old and new API and worker pods run **at the same time** against the **same,
already-migrated** database. A rollback (`kubectl rollout undo`) brings old code back onto that same
database. So every migration must be compatible with both the version before it and the version that
ships with it.

| Change | Release N (expand) | Release N+1 (migrate data / switch) | Release N+2 (contract) |
| --- | --- | --- | --- |
| Add a column | Add it **nullable** (or with a default); old code ignores it | Code writes and reads it; backfill in batches if needed | Add `NOT NULL` once every row is filled and no old code remains |
| Rename a column | Add the new column; code writes **both**, reads old | Backfill; code reads new | Drop the old column |
| Remove a column | Code stops reading and writing it (no migration yet) | Drop the column | — |
| Add a table / index | Create (indexes `CONCURRENTLY` in a separate migration, see below) | Use it | — |
| Change a type or constraint | New column/constraint added `NOT VALID`, dual-write | `VALIDATE CONSTRAINT`; switch reads | Drop the old one |
| New enum value | Add the value; old code must tolerate (or never see) it | Start writing it | — |

Rules:

- **Never** drop, rename or tighten anything that the *currently running* version still uses.
- **Destructive steps are their own release.** A contract migration ships only after the previous
  release has been fully rolled out and kept (no rollback planned).
- **Long locks.**
  - `ALTER TABLE ... ADD COLUMN ... DEFAULT <constant>` is metadata-only on PostgreSQL 17.
  - Rewriting a table, or `CREATE INDEX` without `CONCURRENTLY`, blocks writers. On the B2s dev
    server that would stall the outbox and the SSE fan-out.
  - Prisma runs each migration in a transaction, but `CREATE INDEX CONCURRENTLY` cannot run in one.
    Put it alone in its own migration file and review the generated SQL by hand.
- **Backfills** belong in application code or a dedicated, idempotent Job running in batches. They do
  not belong in the migration that the release waits for.
- **Review** every generated `migration.sql` in the pull request. `prisma migrate diff` shows the SQL
  before it exists.

## Why rolling the application back does not roll the database back

- `kubectl rollout undo deployment/api` restores the previous **pod template**. It does not run SQL,
  and Prisma has no down-migrations. The schema stays at release N.
- That is intentional. "Undoing" a migration usually destroys data:
  - dropping a column that new code already wrote to;
  - deleting rows inserted into a new table;
  - reverting a type change with values that no longer fit.

  In a ledger application (immutable trades, outbox events, approvals) that is never acceptable as
  an automatic step.
- So the safe rollback is the **application only**. It is safe exactly because of expand/contract:
  the old code runs correctly on the expanded schema.
- If a migration itself is wrong:
  - **fix forward** with a new migration in a new release; or
  - **restore** (next section) when data was damaged.

  There is no third option.

## Backup and restore

What exists (milestone 34, [postgres.bicep](../../infra/azure/modules/postgres.bicep)):

- Azure Database for PostgreSQL Flexible Server takes **automatic backups** with **7-day** retention
  in dev (`postgresBackupRetentionDays`). It has no geo-redundancy (`postgresGeoRedundantBackup =
  Disabled`).
- Restore is **point-in-time to a new server**. It never restores in place.
- Redis is not backed up: persistence is off, and everything in it can be rebuilt from PostgreSQL
  (snapshot recovery, ADR 0007).
- Blob session snapshots have 7-day soft delete.

Before every release that contains a **contract** or otherwise risky migration:

```bash
# 1. Record the restore point (UTC) in the release notes.
date -u +%Y-%m-%dT%H:%M:%SZ
# 2. Optional logical export through the migration role (the URL is piped, never printed):
az keyvault secret show --vault-name "$KV" --name database-migrator-url --query value -o tsv \
  | kubectl run pg-dump -n portfolio-pilot --rm -i --quiet --restart=Never --image=postgres:17.6-alpine \
      --command -- sh -c 'IFS= read -r URL && exec pg_dump --format=custom --no-owner "${URL%%\?*}?sslmode=verify-full&sslrootcert=system"' \
  > "portfolio_pilot-$(date -u +%Y%m%dT%H%M%SZ).dump"
```

To restore after a damaging migration (operator decision, outage expected):

1. **Stop writers.**
   ```bash
   kubectl -n portfolio-pilot scale deploy/worker-ingestion deploy/worker-outbox deploy/worker-agent --replicas=0
   ```
   Then put the API in maintenance by scaling it to 0, or accept errors.
2. **Restore to a new server** at the recorded time:
   ```bash
   az postgres flexible-server restore -g "$RG" --name <new-server> \
     --source-server "$(out postgresServerName)" --restore-time <UTC time>
   ```
   The new server needs its own private endpoint and DNS zone group. Repeat
   [provisioning.md step 7](../azure/provisioning.md#7-bootstrap-postgresql-roles-and-the-database)
   steps 1–3: Entra principals are per server.
3. **Point the release at it.**
   - Update the four `*_DATABASE_URL` values and the Key Vault `database-migrator-url`.
   - Release the application version that matches the restored schema (`kubectl rollout undo`, or a
     release of that commit).
4. **Clear Redis.** It holds only derived data: caches and replay streams.
   - Flush it so no cached value or stream entry refers to rows that the restore removed:
     ```bash
     az redisenterprise database flush --cluster-name "$(out redisName)" --resource-group "$RG"
     ```
   - Browsers whose cursor is no longer in the stream receive `stream.reset` and reload their
     snapshots (ADR 0007/0008).

   Then scale the workers back up.
5. **Account for lost data.** Anything written after the restore point is lost. Reconcile it from the
   outbox or audit logs where possible.

**Not verified:** no restore has been run against Azure (nothing is provisioned). The logical export
command was exercised locally only in its milestone-34 form.
