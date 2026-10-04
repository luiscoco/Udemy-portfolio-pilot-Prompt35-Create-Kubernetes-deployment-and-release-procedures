// `npm run validate:k8s` (milestone 35) — static validation of deploy/kubernetes; needs only kubectl
// (for `kubectl kustomize`) and touches no cluster.
//   1. Every overlay renders (AKS with release.env.example, or --release-env <file> for a real release).
//   2. Pod policy: restricted Pod Security fields, non-root, read-only root, no token, requests/limits,
//      probes, termination grace above each role's drain deadline, PDBs that cannot block a node drain.
//   3. Release policy: images pinned by digest (AKS), no Kubernetes Secret objects or secretKeyRefs in AKS,
//      no secret-looking literals, no placeholder left, migration Job one-shot and release-named.
//   4. Identity: each pod's service account annotation equals the clientID of every Key Vault class it
//      mounts; workload identity label wherever a class or Entra sign-in is used.
//   5. Routing: one HTTPS origin, /api/events with the route timeout disabled ahead of the bounded /api
//      rule, backends that exist, HTTP only redirecting.
//   6. Configuration: each workload's rendered environment passes the application's own server config
//      schema (packages/config), with workload-identity and Key Vault values simulated.
// Options: --release-env <file> (also refuses example values)   --self-test (plant violations)
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { K8S, ROOT, kustomize, parseManifests, readEnvFile, releaseEnvProblems } from './k8s-lib.mjs';

const args = process.argv.slice(2);
const releaseEnvArg = args.includes('--release-env') ? args[args.indexOf('--release-env') + 1] : null;
const results = [];
const record = (name, problems, detail = '') => {
  results.push({ name, ok: problems.length === 0 });
  console.log(`${problems.length ? 'FAIL' : 'PASS'} ${name}${detail ? ` — ${detail}` : ''}`);
  for (const problem of problems.slice(0, 25)) console.log(`     - ${problem}`);
};

const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/\bsk-ant-[A-Za-z0-9_-]{10,}/, 'Anthropic API key'],
  [/postgres(ql)?:\/\/[^:\s'"/@]+:[^@\s'"]+@/, 'database URL with password'],
  [/rediss?:\/\/[^:\s'"/@]*:[^@\s'"]+@/, 'Redis URL with password'],
  [/AccountKey=[A-Za-z0-9+/=]{20,}/, 'storage account key'],
  [/InstrumentationKey=[0-9a-f-]{36}/i, 'Application Insights key']
];
const podSpecOf = o => o.kind === 'Job' ? o.spec.template.spec : ['Deployment', 'StatefulSet'].includes(o.kind) ? o.spec.template.spec : null;
const podLabelsOf = o => o.spec?.template?.metadata?.labels ?? {};
const ms = value => Number(value ?? NaN);

/** Pod-level policy shared by every environment. Returns problem strings. */
export function podProblems(objects, { environment }) {
  const problems = [];
  const configMaps = Object.fromEntries(objects.filter(o => o.kind === 'ConfigMap').map(o => [o.metadata.name, o.data ?? {}]));
  const workloads = objects.filter(podSpecOf).filter(o => podLabelsOf(o)['app.kubernetes.io/part-of'] === 'portfolio-pilot');
  const local = environment === 'local';
  for (const o of workloads) {
    const id = `${o.kind}/${o.metadata.name}`;
    const spec = podSpecOf(o);
    const component = podLabelsOf(o)['app.kubernetes.io/component'];
    const pod = spec.securityContext ?? {};
    if (pod.runAsNonRoot !== true) problems.push(`${id}: runAsNonRoot must be true`);
    if (!(pod.runAsUser > 0)) problems.push(`${id}: runAsUser must be a non-zero UID`);
    if (pod.seccompProfile?.type !== 'RuntimeDefault') problems.push(`${id}: seccompProfile RuntimeDefault required`);
    if (spec.automountServiceAccountToken !== false) problems.push(`${id}: automountServiceAccountToken must be false`);
    if (spec.hostNetwork || spec.hostPID || spec.hostIPC) problems.push(`${id}: host namespaces are forbidden`);
    if ((spec.volumes ?? []).some(v => v.hostPath)) problems.push(`${id}: hostPath volumes are forbidden`);
    for (const c of [...(spec.initContainers ?? []), ...spec.containers]) {
      const cid = `${id}[${c.name}]`;
      const sc = c.securityContext ?? {};
      if (sc.allowPrivilegeEscalation !== false) problems.push(`${cid}: allowPrivilegeEscalation must be false`);
      if (sc.readOnlyRootFilesystem !== true) problems.push(`${cid}: readOnlyRootFilesystem must be true`);
      if (sc.privileged) problems.push(`${cid}: privileged is forbidden`);
      if (!(sc.capabilities?.drop ?? []).includes('ALL') || (sc.capabilities?.add ?? []).length) problems.push(`${cid}: capabilities must drop ALL and add none`);
      for (const kind of ['requests', 'limits']) for (const resource of ['cpu', 'memory']) {
        if (!c.resources?.[kind]?.[resource]) problems.push(`${cid}: resources.${kind}.${resource} missing`);
      }
      const image = c.image ?? '';
      if (/:latest$/.test(image) || !/[:@]/.test(image.split('/').at(-1))) problems.push(`${cid}: image "${image}" is not pinned`);
      if (!local && !/@sha256:[0-9a-f]{64}$/.test(image)) problems.push(`${cid}: AKS images must be pinned by digest (${image})`);
      if (!local && (c.env ?? []).some(e => e.valueFrom?.secretKeyRef)) problems.push(`${cid}: secretKeyRef in AKS (secrets come from Key Vault files)`);
      if (o.kind === 'Deployment' && component !== 'certificate-sync') {
        for (const probe of ['readinessProbe', 'livenessProbe', 'startupProbe']) if (!c[probe]) problems.push(`${cid}: ${probe} missing`);
      }
      // Termination grace must exceed the process's own drain deadline (+ preStop delay).
      const env = Object.assign({}, ...(c.envFrom ?? []).map(ref => configMaps[ref.configMapRef?.name] ?? {}));
      const preStop = c.lifecycle?.preStop?.sleep?.seconds ?? 0;
      const drainMs = env.WORKER_ROLE ? ms(env.WORKER_SHUTDOWN_GRACE_MS ?? 25000) : env.API_SHUTDOWN_GRACE_MS ? ms(env.API_SHUTDOWN_GRACE_MS) : null;
      const grace = spec.terminationGracePeriodSeconds ?? 30;
      if (drainMs !== null && grace * 1000 <= drainMs + preStop * 1000 + 2000) problems.push(`${cid}: terminationGracePeriodSeconds ${grace} does not exceed drain ${drainMs} ms + preStop ${preStop} s + 2 s`);
      if (env.WORKER_ROLE && env.WORKER_HEALTH_HOST !== '0.0.0.0' && c.readinessProbe) problems.push(`${cid}: worker probes need WORKER_HEALTH_HOST=0.0.0.0`);
    }
    if (o.kind === 'Deployment') {
      if (component !== 'certificate-sync') {
        const pdb = objects.find(p => p.kind === 'PodDisruptionBudget' && Object.entries(p.spec.selector.matchLabels ?? {}).every(([k, v]) => podLabelsOf(o)[k] === v));
        if (!pdb) problems.push(`${id}: no PodDisruptionBudget`);
        const replicas = o.spec.replicas ?? 1;
        if (pdb?.spec.minAvailable !== undefined && pdb.spec.minAvailable >= replicas && !objects.some(h => h.kind === 'HorizontalPodAutoscaler' && h.spec.scaleTargetRef.name === o.metadata.name))
          problems.push(`${id}: PDB minAvailable ${pdb.spec.minAvailable} with ${replicas} replica(s) blocks node drains`);
      }
      if (o.spec.strategy?.rollingUpdate && o.spec.strategy.rollingUpdate.maxUnavailable !== 0 && ['frontend', 'api'].includes(component)) problems.push(`${id}: serving Deployments roll with maxUnavailable 0`);
      if (objects.some(h => h.kind === 'HorizontalPodAutoscaler' && h.spec.scaleTargetRef.name === o.metadata.name) && o.spec.replicas !== undefined)
        problems.push(`${id}: autoscaled Deployment must not set replicas (every apply would reset the HPA)`);
    }
  }
  if (!objects.some(o => o.kind === 'NetworkPolicy' && o.metadata.name === 'default-deny' && o.spec.podSelector?.matchLabels?.['app.kubernetes.io/part-of'] === 'portfolio-pilot'
    && ['Ingress', 'Egress'].every(t => o.spec.policyTypes.includes(t)) && !o.spec.ingress && !o.spec.egress)) problems.push('default-deny NetworkPolicy (ingress and egress) missing');
  return problems;
}

/** Secrets, placeholders and identities (environment-aware). */
export function releaseProblems(objects, { environment }) {
  const problems = [];
  const text = JSON.stringify(objects);
  if (/RELEASE_PARAMETER|portfolio-pilot\.invalid/.test(text)) problems.push('a release placeholder survived rendering');
  for (const o of objects) {
    const scan = JSON.stringify(o.kind === 'Secret' ? {} : o);
    for (const [pattern, label] of SECRET_PATTERNS) if (pattern.test(scan)) problems.push(`${o.kind}/${o.metadata.name}: contains a ${label}`);
  }
  if (environment !== 'aks') return problems;
  for (const o of objects.filter(o => o.kind === 'Secret')) problems.push(`Secret/${o.metadata.name}: application secrets must come from Key Vault, not Kubernetes Secrets`);
  const accounts = Object.fromEntries(objects.filter(o => o.kind === 'ServiceAccount').map(o => [o.metadata.name, o]));
  const classes = Object.fromEntries(objects.filter(o => o.kind === 'SecretProviderClass').map(o => [o.metadata.name, o]));
  for (const o of objects.filter(podSpecOf)) {
    const id = `${o.kind}/${o.metadata.name}`;
    const spec = podSpecOf(o);
    const account = accounts[spec.serviceAccountName];
    const clientId = account?.metadata.annotations?.['azure.workload.identity/client-id'];
    const mounted = (spec.volumes ?? []).filter(v => v.csi?.driver === 'secrets-store.csi.k8s.io').map(v => v.csi.volumeAttributes.secretProviderClass);
    const env = Object.assign({}, ...spec.containers.flatMap(c => (c.envFrom ?? []).map(r => objects.find(m => m.kind === 'ConfigMap' && m.metadata.name === r.configMapRef?.name)?.data ?? {})));
    const usesEntra = env.DATABASE_AUTH === 'azure-workload-identity' || mounted.length > 0;
    if (usesEntra && podLabelsOf(o)['azure.workload.identity/use'] !== 'true') problems.push(`${id}: workload identity label missing`);
    if (usesEntra && !clientId) problems.push(`${id}: service account ${spec.serviceAccountName} has no workload identity client-id`);
    for (const name of mounted) {
      const spc = classes[name];
      if (!spc) { problems.push(`${id}: SecretProviderClass ${name} not rendered`); continue; }
      if (spc.spec.parameters.clientID !== clientId) problems.push(`${id}: mounts ${name} whose clientID is not this pod's own identity`);
      if (spc.spec.parameters.usePodIdentity !== 'false' || spc.spec.parameters.useVMManagedIdentity === 'true') problems.push(`${name}: must authenticate with workload identity only`);
      if (spc.spec.secretObjects && name !== 'gateway-tls') problems.push(`${name}: only the gateway certificate may sync to a Kubernetes Secret`);
    }
  }
  const ids = Object.values(accounts).map(a => a.metadata.annotations?.['azure.workload.identity/client-id']).filter(Boolean);
  if (new Set(ids).size !== ids.length) problems.push('two service accounts share one identity');
  for (const job of objects.filter(o => o.kind === 'Job')) {
    if (job.spec.backoffLimit !== 0) problems.push(`Job/${job.metadata.name}: migrations must not retry automatically (backoffLimit 0)`);
    if (!/^db-migrate-[a-z0-9]/.test(job.metadata.name) || job.metadata.name === 'db-migrate-release') problems.push(`Job/${job.metadata.name}: name must carry the release ID`);
  }
  for (const ns of objects.filter(o => o.kind === 'Namespace')) {
    const labels = ns.metadata.labels ?? {};
    if (!['baseline', 'restricted'].includes(labels['pod-security.kubernetes.io/enforce']) || labels['pod-security.kubernetes.io/warn'] !== 'restricted') problems.push(`Namespace/${ns.metadata.name}: Pod Security labels`);
  }
  return problems;
}

/** One origin: TLS listener, SSE route first with timeout 0s, bounded /api, frontend, redirect-only HTTP. */
export function routingProblems(objects) {
  const problems = [];
  const gateways = objects.filter(o => o.kind === 'Gateway');
  if (gateways.length !== 1) return ['exactly one Gateway expected'];
  const [gateway] = gateways;
  const https = gateway.spec.listeners.find(l => l.protocol === 'HTTPS');
  const http = gateway.spec.listeners.find(l => l.protocol === 'HTTP');
  if (!https || https.port !== 443 || https.tls?.mode !== 'Terminate' || !https.tls.certificateRefs?.length) problems.push('HTTPS listener on 443 terminating TLS required');
  const hostnames = new Set(gateway.spec.listeners.map(l => l.hostname));
  if (hostnames.size !== 1) problems.push('all listeners must serve the one public host name');
  const routes = objects.filter(o => o.kind === 'HTTPRoute');
  const services = Object.fromEntries(objects.filter(o => o.kind === 'Service').map(s => [s.metadata.name, s]));
  for (const route of routes) {
    if (!route.spec.hostnames?.every(h => hostnames.has(h))) problems.push(`HTTPRoute/${route.metadata.name}: host name differs from the Gateway`);
    const toHttp = route.spec.parentRefs.some(p => p.sectionName === http?.name);
    if (toHttp && route.spec.rules.some(r => r.backendRefs?.length || !r.filters?.some(f => f.type === 'RequestRedirect' && f.requestRedirect.scheme === 'https'))) problems.push(`HTTPRoute/${route.metadata.name}: the HTTP listener may only redirect to HTTPS`);
    for (const rule of route.spec.rules) for (const ref of rule.backendRefs ?? []) {
      if (!services[ref.name]?.spec.ports.some(p => p.port === ref.port)) problems.push(`HTTPRoute/${route.metadata.name}: backend ${ref.name}:${ref.port} does not exist`);
    }
  }
  const main = routes.find(r => r.spec.parentRefs.some(p => p.sectionName === https?.name));
  if (!main) return [...problems, 'no HTTPS route'];
  const rules = main.spec.rules.map(rule => ({ rule, path: rule.matches?.[0]?.path ?? {} }));
  const events = rules.findIndex(r => r.path.type === 'Exact' && r.path.value === '/api/events');
  const apiRule = rules.findIndex(r => r.path.type === 'PathPrefix' && r.path.value === '/api');
  const web = rules.findIndex(r => r.path.type === 'PathPrefix' && r.path.value === '/');
  if (events < 0 || rules[events].rule.timeouts?.request !== '0s') problems.push('/api/events needs its own rule with timeouts.request 0s (long-lived SSE)');
  if (events >= 0 && rules[events].rule.backendRefs?.[0]?.name !== 'api') problems.push('/api/events must route to the API');
  if (apiRule < 0 || !/^[1-9][0-9]*s$/.test(rules[apiRule].rule.timeouts?.request ?? '')) problems.push('/api needs a bounded request timeout');
  if (apiRule >= 0 && rules[apiRule].rule.backendRefs?.[0]?.name !== 'api') problems.push('/api must route to the API');
  if (web < 0 || rules[web].rule.backendRefs?.[0]?.name !== 'web') problems.push('/ must route to the static frontend');
  return problems;
}

/** Each workload's environment through the application's own config schema. */
export async function configProblems(objects, { environment }) {
  const { parseServerConfig } = await import(new URL('../packages/config/dist/server.js', import.meta.url).href);
  const problems = [];
  const configMaps = Object.fromEntries(objects.filter(o => o.kind === 'ConfigMap').map(o => [o.metadata.name, o.data ?? {}]));
  const classes = Object.fromEntries(objects.filter(o => o.kind === 'SecretProviderClass').map(o => [o.metadata.name, o]));
  const fake = () => randomBytes(30).toString('base64url');
  for (const o of objects.filter(podSpecOf).filter(o => o.kind === 'Deployment')) {
    const spec = podSpecOf(o);
    for (const c of spec.containers.filter(c => c.envFrom)) {
      const env = Object.assign({}, ...c.envFrom.map(r => configMaps[r.configMapRef.name] ?? {}));
      for (const e of c.env ?? []) env[e.name] = e.value ?? (e.valueFrom?.fieldRef ? `${o.metadata.name}-0` : fake());
      // Simulated runtime injections: Key Vault files (named by objectAlias) and the workload identity webhook.
      for (const v of spec.volumes ?? []) {
        const spc = classes[v.csi?.volumeAttributes?.secretProviderClass];
        for (const alias of spc?.spec.parameters.objects.matchAll(/objectAlias: (\w+)/g) ?? []) env[alias[1]] = fake();
        if (v.secret) for (const key of ['AUTH_SECRET', 'OBSERVABILITY_ACTOR_KEY']) env[key] = fake();
        if (v.secret) env.DATABASE_URL = 'postgresql://portfolio:simulated@postgres:5432/portfolio_pilot';
      }
      if (podLabelsOf(o)['azure.workload.identity/use'] === 'true') Object.assign(env, { AZURE_CLIENT_ID: '5f0c8a1e-3b7d-4c2a-9e61-0d4b7a2c9f13',
        AZURE_TENANT_ID: '8a2d4c6e-1f3b-4a5d-8c7e-9b0a1d2e3f45', AZURE_FEDERATED_TOKEN_FILE: '/var/run/secrets/azure/tokens/azure-identity-token', AZURE_AUTHORITY_HOST: 'https://login.microsoftonline.com/' });
      if (!Object.keys(env).length) continue;
      try { parseServerConfig(env); }
      catch (error) { problems.push(`${o.metadata.name}[${c.name}] (${environment}): ${(error.issues ?? [{ message: error.message }]).map(i => `${i.path?.join('.') ?? ''} ${i.message}`).join('; ')}`); }
      if (environment === 'aks') {
        if (env.NODE_ENV !== 'production' || env.DEMO_AUTH_ENABLED === 'true') problems.push(`${o.metadata.name}: AKS must run the production profile without demo authentication`);
        const host = objects.find(g => g.kind === 'Gateway')?.spec.listeners[0].hostname;
        if (env.AUTH_BASE_URL !== `https://${host}`) problems.push(`${o.metadata.name}: AUTH_BASE_URL ${env.AUTH_BASE_URL} is not the gateway origin https://${host}`);
      }
    }
  }
  return problems;
}

/** Renders every unit; the AKS units from a temporary copy holding the chosen release.env. */
export function renderAll(releaseEnvPath) {
  const temp = mkdtempSync(join(tmpdir(), 'pp-k8s-'));
  try {
    cpSync(K8S, join(temp, 'k8s'), { recursive: true, filter: source => !source.endsWith('release.env') });
    cpSync(releaseEnvPath, join(temp, 'k8s', 'overlays', 'aks', 'release.env'));
    const dir = name => join(temp, 'k8s', 'overlays', name);
    return {
      aks: parseManifests(kustomize(dir('aks'))),
      'aks-migrate': parseManifests(kustomize(dir('aks-migrate'), { shareReleaseEnv: true })),
      local: parseManifests(kustomize(dir('local'))),
      'local-migrate': parseManifests(kustomize(dir('local-migrate'))),
      'local-data': parseManifests(kustomize(dir('local-data')))
    };
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

async function validate(units, label = '') {
  const env = name => name.startsWith('aks') ? 'aks' : 'local';
  const before = results.length;
  for (const [name, objects] of Object.entries(units)) {
    if (name === 'local-data') { record(`${label}${name}: pod policy`, podProblems(objects, { environment: 'local' }).filter(p => !p.includes('PodDisruptionBudget') && !p.includes('Probe missing'))); continue; }
    record(`${label}${name}: pod policy`, podProblems(objects, { environment: env(name) }));
    record(`${label}${name}: secrets, placeholders and identities`, releaseProblems(objects, { environment: env(name) }));
    if (!name.endsWith('migrate')) {
      record(`${label}${name}: single HTTPS origin and SSE routing`, routingProblems(objects));
      record(`${label}${name}: workload configuration passes the server config schema`, await configProblems(objects, { environment: env(name) }));
    }
  }
  return results.slice(before).every(r => r.ok);
}

async function selfTest(units) {
  const clone = value => structuredClone(value);
  const find = (objects, kind, name) => objects.find(o => o.kind === kind && o.metadata.name === name);
  const plants = [
    ['privileged container', u => { podSpecOf(find(u.aks, 'Deployment', 'api')).containers[0].securityContext.privileged = true; }],
    ['writable root filesystem', u => { podSpecOf(find(u.aks, 'Deployment', 'web')).containers[0].securityContext.readOnlyRootFilesystem = false; }],
    ['missing memory limit', u => { delete podSpecOf(find(u.aks, 'Deployment', 'worker-agent')).containers[0].resources.limits.memory; }],
    ['mutable image tag in AKS', u => { podSpecOf(find(u.aks, 'Deployment', 'api')).containers[0].image = 'acrx.azurecr.io/portfolio-pilot/api:latest'; }],
    ['Kubernetes Secret in AKS', u => { u.aks.push({ apiVersion: 'v1', kind: 'Secret', metadata: { name: 'leak' }, stringData: { AUTH_SECRET: 'x' } }); }],
    ['secret in a ConfigMap', u => { u.aks.find(o => o.kind === 'ConfigMap').data.DATABASE_URL = 'postgresql://pp:hunter22@db:5432/x'; }],
    ['pod reading another identity\'s Key Vault class', u => { find(u.aks, 'SecretProviderClass', 'agent-secrets').spec.parameters.clientID = '3c9e7a51-2d4f-4b6a-8e1c-7f0a9b2d4e68'; }],
    ['SSE route timeout not disabled', u => { find(u.aks, 'HTTPRoute', 'portfolio-pilot').spec.rules[0].timeouts.request = '60s'; }],
    ['termination grace below the drain deadline', u => { podSpecOf(find(u.aks, 'Deployment', 'worker-agent')).terminationGracePeriodSeconds = 60; }],
    ['single-replica PDB that blocks drains', u => { find(u.aks, 'PodDisruptionBudget', 'worker-outbox').spec = { minAvailable: 1, selector: find(u.aks, 'PodDisruptionBudget', 'worker-outbox').spec.selector }; }],
    ['placeholder left unreplaced', u => { find(u.aks, 'ServiceAccount', 'pp-api').metadata.annotations['azure.workload.identity/client-id'] = 'RELEASE_PARAMETER'; }],
    ['migration Job retries automatically', u => { u['aks-migrate'].find(o => o.kind === 'Job').spec.backoffLimit = 3; }],
    ['invalid workload configuration (partial Entra settings)', u => { const cm = u.aks.find(o => o.kind === 'ConfigMap' && o.metadata.name.startsWith('api-config')); delete cm.data.ENTRA_TENANT_ID; }],
    ['autoscaled Deployment with replicas', u => { find(u.aks, 'Deployment', 'api').spec.replicas = 2; }],
    ['token automounted', u => { podSpecOf(find(u.local, 'Deployment', 'worker-ingestion')).automountServiceAccountToken = true; }]
  ];
  for (const [name, plant] of plants) {
    const copy = clone(units);
    plant(copy);
    const quiet = console.log; console.log = () => {};
    const before = results.length;
    let ok;
    try { ok = await validate(copy, 'self-test: '); } finally { console.log = quiet; results.length = before; }
    record(`self-test detects ${name}`, ok ? ['the planted violation was not detected'] : []);
  }
}

if (!existsSync(new URL('../packages/config/dist/server.js', import.meta.url))) {
  console.error('packages/config is not built: run `npm run build --workspace @portfolio-pilot/config` first.'); process.exit(2);
}
const releaseEnv = releaseEnvArg ?? join(K8S, 'overlays', 'aks', 'release.env.example');
record(`release parameters (${releaseEnvArg ? releaseEnvArg : 'committed example'})`, releaseEnvProblems(readEnvFile(releaseEnv), { allowExample: !releaseEnvArg }));
let units;
try { units = renderAll(releaseEnv); record('every overlay renders (aks, aks-migrate, local, local-migrate, local-data)', []); }
catch (error) { record('every overlay renders', [error.message]); }
if (units) {
  await validate(units);
  if (args.includes('--self-test')) await selfTest(units);
  writeFileSync(join(tmpdir(), 'pp-k8s-rendered.json'), JSON.stringify(units, null, 1));
}
const failed = results.filter(r => !r.ok).length;
console.log(`\nvalidate:k8s ${results.length - failed} passed, ${failed} failed (rendered objects: ${join(tmpdir(), 'pp-k8s-rendered.json')}; root ${ROOT})`);
process.exitCode = failed ? 1 : 0;
