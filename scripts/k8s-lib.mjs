// Shared Kubernetes release helpers (milestone 35). Used by `scripts/k8s-release.mjs` (AKS, operator or
// GitHub workflow), `scripts/verify-k8s-local.mjs` (kind) and `scripts/validate-k8s.mjs` (static), so
// the release order that is tested locally is the same code that runs against AKS.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseAllDocuments } from 'yaml';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const K8S = join(ROOT, 'deploy', 'kubernetes');
export const FIELD_MANAGER = 'portfolio-pilot-release';

/** Synchronous process call. `az` is a .cmd shim on Windows and needs a shell; everything else does not. */
export function run(command, args, { input, allowFailure = false, env = process.env, timeoutMs } = {}) {
  const shell = process.platform === 'win32' && command === 'az';
  const quote = arg => /^[A-Za-z0-9_./:=@,-]+$/.test(arg) ? arg : `"${arg.replaceAll('"', '\\"')}"`;
  const result = shell
    ? spawnSync([command, ...args].map(quote).join(' '), { encoding: 'utf8', shell: true, windowsHide: true, input, env, timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024 })
    : spawnSync(command, args, { encoding: 'utf8', windowsHide: true, input, env, timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024 });
  const out = { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error };
  if (!allowFailure && (result.status !== 0 || result.error)) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status ?? result.error?.code}): ${(out.stderr || out.stdout).trim().slice(0, 4000)}`);
  }
  return out;
}

/** A tool from .local/tools (downloaded for local verification) or from PATH. */
export function tool(name) {
  const local = join(ROOT, '.local', 'tools', process.platform === 'win32' ? `${name}.exe` : name);
  return existsSync(local) ? local : name;
}

/** `kubectl kustomize`; the AKS migration unit shares release.env with the app overlay, outside its root. */
export function kustomize(dir, { shareReleaseEnv = false } = {}) {
  const args = ['kustomize', ...(shareReleaseEnv ? ['--load-restrictor=LoadRestrictionsNone'] : []), dir];
  return run('kubectl', args).stdout;
}

export function parseManifests(text) {
  return parseAllDocuments(text).map(doc => {
    if (doc.errors.length) throw new Error(`YAML error: ${doc.errors[0].message}`);
    return doc.toJS();
  }).filter(Boolean);
}

export function readEnvFile(path) {
  const values = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index < 1) throw new Error(`${path}: not KEY=value: ${trimmed}`);
    values[trimmed.slice(0, index)] = trimmed.slice(index + 1);
  }
  return values;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMAGE = name => new RegExp(`^[a-z0-9]{5,50}\\.azurecr\\.io/portfolio-pilot/${name}@sha256:[0-9a-f]{64}$`);
const ENTRA_DB_URL = /^postgresql:\/\/id-[a-z0-9-]+@[a-z0-9-]+\.postgres\.database\.azure\.com:5432\/[a-z_]+\?sslmode=verify-full$/;
/** Every release.env key with its format. Formats are strict so a secret pasted by mistake fails. */
export const RELEASE_KEYS = {
  RELEASE_ID: /^[a-z0-9]([a-z0-9.-]{0,40}[a-z0-9])?$/,
  PUBLIC_HOSTNAME: /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
  WEB_IMAGE: IMAGE('web'), API_IMAGE: IMAGE('api'), WORKER_IMAGE: IMAGE('worker'), MIGRATE_IMAGE: IMAGE('migrate'),
  DATA_MODE: /^(mock|live)$/, AGENT_MODE: /^(mock|claude)$/, AGENT_MODEL_ID: /^([A-Za-z0-9._:@/-]{1,128})?$/,
  AZURE_TENANT_ID: UUID, KEY_VAULT_NAME: /^[a-zA-Z][a-zA-Z0-9-]{1,22}[a-zA-Z0-9]$/,
  PRIVATE_ENDPOINT_CIDR: /^(10|172|192)\.\d{1,3}\.\d{1,3}\.\d{1,3}\/(1[6-9]|2[0-9])$/,
  REDIS_URL: /^rediss:\/\/[a-z0-9-]+\.[a-z0-9]+\.redis\.azure\.net:10000$/,
  SESSION_BLOB_CONTAINER_URL: /^https:\/\/[a-z0-9]{3,24}\.blob\.core\.windows\.net\/session-artifacts$/,
  API_DATABASE_URL: ENTRA_DB_URL, INGESTION_DATABASE_URL: ENTRA_DB_URL, OUTBOX_DATABASE_URL: ENTRA_DB_URL, AGENT_DATABASE_URL: ENTRA_DB_URL,
  API_CLIENT_ID: UUID, API_OBJECT_ID: UUID, INGESTION_CLIENT_ID: UUID, INGESTION_OBJECT_ID: UUID,
  OUTBOX_CLIENT_ID: UUID, OUTBOX_OBJECT_ID: UUID, AGENT_CLIENT_ID: UUID, AGENT_OBJECT_ID: UUID,
  MIGRATE_CLIENT_ID: UUID, TLS_CLIENT_ID: UUID, ENTRA_CLIENT_ID: UUID, ENTRA_TENANT_ID: UUID
};
const EXAMPLE_MARKERS = [/example/i, /^0{8}-0{4}-4000-8000-0{8}[0-9a-f]{4}$/, /sha256:0{60}/];

/** Problems with a release.env; `allowExample` accepts the committed example (static validation only). */
export function releaseEnvProblems(values, { allowExample = false } = {}) {
  const problems = [];
  for (const [key, format] of Object.entries(RELEASE_KEYS)) {
    if (!(key in values)) { problems.push(`${key} is missing`); continue; }
    if (!format.test(values[key])) problems.push(`${key} has an invalid value`);
    else if (!allowExample && EXAMPLE_MARKERS.some(marker => marker.test(values[key]))) problems.push(`${key} still holds an example value`);
  }
  for (const key of Object.keys(values)) if (!(key in RELEASE_KEYS)) problems.push(`${key} is not a known release parameter`);
  if (values.AGENT_MODE === 'claude' && !values.AGENT_MODEL_ID) problems.push('AGENT_MODEL_ID is required when AGENT_MODE=claude');
  const identity = key => values[key]?.match(/^postgresql:\/\/([^@]+)@/)?.[1];
  for (const [key, role] of [['API_DATABASE_URL', 'api'], ['INGESTION_DATABASE_URL', 'ingestion'], ['OUTBOX_DATABASE_URL', 'outbox'], ['AGENT_DATABASE_URL', 'agent']]) {
    if (identity(key) && !identity(key).endsWith(`-${role}`)) problems.push(`${key} must sign in as the ${role} identity`);
  }
  const ids = ['API', 'INGESTION', 'OUTBOX', 'AGENT', 'MIGRATE', 'TLS'].map(p => values[`${p}_CLIENT_ID`]).filter(Boolean);
  if (new Set(ids).size !== ids.length) problems.push('every workload must use its own identity (duplicate client IDs)');
  return problems;
}

export const kubectlFor = context => (args, options = {}) => run('kubectl', [...(context ? ['--context', context] : []), ...args], options);

const podSecurityWarnings = stderr => stderr.split(/\r?\n/).filter(line => /would violate PodSecurity/.test(line));

/**
 * The ordered release (ADR 0027): server-side dry run of both units -> migration Job applied and
 * awaited (a failed or timed-out Job stops the release before any application change) -> application
 * applied -> every Deployment rolled out -> the Gateway programmed. Nothing is rolled back automatically:
 * the database cannot be, and the application decision belongs to the operator (database-releases.md).
 */
export async function releaseToCluster({ kubectl, namespace, migrateYaml, appYaml, log = console.log,
  jobTimeoutMs = 15 * 60_000, rolloutTimeout = '10m', dryRunOnly = false }) {
  const report = { warnings: [] };
  const apply = (yaml, extra = []) => kubectl(['apply', '--server-side', `--field-manager=${FIELD_MANAGER}`, ...extra, '-f', '-'], { input: yaml });
  for (const [unit, yaml] of [['migration', migrateYaml], ['application', appYaml]]) {
    const result = apply(yaml, ['--dry-run=server']);
    report.warnings.push(...podSecurityWarnings(result.stderr).map(line => `${unit}: ${line}`));
    log(`server-side dry run passed: ${unit} (${parseManifests(yaml).length} objects)`);
  }
  if (dryRunOnly) return report;

  const job = parseManifests(migrateYaml).find(o => o.kind === 'Job');
  const state = () => {
    const found = kubectl(['-n', namespace, 'get', 'job', job.metadata.name, '-o', 'json'], { allowFailure: true });
    if (found.status !== 0) return 'absent';
    const conditions = JSON.parse(found.stdout).status?.conditions ?? [];
    if (conditions.some(c => c.type === 'Complete' && c.status === 'True')) return 'complete';
    if (conditions.some(c => c.type === 'Failed' && c.status === 'True')) return 'failed';
    return 'running';
  };
  const initial = state();
  if (initial === 'failed') throw new Error(`Migration Job ${job.metadata.name} already FAILED for this release; read its logs and follow docs/kubernetes/database-releases.md before retrying with a new RELEASE_ID.`);
  if (initial === 'absent') { apply(migrateYaml); log(`migration Job ${job.metadata.name} created`); }
  else log(`migration Job ${job.metadata.name} already exists (${initial}); not recreated`);
  const deadline = Date.now() + jobTimeoutMs;
  let status = state();
  while (status === 'running' && Date.now() < deadline) { await sleep(2000); status = state(); }
  const logs = kubectl(['-n', namespace, 'logs', `job/${job.metadata.name}`, '--tail=40'], { allowFailure: true }).stdout.trim();
  report.migrationLog = logs;
  if (status !== 'complete') {
    throw new Error(`Migration Job ${job.metadata.name} ${status === 'running' ? 'did not finish in time' : status}; the application was NOT changed.\n${logs}`);
  }
  log(`migration Job complete:\n${logs.split('\n').slice(-3).join('\n')}`);

  apply(appYaml);
  log('application applied');
  const objects = parseManifests(appYaml);
  for (const deployment of objects.filter(o => o.kind === 'Deployment' || o.kind === 'StatefulSet')) {
    kubectl(['-n', namespace, 'rollout', 'status', `${deployment.kind.toLowerCase()}/${deployment.metadata.name}`, `--timeout=${rolloutTimeout}`], { timeoutMs: 11 * 60_000 });
    log(`rolled out: ${deployment.kind}/${deployment.metadata.name}`);
  }
  for (const gateway of objects.filter(o => o.kind === 'Gateway')) {
    kubectl(['-n', namespace, 'wait', '--for=condition=Programmed', `gateway.gateway.networking.k8s.io/${gateway.metadata.name}`, '--timeout=300s']);
    log(`gateway programmed: ${gateway.metadata.name}`);
  }
  return report;
}
