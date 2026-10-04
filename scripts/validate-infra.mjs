// `npm run validate:infra` (milestone 34) — static validation of infra/azure; creates nothing.
//   1. Bicep build and lint with zero diagnostics (type-checks every resource against its API version).
//   2. Parameter file build; naming constraints for every globally scoped or length-limited name.
//   3. Secret hygiene: no secret literals in infra files or parameters; the only secure input is
//      read from an environment variable; no secret-bearing outputs or list*() calls.
//   4. Template policy: pinned API versions (no previews except the allowlist), role definition IDs
//      from the verified set, private-only data services, Entra-only Storage/Redis.
// Options:
//   --azure      also run `az deployment sub validate` and `what-if` (read-only) when already signed
//                in with a working token and no REPLACE_ placeholders remain; otherwise reported as skipped.
//   --self-test  plant violations and prove each check fails.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const infra = join(root, 'infra/azure');
const args = new Set(process.argv.slice(2));
const PARAMS = process.env.INFRA_PARAMS ?? join(infra, 'parameters/dev.bicepparam');
// Non-secret stand-in so the parameter file can be built; real deployments read the real variable.
const PLACEHOLDER_PASSWORD = 'static-validation-placeholder-0000';

/** Built-in role IDs verified against learn.microsoft.com built-in role JSON on 2026-10-03. */
export const VERIFIED_ROLES = {
  '4d97b98b-1d4f-4787-a291-c67834d212e7': 'Network Contributor',
  '7f951dda-4ed3-4680-a7ca-43fe172d538d': 'AcrPull',
  '8311e382-0749-4cb8-b61a-304f252e45ec': 'AcrPush',
  '4abbcc35-e782-43d8-92c5-2d3f1bd2253f': 'Azure Kubernetes Service Cluster User Role',
  'b1ff04bb-8a4e-4dc4-8eb5-8693973ce19b': 'Azure Kubernetes Service RBAC Cluster Admin',
  'b86a8fe4-44ce-4948-aee5-eccb2c155cd7': 'Key Vault Secrets Officer',
  'ba92f5b4-2d11-453d-a403-e96b0029c9fe': 'Storage Blob Data Contributor',
  '3913510d-42f4-4e42-8a64-420c390055eb': 'Monitoring Metrics Publisher'
};
// Category groups exist only in this preview; see the comment at each use.
const PREVIEW_ALLOWLIST = new Set(['Microsoft.Insights/diagnosticSettings@2021-05-01-preview']);
const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/AccountKey=[A-Za-z0-9+/=]{20,}/, 'storage account key'],
  [/InstrumentationKey=[0-9a-f-]{36}/i, 'Application Insights key'],
  [/[?&]sig=[A-Za-z0-9%+/=]{20,}/, 'SAS signature'],
  [/\bsk-ant-[A-Za-z0-9_-]{10,}/, 'Anthropic API key'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key'],
  // Placeholders (`%s`, `$VAR`, `<value>`, `{value}`) in documented commands are not secrets.
  [/postgres(ql)?:\/\/[^:\s'"/]+:(?![%$<{])[^@\s'"]+@/, 'database URL with password'],
  [/rediss?:\/\/[^:\s'"/]*:(?![%$<{])[^@\s'"]+@/, 'Redis URL with password'],
  [/(password|secret|apikey|api_key|clientsecret)\s*[:=]\s*'[^'$\s{][^'\s]{7,}'/i, 'literal secret assignment']
];

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok === null ? 'SKIP' : ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}
/** `az` is a .cmd shim on Windows, which needs a shell; quote every argument (paths contain spaces). */
function run(command, commandArgs, options = {}) {
  const quote = arg => /^[A-Za-z0-9_./:=@-]+$/.test(arg) ? arg : `"${arg.replaceAll('"', '\\"')}"`;
  const result = process.platform === 'win32'
    ? spawnSync([command, ...commandArgs].map(quote).join(' '), { encoding: 'utf8', windowsHide: true, shell: true, ...options })
    : spawnSync(command, commandArgs, { encoding: 'utf8', windowsHide: true, ...options });
  const diagnostics = `${result.stderr ?? ''}`.split(/\r?\n/).filter(line => line.trim() && !/new Bicep release is available/.test(line));
  return { ok: result.status === 0, stdout: result.stdout ?? '', diagnostics };
}
function files(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap(name => { const path = join(dir, name); return statSync(path).isDirectory() ? files(path) : [path]; });
}

/** Every nested template's resources (modules compile to Microsoft.Resources/deployments). */
export function allResources(template) {
  const list = [];
  const walk = resources => { for (const resource of Object.values(resources ?? {})) { list.push(resource); if (resource.properties?.template) walk(resource.properties.template.resources); } };
  walk(template.resources);
  return list;
}

export function policyViolations(template) {
  const problems = [];
  const text = JSON.stringify(template);
  for (const resource of allResources(template)) {
    const id = `${resource.type}@${resource.apiVersion}`;
    if (/preview/i.test(resource.apiVersion) && !PREVIEW_ALLOWLIST.has(id)) problems.push(`preview API ${id}`);
  }
  // Role IDs are the only GUID literals in these templates (identities and groups are parameters).
  for (const [guid] of text.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)) if (!VERIFIED_ROLES[guid.toLowerCase()]) problems.push(`GUID ${guid} is not a verified built-in role`);
  if (!text.includes('Microsoft.Authorization/roleDefinitions')) problems.push('no role assignments found (template not parsed as expected)');
  if (/\blist(Keys|Secrets|Credentials|AccountSas|ServiceSas)\(/.test(text)) problems.push('list*() call exposes secrets');
  const outputs = [template.outputs, ...allResources(template).map(r => r.properties?.template?.outputs)].filter(Boolean);
  for (const set of outputs) for (const key of Object.keys(set)) if (/password|secret|connectionstring|accesskey|instrumentationkey/i.test(key)) problems.push(`secret-like output ${key}`);
  const secure = template.parameters?.postgresAdministratorPassword;
  if (!secure || secure.type !== 'securestring' || 'defaultValue' in secure) problems.push('postgresAdministratorPassword must be a securestring without default');
  const byType = type => allResources(template).filter(r => r.type === type && !r.existing);
  for (const r of byType('Microsoft.DBforPostgreSQL/flexibleServers')) if (r.properties?.network?.publicNetworkAccess !== 'Disabled') problems.push('PostgreSQL public network access');
  for (const r of byType('Microsoft.Cache/redisEnterprise')) if (r.properties?.publicNetworkAccess !== 'Disabled') problems.push('Redis public network access');
  for (const r of byType('Microsoft.Cache/redisEnterprise/databases')) if (r.properties?.clientProtocol !== 'Encrypted' || r.properties?.clusteringPolicy !== 'EnterpriseCluster') problems.push('Redis must be TLS with EnterpriseCluster');
  for (const r of byType('Microsoft.Storage/storageAccounts')) {
    const p = r.properties ?? {};
    if (p.publicNetworkAccess !== 'Disabled' || p.allowSharedKeyAccess !== false || p.allowBlobPublicAccess !== false) problems.push('Storage must be private, Entra-only, no anonymous access');
  }
  for (const r of byType('Microsoft.KeyVault/vaults')) if (r.properties?.enableRbacAuthorization !== true) problems.push('Key Vault must use RBAC');
  for (const r of byType('Microsoft.ContainerService/managedClusters')) {
    const p = r.properties ?? {};
    if (p.disableLocalAccounts !== true || p.oidcIssuerProfile?.enabled !== true || p.securityProfile?.workloadIdentity?.enabled !== true) problems.push('AKS must disable local accounts and enable OIDC + workload identity');
  }
  if (allResources(template).some(r => r.type === 'Microsoft.KeyVault/vaults/secrets')) problems.push('templates must not create Key Vault secret values');
  return problems;
}

export function secretFindings(path, content) {
  const findings = [];
  for (const [pattern, label] of SECRET_PATTERNS) if (pattern.test(content)) findings.push(`${relative(root, path)}: ${label}`);
  if (path.endsWith('.bicepparam')) {
    const line = content.split(/\r?\n/).find(l => /^\s*param\s+postgresAdministratorPassword\b/.test(l));
    if (line && !/=\s*readEnvironmentVariable\('PP_PG_ADMIN_PASSWORD'\)\s*$/.test(line)) findings.push(`${relative(root, path)}: postgresAdministratorPassword must come from readEnvironmentVariable('PP_PG_ADMIN_PASSWORD')`);
  }
  return findings;
}

/** Service naming rules (learn.microsoft.com resource-name-rules); the 6-char suffix is uniqueString-derived. */
export function namingViolations(params) {
  const w = params.workloadName ?? 'pp', e = params.environmentName, base = `${w}-${e}`, suffix = 'abcdef';
  const problems = [];
  if (!/^[a-z][a-z0-9]{1,5}$/.test(w)) problems.push(`workloadName "${w}" must be 2-6 lowercase letters/digits starting with a letter`);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,88}[a-zA-Z0-9_-]$|^[a-zA-Z0-9]$/.test(params.resourceGroupName ?? '')) problems.push('resourceGroupName invalid (1-90 chars, no trailing period)');
  const rules = [
    ['container registry', `acr${w}${e}${suffix}`, /^[a-z0-9]{5,50}$/],
    ['storage account', `st${w}${e}${suffix}`, /^[a-z0-9]{3,24}$/],
    ['key vault', `kv-${base}-${suffix}`, /^(?!.*--)[a-zA-Z][a-zA-Z0-9-]{1,22}[a-zA-Z0-9]$/],
    ['PostgreSQL server', `psql-${base}-${suffix}`, /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/],
    ['Azure Managed Redis', `amr-${base}-${suffix}`, /^(?=.{1,60}$)[A-Za-z0-9]+(-[A-Za-z0-9]+)*$/],
    ['AKS cluster', `aks-${base}`, /^[a-zA-Z0-9][-_a-zA-Z0-9]{0,61}[a-zA-Z0-9]$/],
    ['AKS node resource group', `rg-${base}-aks-nodes`, /^.{1,80}$/],
    ['managed identity', `id-${base}-aks-control-plane`, /^[a-zA-Z0-9][a-zA-Z0-9_-]{2,127}$/],
    ['federated credential', 'aks-pp-otel-collector', /^[a-zA-Z0-9][a-zA-Z0-9_-]{2,119}$/],
    ['Redis access policy assignment', 'ingestion', /^[A-Za-z0-9]{1,60}$/]
  ];
  for (const [label, name, pattern] of rules) if (!pattern.test(name)) problems.push(`${label} name "${name}" violates ${pattern}`);
  for (const cidr of [...(params.operatorIpRanges ?? []), ...(params.aksAuthorizedIpRanges ?? [])]) if (!/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(cidr)) problems.push(`CIDR "${cidr}" invalid`);
  return problems;
}

function selfTest() {
  const base = JSON.parse(readFileSync(join(build, 'main.json'), 'utf8'));
  const planted = [
    ['preview API', t => { allResources(t).find(r => r.type === 'Microsoft.KeyVault/vaults').apiVersion = '2024-04-01-preview'; }],
    ['unverified role', t => { const s = JSON.stringify(t).replace('7f951dda-4ed3-4680-a7ca-43fe172d538d', '00000000-0000-0000-0000-000000000001'); Object.assign(t, JSON.parse(s)); }],
    ['public PostgreSQL', t => { allResources(t).find(r => r.type === 'Microsoft.DBforPostgreSQL/flexibleServers').properties.network.publicNetworkAccess = 'Enabled'; }],
    ['shared-key storage', t => { allResources(t).find(r => r.type === 'Microsoft.Storage/storageAccounts').properties.allowSharedKeyAccess = true; }],
    ['secret output', t => { t.outputs.adminPassword = { type: 'string', value: 'x' }; }],
    ['password default', t => { t.parameters.postgresAdministratorPassword.defaultValue = 'x'; }]
  ];
  for (const [label, mutate] of planted) { const t = structuredClone(base); mutate(t); record(`self-test detects ${label}`, policyViolations(t).length > 0); }
  record('self-test detects literal password in parameters', secretFindings('x.bicepparam', "param postgresAdministratorPassword = 'Sup3rSecretValue!'").length > 0);
  record('self-test detects database URL with password', secretFindings('x.md', 'postgresql://pp_migrator:hunter2hunter2@host/db').length > 0);
  record('self-test detects invalid workload name', namingViolations({ workloadName: 'PP_Dev', environmentName: 'dev', resourceGroupName: 'rg' }).length > 0);
  record('self-test detects over-long storage name', namingViolations({ workloadName: 'abcdefg', environmentName: 'prod', resourceGroupName: 'rg' }).length > 0);
}

const build = mkdtempSync(join(tmpdir(), 'pp-infra-'));
const version = run('az', ['bicep', 'version']);
if (!version.ok) { console.error('Azure CLI with Bicep is required: az bicep install'); process.exit(2); }
console.log(`${version.stdout.trim()} (${join('infra', 'azure')})`);

const compiled = run('az', ['bicep', 'build', '--file', join(infra, 'main.bicep'), '--outdir', build]);
record('bicep build main.bicep (zero diagnostics)', compiled.ok && compiled.diagnostics.length === 0, compiled.diagnostics.join(' | '));
const lint = run('az', ['bicep', 'lint', '--file', join(infra, 'main.bicep')]);
record('bicep lint (zero diagnostics)', lint.ok && lint.diagnostics.length === 0, lint.diagnostics.join(' | '));
const paramsOut = join(build, 'parameters.json');
const params = run('az', ['bicep', 'build-params', '--file', PARAMS, '--outfile', paramsOut], { env: { ...process.env, PP_PG_ADMIN_PASSWORD: PLACEHOLDER_PASSWORD } });
record(`bicep build-params ${relative(root, PARAMS)}`, params.ok && params.diagnostics.length === 0, params.diagnostics.join(' | '));

if (compiled.ok && params.ok) {
  const template = JSON.parse(readFileSync(join(build, 'main.json'), 'utf8'));
  const parameterFile = JSON.parse(readFileSync(paramsOut, 'utf8'));
  const values = Object.fromEntries(Object.entries(parameterFile.parameters).map(([k, v]) => [k, v.value]));
  const resources = allResources(template).filter(r => r.type !== 'Microsoft.Resources/deployments');
  const apiVersions = [...new Set(resources.map(r => `${r.type}@${r.apiVersion}`))].sort();
  console.log(`     ${resources.length} resource declarations, ${apiVersions.length} type/API pairs`);
  const policy = policyViolations(template);
  record('template policy (APIs, roles, private data services, no secret outputs)', policy.length === 0, policy.join('; '));
  const naming = namingViolations(values);
  record('naming constraints for dev parameters', naming.length === 0, naming.join('; '));
  const missing = Object.entries(template.parameters).filter(([k, p]) => !('defaultValue' in p) && !(k in values)).map(([k]) => k);
  record('every required parameter supplied', missing.length === 0, missing.join(', '));
  const findings = files(infra).concat(files(join(root, 'docs/azure'))).flatMap(path => secretFindings(path, readFileSync(path, 'utf8')));
  const paramValues = JSON.stringify(values).replaceAll(PLACEHOLDER_PASSWORD, '');
  findings.push(...secretFindings(paramsOut, paramValues));
  record('no secrets in infra files, docs or built parameters', findings.length === 0, findings.join('; '));
  const placeholders = JSON.stringify(values).match(/REPLACE_[A-Za-z0-9_@.-]*/g) ?? [];
  console.log(`     manual choices still open in ${relative(root, PARAMS)}: ${placeholders.length ? [...new Set(placeholders)].join(', ') : 'none'}`);

  if (args.has('--self-test')) selfTest();

  if (args.has('--azure')) {
    const token = run('az', ['account', 'get-access-token', '--query', 'expiresOn', '-o', 'tsv']);
    if (!token.ok) record('Azure validate/what-if', null, 'skipped: Azure CLI is not signed in with a usable token (az login)');
    else if (placeholders.length) record('Azure validate/what-if', null, 'skipped: replace the REPLACE_ manual choices first');
    else if (!process.env.PP_PG_ADMIN_PASSWORD) record('Azure validate/what-if', null, 'skipped: export PP_PG_ADMIN_PASSWORD (see docs/azure/provisioning.md)');
    else {
      const common = ['--location', values.location, '--template-file', join(infra, 'main.bicep'), '--parameters', PARAMS];
      const validate = run('az', ['deployment', 'sub', 'validate', ...common, '--name', 'pp-validate']);
      record('az deployment sub validate (preflight, read-only)', validate.ok, validate.ok ? '' : validate.diagnostics.slice(-3).join(' | '));
      const whatIf = run('az', ['deployment', 'sub', 'what-if', ...common, '--name', 'pp-whatif', '--no-pretty-print'], { maxBuffer: 64 * 1024 * 1024 });
      if (whatIf.ok) writeFileSync(join(build, 'what-if.json'), whatIf.stdout);
      record('az deployment sub what-if (read-only)', whatIf.ok, whatIf.ok ? `saved ${join(build, 'what-if.json')}` : whatIf.diagnostics.slice(-3).join(' | '));
    }
  }
}

const failed = results.filter(r => r.ok === false).length, skipped = results.filter(r => r.ok === null).length;
console.log(`\nvalidate:infra ${results.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped (output: ${build})`);
process.exit(failed ? 1 : 0);
