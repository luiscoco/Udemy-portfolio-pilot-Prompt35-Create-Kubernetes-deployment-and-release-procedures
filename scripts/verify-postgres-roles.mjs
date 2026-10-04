// `npm run verify:postgres-roles` (milestone 34) — proves the Azure PostgreSQL role model on a
// disposable local PostgreSQL 17 before any Azure resource exists:
//   - the bootstrap SQL (infra/azure/sql/02 and 03) runs as a NON-superuser CREATEROLE/CREATEDB
//     administrator, like Azure's local admin;
//   - the real Prisma migrations apply as pp_migrator, authenticated by the SCRAM verifier;
//   - a runtime role (stand-in for an Entra principal from 01-entra-principals.sql, which needs Azure)
//     can seed and use the application but cannot run DDL or read the migration ledger;
//   - re-running step 2 rotates the migrator password.
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { scramVerifier } from '../infra/azure/scripts/scram-verifier.mjs';
import { ensureBuilt, freePort, migrate, PrerequisiteError, root } from './test-support/infra.mjs';

const IMAGE = 'postgres:17.6-alpine';
const name = `pp-verify-pgroles-${Date.now().toString(36)}`;
const secret = () => randomBytes(24).toString('base64url');
const superPassword = secret(), adminPassword = secret();
const runtimeRoles = ['id-pp-test-api', 'id-pp-test-ingestion', 'id-pp-test-outbox', 'id-pp-test-agent'];
const results = [];
const check = (label, ok, detail = '') => { results.push({ label, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`); };

function docker(args, input) {
  const result = spawnSync('docker', args, { input, encoding: 'utf8', windowsHide: true });
  return { ok: result.status === 0, out: `${result.stdout}${result.stderr}` };
}
/** psql inside the container over TCP, so authentication really happens (no trust/peer). */
function psql({ user, password, database, file, vars = {}, sql }) {
  const args = ['exec', '-i', '-e', `PGPASSWORD=${password}`, name, 'psql', '-X', '-q', '-h', '127.0.0.1', '-U', user, '-d', database, '-v', 'ON_ERROR_STOP=1'];
  for (const [key, value] of Object.entries(vars)) args.push('-v', `${key}=${value}`);
  args.push(...(sql ? ['-c', sql] : ['-f', '-']));
  return docker(args, sql ? undefined : readFileSync(join(root, 'infra/azure/sql', file), 'utf8'));
}

let exitCode = 0;
try {
  ensureBuilt('build:types', ['packages/db/dist/index.js', 'packages/db/dist/seed.js']);
  if (!docker(['info', '--format', '{{.ServerVersion}}']).ok) throw new PrerequisiteError('Docker is required');
  const port = await freePort();
  // scram-sha-256 for TCP connections, as on Azure.
  const started = docker(['run', '-d', '--rm', '--name', name, '--label', 'portfolio-pilot.test=true', '-p', `127.0.0.1:${port}:5432`,
    '-e', `POSTGRES_PASSWORD=${superPassword}`, '-e', 'POSTGRES_HOST_AUTH_METHOD=scram-sha-256', '-e', 'POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256', IMAGE]);
  if (!started.ok) throw new PrerequisiteError(`docker run failed: ${started.out.trim()}`);
  const deadline = Date.now() + 60000;
  while (!psql({ user: 'postgres', password: superPassword, database: 'postgres', sql: 'SELECT 1' }).ok) {
    if (Date.now() > deadline) throw new Error('PostgreSQL did not become ready');
    await new Promise(r => setTimeout(r, 500));
  }

  // Azure's local admin: CREATEROLE + CREATEDB, not a superuser. Runtime roles stand in for Entra principals.
  const setup = [
    `CREATE ROLE ppbreakglass LOGIN CREATEROLE CREATEDB PASSWORD '${adminPassword}'`,
    ...runtimeRoles.map(role => `CREATE ROLE "${role}" LOGIN PASSWORD '${adminPassword}'`)
  ].join('; ');
  check('superuser setup of non-superuser admin and runtime stand-ins', psql({ user: 'postgres', password: superPassword, database: 'postgres', sql: setup }).ok);

  const admin = { user: 'ppbreakglass', password: adminPassword };
  const migratorPassword = secret();
  const step2 = vars => psql({ ...admin, database: 'postgres', file: '02-roles-and-database.sql', vars: { database: 'portfolio_pilot', runtime_roles: runtimeRoles.join(','), ...vars } });
  const rejected = step2({ migrator_verifier: migratorPassword });
  check('step 2 refuses a plaintext password', !rejected.ok && rejected.out.includes('must be a SCRAM-SHA-256 verifier'));
  const s2 = step2({ migrator_verifier: scramVerifier(migratorPassword) });
  check('step 2 (roles + database) as non-superuser admin', s2.ok, s2.ok ? '' : s2.out.trim());
  const s3 = psql({ ...admin, database: 'portfolio_pilot', file: '03-database-privileges.sql', vars: { database: 'portfolio_pilot' } });
  check('step 3 (privileges) as non-superuser admin', s3.ok, s3.ok ? '' : s3.out.trim());

  const url = (user, password) => `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/portfolio_pilot`;
  try { migrate(url('pp_migrator', migratorPassword), () => undefined); check('Prisma migrate deploy as pp_migrator (SCRAM verifier login)', true); }
  catch (error) { check('Prisma migrate deploy as pp_migrator (SCRAM verifier login)', false, String(error.message).split('\n').slice(-3).join(' ')); }
  check('step 3 re-run after migrations (ledger revoked)', psql({ ...admin, database: 'portfolio_pilot', file: '03-database-privileges.sql', vars: { database: 'portfolio_pilot' } }).ok);

  const { createDatabaseClient } = await import(pathToFileURL(join(root, 'packages/db/dist/index.js')).href);
  const { seedDemo } = await import(pathToFileURL(join(root, 'packages/db/dist/seed.js')).href);
  const runtime = createDatabaseClient(url(runtimeRoles[0], adminPassword), { databaseAuth: 'url', redisAuth: 'url' });
  try {
    await seedDemo(runtime);
    const [row] = await runtime.$queryRawUnsafe('SELECT current_user AS "user", (SELECT count(*)::int FROM "User") AS users');
    check('runtime role seeds and reads application data (DML + sequences)', row.user === runtimeRoles[0] && row.users > 0, `${row.users} users`);
    const denied = async (label, statement) => {
      try { await runtime.$executeRawUnsafe(statement); check(label, false, 'statement succeeded'); }
      catch (error) { check(label, /permission denied|must be owner/i.test(String(error.message)), String(error.message).split('\n').at(-1)); }
    };
    await denied('runtime role cannot create tables', 'CREATE TABLE intruder (id int)');
    await denied('runtime role cannot drop or alter application tables', 'ALTER TABLE "User" ADD COLUMN intruder int');
    await denied('runtime role cannot read the migration ledger', 'SELECT 1 FROM _prisma_migrations');
    await denied('runtime role cannot create roles', 'CREATE ROLE intruder');
  } finally { await runtime.$disconnect(); }

  // Rotation: re-running step 2 with a new verifier invalidates the old password immediately.
  const rotated = secret();
  check('step 2 re-run rotates the migrator password', step2({ migrator_verifier: scramVerifier(rotated) }).ok);
  check('old migrator password rejected after rotation', !psql({ user: 'pp_migrator', password: migratorPassword, database: 'portfolio_pilot', sql: 'SELECT 1' }).ok);
  check('new migrator password accepted after rotation', psql({ user: 'pp_migrator', password: rotated, database: 'portfolio_pilot', sql: 'SELECT 1' }).ok);
} catch (error) {
  console.error(error.message);
  exitCode = error instanceof PrerequisiteError ? 2 : 1;
} finally {
  docker(['rm', '-f', '-v', name]);
}
const failed = results.filter(r => !r.ok).length;
console.log(`\nverify:postgres-roles ${results.length - failed}/${results.length} passed`);
process.exit(exitCode || (failed ? 1 : 0));
