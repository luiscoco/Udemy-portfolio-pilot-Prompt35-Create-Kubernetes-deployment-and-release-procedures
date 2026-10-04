// `npm run verify:k8s-local` (milestone 35): the Kubernetes release on a throwaway local cluster.
// kind (Kubernetes 1.35, two workers, kindnet NetworkPolicy) + upstream Istio 1.30 as the Gateway API
// implementation (the AKS add-on runs the same Envoy/Istio Gateway controller under the class
// `approuting-istio`). Uses the locally built release images (`docker compose -f compose.production.yaml
// build`), no cloud resources and no credentials. It checks:
//   - the release order of scripts/k8s-lib.mjs: server dry run -> migration Job awaited -> application;
//   - pod posture, Pod Security admission and the NetworkPolicy matrix;
//   - the public origin, demo sign-in, trade -> SSE, and a long idle SSE stream (default 330 s);
//   - a rolling API restart under SSE and request load (no failed request, the stream resumes);
//   - every worker role draining on rollout, with an agent run in flight completing;
//   - a node drain honouring the PodDisruptionBudgets with no failed request;
//   - the AKS overlays accepted by a real API server (server-side dry run).
// Usage: npm run verify:k8s-local [-- --reuse] [-- --keep] [-- --hold-seconds 330]
// Tools: kubectl, plus kind and istioctl on PATH or in .local/tools (see docs/kubernetes/local-verification.md).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { K8S, kubectlFor, kustomize, parseManifests, releaseToCluster, run, tool } from './k8s-lib.mjs';
import { client, recordTrade, smoke, waitFor } from './k8s-smoke.mjs';

const args = process.argv.slice(2);
const CLUSTER = 'pp-m35', CONTEXT = `kind-${CLUSTER}`, NS = 'portfolio-pilot';
const HTTPS_PORT = 8443, HTTP_PORT = 8480, ORIGIN = `https://localhost:${HTTPS_PORT}`;
const ISTIO = '1.30.5', GATEWAY_API = 'v1.4.1', CSI_DRIVER = 'v1.6.1';
const holdSeconds = Number(args.includes('--hold-seconds') ? args[args.indexOf('--hold-seconds') + 1] : 330);
const log = (...parts) => console.log(new Date().toISOString().slice(11, 23), ...parts);

// Node's fetch trusts only system CAs: re-run this script with the throwaway CA added.
if (!process.env.PP_K8S_LOCAL_CA) {
  const dir = mkdtempSync(join(tmpdir(), 'pp-k8s-tls-'));
  const openssl = ['openssl', 'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe', 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe'].find(candidate => spawnSync(candidate, ['version']).status === 0);
  if (!openssl) { console.error('openssl is required to create the throwaway TLS certificate'); process.exit(2); }
  run(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost',
    '-keyout', join(dir, 'tls.key'), '-out', join(dir, 'tls.crt')], { env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...args], { stdio: 'inherit',
    env: { ...process.env, PP_K8S_LOCAL_CA: dir, NODE_EXTRA_CA_CERTS: join(dir, 'tls.crt') } });
  rmSync(dir, { recursive: true, force: true });
  process.exit(child.status ?? 1);
}
const CA_DIR = process.env.PP_K8S_LOCAL_CA;
const kubectl = kubectlFor(CONTEXT);
const k = (rest, options) => kubectl(['-n', NS, ...rest], options);
const kind = (rest, options) => run(tool('kind'), rest, options);
const results = [];
async function check(name, body) {
  const started = Date.now();
  try { const detail = await body(); results.push({ name, ok: true, seconds: Math.round((Date.now() - started) / 1000), ...(detail ? { detail } : {}) }); log(`PASS ${name}`); }
  catch (error) { results.push({ name, ok: false, error: error.message }); log(`FAIL ${name}: ${error.stack ?? error}`); throw error; }
}
const json = rest => JSON.parse(k([...rest, '-o', 'json']).stdout);
const pods = selector => json(['get', 'pods', '-l', selector]).items;
const appPods = () => pods('app.kubernetes.io/part-of=portfolio-pilot').filter(p => p.status.phase === 'Running' && !['postgres', 'redis'].includes(p.metadata.labels['app.kubernetes.io/name']));

/** Side-loads an image into every node; pulled multi-platform images are saved for one platform. */
function loadImage(image, { pull = false } = {}) {
  const nodes = kind(['get', 'nodes', '--name', CLUSTER]).stdout.split(/\s+/).filter(Boolean);
  const reference = image.includes('/') ? image : `docker.io/library/${image}`;
  const present = node => JSON.parse(run('docker', ['exec', node, 'crictl', 'images', '-o', 'json']).stdout).images.some(i => (i.repoTags ?? []).includes(reference));
  if (nodes.every(present)) return;
  if (pull && run('docker', ['image', 'inspect', image], { allowFailure: true }).status !== 0) run('docker', ['pull', '-q', '--platform', 'linux/amd64', image]);
  const dir = mkdtempSync(join(tmpdir(), 'pp-kind-image-'));
  try {
    run('docker', ['save', '--platform', 'linux/amd64', '-o', join(dir, 'image.tar'), image]);
    kind(['load', 'image-archive', '--name', CLUSTER, join(dir, 'image.tar')], { timeoutMs: 15 * 60_000 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

let portForward = null;
async function forwardTo(pod) {
  portForward?.kill();
  const child = spawn('kubectl', ['--context', CONTEXT, '-n', NS, 'port-forward', `pod/${pod}`, `${HTTPS_PORT}:443`, `${HTTP_PORT}:80`], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('port-forward did not start')), 20000);
    child.stdout.on('data', data => { if (/Forwarding from/.test(data)) { clearTimeout(timer); resolve(); } });
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`port-forward exited ${code}`)); });
  });
  child.removeAllListeners('exit');
  portForward = child;
  await waitFor('origin reachable', async () => (await fetch(`${ORIGIN}/api/health/live`)).ok, 20000);
}
const gatewayPod = () => pods('gateway.networking.k8s.io/gateway-name=portfolio-pilot').find(p => p.status.phase === 'Running' && !p.metadata.deletionTimestamp);

/** Authenticated requests every 100 ms; "not processed" 503s (draining replica, safe to retry) are counted apart. */
function startLoad(api, cookie) {
  const load = { ok: 0, notProcessed: 0, failures: [], stop: false };
  load.done = (async () => {
    while (!load.stop) {
      try {
        const response = await api.call(cookie, '/api/portfolios');
        if (response.status === 200) load.ok++;
        else if (response.status === 503 && response.headers.get('x-portfolio-pilot-not-processed')) load.notProcessed++;
        else load.failures.push(`${response.status} ${response.text.slice(0, 120)}`);
      } catch (error) { load.failures.push(`${error.cause?.code ?? error.message}`); }
      await sleep(100);
    }
  })();
  return load;
}
function tcp(pod, container, host, port) {
  const probe = container === 'web'
    ? ['sh', '-c', `nc -z -w 3 ${host} ${port}`]
    : ['node', '-e', `const s=require('net').connect(${port},'${host}');s.setTimeout(3000);s.on('connect',()=>process.exit(0));s.on('timeout',()=>process.exit(1));s.on('error',()=>process.exit(1))`];
  return k(['exec', pod, '-c', container, '--', ...probe], { allowFailure: true }).status === 0;
}

let failed = false;
try {
  await check('preflight: tools and locally built release images', () => {
    for (const image of ['web', 'api', 'worker', 'migrate']) assert.equal(run('docker', ['image', 'inspect', `portfolio-pilot-${image}:local`], { allowFailure: true }).status, 0,
      `portfolio-pilot-${image}:local missing: run docker compose -f compose.production.yaml build`);
    const istioctl = run(tool('istioctl'), ['version', '--remote=false'], { allowFailure: true }).stdout.trim();
    assert.ok(istioctl.includes(ISTIO), `istioctl ${ISTIO} required (found: ${istioctl || 'none'})`);
    return { kind: run(tool('kind'), ['version']).stdout.trim(), istioctl, kubectl: run('kubectl', ['version', '--client', '-o', 'json']).stdout.match(/"gitVersion": "([^"]+)"/)[1] };
  });

  await check('cluster: kind 1.35 (1 control plane, 2 workers), Gateway API v1.4.1 standard, Istio minimal', () => {
    const exists = kind(['get', 'clusters']).stdout.split(/\s+/).includes(CLUSTER);
    if (exists && args.includes('--reuse')) {
      kubectl(['delete', 'namespace', NS, '--ignore-not-found', '--wait=true', '--timeout=180s']);
    } else {
      if (exists) kind(['delete', 'cluster', '--name', CLUSTER]);
      kind(['create', 'cluster', '--config', join(K8S, 'local', 'kind-cluster.yaml'), '--wait', '180s'], { timeoutMs: 10 * 60_000 });
    }
    kubectl(['apply', '--server-side', '-f', `https://github.com/kubernetes-sigs/gateway-api/releases/download/${GATEWAY_API}/standard-install.yaml`]);
    // Only for the server-side dry run of the AKS overlays (the AKS add-on installs the real driver).
    kubectl(['apply', '--server-side', '-f', `https://raw.githubusercontent.com/kubernetes-sigs/secrets-store-csi-driver/${CSI_DRIVER}/deploy/secrets-store.csi.x-k8s.io_secretproviderclasses.yaml`]);
    for (const image of [`registry.istio.io/release/pilot:${ISTIO}`, `registry.istio.io/release/proxyv2:${ISTIO}`]) loadImage(image, { pull: true });
    run(tool('istioctl'), ['--context', CONTEXT, 'install', '--set', 'profile=minimal', '-y'], { timeoutMs: 5 * 60_000 });
    for (const image of ['postgres:17.6-alpine', 'redis:7.4.5-alpine']) loadImage(image, { pull: true });
    for (const image of ['web', 'api', 'worker', 'migrate']) kind(['load', 'docker-image', '--name', CLUSTER, `portfolio-pilot-${image}:local`], { timeoutMs: 15 * 60_000 });
    const nodes = JSON.parse(kubectl(['get', 'nodes', '-o', 'json']).stdout).items.map(n => `${n.metadata.name}@${n.status.nodeInfo.kubeletVersion}`);
    return { nodes };
  });

  const password = randomBytes(18).toString('hex');
  const databaseUrl = `postgresql://portfolio:${password}@postgres:5432/portfolio_pilot`;
  await check('local data services up under the same Pod Security labels (unprivileged, read-only)', () => {
    kubectl(['apply', '--server-side', '-f', '-'], { input: kustomize(join(K8S, 'overlays', 'local-data')) });
    k(['create', 'secret', 'generic', 'local-postgres', `--from-literal=password=${password}`]);
    k(['create', 'secret', 'generic', 'local-migrate', `--from-literal=DATABASE_URL=${databaseUrl}`]);
    k(['create', 'secret', 'generic', 'local-app', `--from-literal=DATABASE_URL=${databaseUrl}`,
      `--from-literal=AUTH_SECRET=${randomBytes(33).toString('base64')}`, `--from-literal=OBSERVABILITY_ACTOR_KEY=${randomBytes(33).toString('base64')}`]);
    k(['create', 'secret', 'tls', 'portfolio-pilot-tls', `--cert=${join(CA_DIR, 'tls.crt')}`, `--key=${join(CA_DIR, 'tls.key')}`]);
    k(['rollout', 'status', 'statefulset/postgres', '--timeout=180s']); k(['rollout', 'status', 'deploy/redis', '--timeout=120s']);
  });

  let release;
  await check('release order: server dry run -> migration Job awaited -> application -> rollouts -> gateway programmed', async () => {
    release = await releaseToCluster({ kubectl, namespace: NS, log, rolloutTimeout: '5m',
      migrateYaml: kustomize(join(K8S, 'overlays', 'local-migrate')), appYaml: kustomize(join(K8S, 'overlays', 'local')) });
    const job = json(['get', 'job', 'db-migrate-local']);
    const firstApp = Math.min(...json(['get', 'deployments', '-l', 'app.kubernetes.io/part-of=portfolio-pilot']).items
      .filter(d => d.metadata.name !== 'redis').map(d => Date.parse(d.metadata.creationTimestamp)));
    assert.ok(Date.parse(job.status.completionTime) <= firstApp, 'an application Deployment existed before the migration completed');
    assert.match(release.migrationLog, /All migrations have been successfully applied|No pending migrations/);
    return { migrationCompleted: job.status.completionTime, firstDeploymentCreated: new Date(firstApp).toISOString() };
  });

  await check('API autoscaler holds the minimum of 2 replicas (no replicas field in the Deployment)', async () => {
    await waitFor('2 API replicas', () => json(['get', 'deployment', 'api']).status.readyReplicas >= 2, 120000);
    return { readyReplicas: json(['get', 'deployment', 'api']).status.readyReplicas };
  });

  await check('Pod Security: no restricted-profile warning for any application pod', () => {
    assert.deepEqual(release.warnings, []);
    const admitted = appPods().map(p => p.metadata.name);
    assert.ok(admitted.length >= 7, `pods: ${admitted.join(', ')}`);
    return { pods: admitted.length };
  });

  await check('demo data seeded over PostgreSQL loopback (ephemeral container in the database pod)', () => {
    const out = k(['debug', 'postgres-0', '--image=portfolio-pilot-worker:local', '--image-pull-policy=IfNotPresent', '--profile=restricted', '--container=seed-demo',
      '--attach=true', '--quiet', '--env=NODE_ENV=development', '--env=ALLOW_DEMO_SEED=true', `--env=DATABASE_URL=postgresql://portfolio:${password}@127.0.0.1:5432/portfolio_pilot`,
      '--', '/usr/bin/tini', '--', 'node', 'packages/db/dist/seed-cli.js'], { env: { ...process.env, MSYS_NO_PATHCONV: '1' }, timeoutMs: 180000 });
    assert.match(out.stdout, /Synthetic demo seeded/);
  });

  await forwardTo(gatewayPod().metadata.name);
  const api = client(ORIGIN);

  // The long idle stream runs while posture and policy checks proceed (they do not disturb the API).
  const smokeRun = smoke({ origin: ORIGIN, httpOrigin: `http://localhost:${HTTP_PORT}`, demoAccount: 'alice', mutate: true, holdSeconds });

  await check('pod posture: non-root UID, read-only code, writable scratch only, no service account token', () => {
    const posture = {};
    for (const pod of appPods()) {
      const container = pod.spec.containers[0].name;
      const uid = k(['exec', pod.metadata.name, '-c', container, '--', 'id', '-u']).stdout.trim();
      assert.notEqual(uid, '0', `${pod.metadata.name} runs as root`);
      assert.notEqual(k(['exec', pod.metadata.name, '-c', container, '--', 'sh', '-c', 'test -e /var/run/secrets/kubernetes.io/serviceaccount/token'], { allowFailure: true }).status, 0, `${pod.metadata.name} has a service account token`);
      assert.notEqual(k(['exec', pod.metadata.name, '-c', container, '--', 'sh', '-c', 'touch /probe-root'], { allowFailure: true }).status, 0, `${pod.metadata.name} root filesystem is writable`);
      k(['exec', pod.metadata.name, '-c', container, '--', 'sh', '-c', 'touch /tmp/.probe && rm /tmp/.probe']);
      posture[pod.metadata.labels['app.kubernetes.io/name']] = Number(uid);
    }
    const api = appPods().find(p => p.metadata.labels['app.kubernetes.io/name'] === 'api').metadata.name;
    assert.notEqual(k(['exec', api, '--', 'sh', '-c', 'echo x >> /app/apps/api/server.mjs'], { allowFailure: true }).status, 0, 'API code is writable');
    return posture;
  });

  await check('NetworkPolicy matrix: default deny, only the designed flows', () => {
    const pod = name => appPods().find(p => p.metadata.labels['app.kubernetes.io/name'] === name).metadata.name;
    const matrix = {
      'web -> api:3001 (allowed)': [tcp(pod('web'), 'web', 'api', 3001), true],
      'web -> postgres:5432 (denied)': [tcp(pod('web'), 'web', 'postgres', 5432), false],
      'web -> redis:6379 (denied)': [tcp(pod('web'), 'web', 'redis', 6379), false],
      'api -> postgres:5432 (allowed)': [tcp(pod('api'), 'api', 'postgres', 5432), true],
      'api -> redis:6379 (allowed)': [tcp(pod('api'), 'api', 'redis', 6379), true],
      'worker-outbox -> api:3001 (denied: only the gateway reaches the API)': [tcp(pod('worker-outbox'), 'worker', 'api', 3001), false],
      'worker-agent -> 1.1.1.1:443 (denied: no internet egress locally)': [tcp(pod('worker-agent'), 'worker', '1.1.1.1', 443), false],
      'worker-ingestion -> web:8080 (denied)': [tcp(pod('worker-ingestion'), 'worker', 'web', 8080), false]
    };
    for (const [flow, [actual, expected]] of Object.entries(matrix)) assert.equal(actual, expected, flow);
    return Object.fromEntries(Object.entries(matrix).map(([flow, [actual]]) => [flow, actual ? 'open' : 'blocked']));
  });

  await check(`public origin smoke test incl. ${holdSeconds} s idle SSE stream (scripts/k8s-smoke.mjs)`, async () => {
    const { results: smokeResults } = await smokeRun;
    const bad = smokeResults.filter(r => r.ok === false);
    assert.equal(bad.length, 0, JSON.stringify(bad));
    return Object.fromEntries(smokeResults.map(r => [r.name, r.ok ? (r.detail ?? 'ok') : r.error ?? 'skipped']));
  });

  const alice = await api.demoSignIn('alice');
  await check('rolling API restart under SSE and request load: no failed request, the stream resumes on another replica', async () => {
    const stream = api.openStream(alice, { reconnect: true });
    await waitFor('stream connected', () => stream.connections[0], 15000);
    const before = new Set(appPods().filter(p => p.metadata.labels['app.kubernetes.io/name'] === 'api').map(p => p.metadata.name));
    const load = startLoad(api, alice);
    await sleep(2000);
    k(['rollout', 'restart', 'deployment/api']);
    k(['rollout', 'status', 'deployment/api', '--timeout=300s'], { timeoutMs: 310000 });
    await sleep(8000);
    load.stop = true; await load.done;
    const after = appPods().filter(p => p.metadata.labels['app.kubernetes.io/name'] === 'api').map(p => p.metadata.name);
    assert.ok(after.every(name => !before.has(name)), 'every API pod was replaced');
    const portfolio = await recordTrade(api, alice);
    await waitFor('portfolio.updated after the rollout', () => stream.events.find(e => e.type === 'portfolio.updated' && e.portfolioId === portfolio), 30000);
    await stream.close();
    assert.equal(load.failures.length, 0, `failed requests: ${load.failures.slice(0, 5).join(' | ')}`);
    assert.ok(stream.connections.length >= 2, 'the stream was never moved off a draining replica');
    assert.ok(stream.connections.every(c => c.status === 200));
    return { requestsOk: load.ok, notProcessed503: load.notProcessed, failed: load.failures.length, streamConnections: stream.connections.length, eventsReceived: stream.events.length };
  });

  await check('worker roles drain on rollout (exit after worker.drained, none forced); an agent run in flight completes', async () => {
    const stream = api.openStream(alice, { reconnect: true });
    await waitFor('stream connected', () => stream.connections[0], 15000);
    const conversation = await api.call(alice, '/api/conversations', { method: 'POST', body: { title: 'Milestone 35 drain' } });
    assert.equal(conversation.status, 201);
    const submitted = await api.call(alice, `/api/conversations/${conversation.json.conversation.id}/runs`, { method: 'POST', body: { content: 'Explain my holdings' } });
    assert.equal(submitted.status, 202, submitted.text);
    const runId = submitted.json.run.id;
    await waitFor('run started', () => stream.events.find(e => e.type === 'agent.run.started' && e.runId === runId), 30000);
    const followers = appPods().filter(p => p.metadata.labels['app.kubernetes.io/component'] === 'worker').map(pod => {
      const child = spawn('kubectl', ['--context', CONTEXT, '-n', NS, 'logs', '-f', pod.metadata.name], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      const follower = { pod: pod.metadata.name, role: pod.metadata.labels['app.kubernetes.io/name'], output: '' };
      child.stdout.on('data', data => { follower.output += data; });
      follower.done = new Promise(resolve => child.on('exit', resolve));
      follower.child = child;
      return follower;
    });
    await sleep(1000);
    k(['rollout', 'restart', 'deployment/worker-agent', 'deployment/worker-outbox', 'deployment/worker-ingestion']);
    for (const name of ['worker-agent', 'worker-outbox', 'worker-ingestion']) k(['rollout', 'status', `deployment/${name}`, '--timeout=300s'], { timeoutMs: 310000 });
    await Promise.race([Promise.all(followers.map(f => f.done)), sleep(150000)]);
    followers.forEach(f => f.child.kill());
    const completed = await waitFor('agent.run.completed', () => stream.events.find(e => e.type === 'agent.run.completed' && e.runId === runId), 120000);
    await stream.close();
    const drained = {};
    for (const f of followers) {
      assert.match(f.output, /"event":"worker\.draining"/, `${f.pod} never started draining`);
      assert.match(f.output, /"event":"worker\.drained"/, `${f.pod} did not finish draining`);
      assert.doesNotMatch(f.output, /worker\.forced_exit/, `${f.pod} was force-exited`);
      drained[f.role] = 'drained';
    }
    return { ...drained, run: completed.status ?? completed.outcome ?? 'completed' };
  });

  await check('node drain honours PodDisruptionBudgets with no failed request', async () => {
    const dataNodes = new Set(pods('app.kubernetes.io/component=local-data').map(p => p.spec.nodeName));
    const workers = JSON.parse(kubectl(['get', 'nodes', '-o', 'json']).stdout).items.map(n => n.metadata.name).filter(n => !n.includes('control-plane'));
    // The worker running the most application pods, API included (local data services sit on the control plane).
    const appCount = n => appPods().filter(p => p.spec.nodeName === n).length;
    const target = workers.filter(n => !dataNodes.has(n)).sort((a, b) => Number(appPods().some(p => p.spec.nodeName === b && p.metadata.labels['app.kubernetes.io/name'] === 'api')) - Number(appPods().some(p => p.spec.nodeName === a && p.metadata.labels['app.kubernetes.io/name'] === 'api')) || appCount(b) - appCount(a))[0];
    assert.ok(target, 'no worker node free of local data services');
    if (gatewayPod().spec.nodeName === target) {
      // Keep the port-forwarded gateway off the node under test: the drain is about the application pods.
      kubectl(['cordon', target]);
      const old = gatewayPod().metadata.name;
      k(['delete', 'pod', old, '--wait=true']);
      await waitFor('gateway rescheduled', () => { const p = gatewayPod(); return p && p.metadata.name !== old && p.status.containerStatuses?.every(c => c.ready); }, 120000);
      await forwardTo(gatewayPod().metadata.name);
    }
    const evicted = pods('app.kubernetes.io/part-of=portfolio-pilot').filter(p => p.spec.nodeName === target).map(p => p.metadata.labels['app.kubernetes.io/name']);
    assert.ok(evicted.includes('api'), `the drained node runs no API pod (${evicted.join(', ')})`);
    const load = startLoad(api, alice);
    await sleep(1000);
    kubectl(['drain', target, '--ignore-daemonsets', '--delete-emptydir-data', '--timeout=300s'], { timeoutMs: 310000 });
    for (const name of ['web', 'api', 'worker-ingestion', 'worker-outbox', 'worker-agent']) k(['rollout', 'status', `deployment/${name}`, '--timeout=300s'], { timeoutMs: 310000 });
    await sleep(5000);
    load.stop = true; await load.done;
    kubectl(['uncordon', target]);
    assert.equal(load.failures.length, 0, `failed requests: ${load.failures.slice(0, 5).join(' | ')}`);
    return { node: target, evicted, requestsOk: load.ok, notProcessed503: load.notProcessed };
  });

  await check('AKS overlays accepted by a real API server (server-side dry run, example release.env)', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'pp-aks-'));
    try {
      cpSync(K8S, join(temp, 'k8s'), { recursive: true, filter: source => !source.endsWith('release.env') });
      cpSync(join(K8S, 'overlays', 'aks', 'release.env.example'), join(temp, 'k8s', 'overlays', 'aks', 'release.env'));
      // Dry run only: the API server validates every object (CRDs included) and admission, nothing changes.
      const migrateYaml = kustomize(join(temp, 'k8s', 'overlays', 'aks-migrate'), { shareReleaseEnv: true });
      const appYaml = kustomize(join(temp, 'k8s', 'overlays', 'aks'));
      const report = await releaseToCluster({ kubectl, namespace: NS, migrateYaml, appYaml, dryRunOnly: true, log: () => {} });
      return { objects: parseManifests(migrateYaml).length + parseManifests(appYaml).length, podSecurityWarnings: report.warnings.length };
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });

  await check('resource use against requests (container working sets, crictl)', () => {
    const usage = {};
    for (const node of ['pp-m35-worker', 'pp-m35-worker2']) {
      const stats = JSON.parse(run('docker', ['exec', node, 'crictl', 'stats', '-o', 'json']).stdout).stats;
      for (const s of stats) {
        const labels = s.attributes.labels;
        if (labels['io.kubernetes.pod.namespace'] !== NS || !s.memory?.workingSetBytes) continue;
        const name = labels['io.kubernetes.pod.name'].replace(/-[a-z0-9]{8,10}-[a-z0-9]{5}$|-[a-z0-9]{5}$/, '');
        usage[name] = Math.max(usage[name] ?? 0, Math.round(Number(s.memory.workingSetBytes.value) / 2 ** 20));
      }
    }
    return Object.fromEntries(Object.entries(usage).map(([name, mib]) => [name, `${mib} MiB`]));
  });
} catch (error) {
  failed = true;
  try { console.error(k(['get', 'pods', '-o', 'wide'], { allowFailure: true }).stdout); console.error(k(['get', 'events', '--sort-by=.lastTimestamp'], { allowFailure: true }).stdout.split('\n').slice(-25).join('\n')); } catch { /* cluster gone */ }
} finally {
  portForward?.kill();
  if (!args.includes('--keep')) { try { kind(['delete', 'cluster', '--name', CLUSTER]); } catch { /* already gone */ } }
  const summary = { cluster: args.includes('--keep') ? CONTEXT : 'deleted', passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, results };
  writeFileSync(join(tmpdir(), 'pp-k8s-local-report.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = failed ? 1 : 0;
}
