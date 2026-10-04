// Release procedure for AKS (milestone 35, ADR 0027; docs/kubernetes/release-runbook.md).
//   node scripts/k8s-release.mjs env --deployment pp-dev --hostname <host> [--data-mode mock] [--agent-mode mock] [--model-id <id>]
//        Prints the environment part of release.env from the infra/azure deployment outputs (read-only `az`).
//   node scripts/k8s-release.mjs images --registry <acr> --tag <git-sha> [--release-id <id>]
//        Prints RELEASE_ID and the four *_IMAGE lines, resolving the commit tag to digests (read-only `az acr`).
//   node scripts/k8s-release.mjs render [--out <dir>]
//        Validates release.env (no example values), renders both units, writes them with SHA-256 sums.
//   node scripts/k8s-release.mjs plan
//        Prints the exact ordered commands of a release without running them.
//   node scripts/k8s-release.mjs apply --context <kube-context> --i-am-authorized-to-release <PUBLIC_HOSTNAME> [--dry-run]
//        Runs the release: server-side dry run -> migration Job -> wait -> application -> rollout -> gateway,
//        then the anonymous smoke test. The confirmation flag must repeat the public host name, so a
//        release cannot start by accident or against the wrong environment. --dry-run stops after the
//        server-side dry run and changes nothing.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { K8S, kubectlFor, kustomize, parseManifests, readEnvFile, releaseEnvProblems, releaseToCluster, run } from './k8s-lib.mjs';
import { smoke } from './k8s-smoke.mjs';

const [command, ...rest] = process.argv.slice(2);
const option = name => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
const RELEASE_ENV = join(K8S, 'overlays', 'aks', 'release.env');
const fail = message => { console.error(message); process.exit(2); };

function outputs(deployment) {
  const value = run('az', ['deployment', 'sub', 'show', '--name', deployment, '--query', 'properties.outputs', '-o', 'json']).stdout;
  return Object.fromEntries(Object.entries(JSON.parse(value)).map(([key, v]) => [key, v.value]));
}

/** release.env lines from deployment outputs (names, endpoints and identity IDs only; no secrets). */
export function environmentLines(out, { hostname, dataMode = 'mock', agentMode = 'mock', modelId = '', entraClientId, entraTenantId, privateEndpointCidr = '10.40.8.0/24' }) {
  const identity = workload => out.workloadIdentities.find(w => w.workload === workload) ?? fail(`deployment output has no ${workload} identity`);
  const dbUrl = workload => `postgresql://${identity(workload).identityName}@${out.postgresFqdn}:5432/${out.postgresDatabase}?sslmode=verify-full`;
  return [
    `PUBLIC_HOSTNAME=${hostname}`, `DATA_MODE=${dataMode}`, `AGENT_MODE=${agentMode}`, `AGENT_MODEL_ID=${modelId}`,
    `AZURE_TENANT_ID=${out.tenantId}`, `KEY_VAULT_NAME=${out.keyVaultName}`, `PRIVATE_ENDPOINT_CIDR=${privateEndpointCidr}`,
    `REDIS_URL=rediss://${out.redisHostName}:${out.redisPort}`, `SESSION_BLOB_CONTAINER_URL=${out.sessionBlobContainerUrl}`,
    ...['api', 'ingestion', 'outbox', 'agent'].flatMap(w => [`${w.toUpperCase()}_DATABASE_URL=${dbUrl(w)}`,
      `${w.toUpperCase()}_CLIENT_ID=${identity(w).clientId}`, `${w.toUpperCase()}_OBJECT_ID=${identity(w).principalId}`]),
    `MIGRATE_CLIENT_ID=${identity('migrate').clientId}`, `TLS_CLIENT_ID=${identity('tls').clientId}`,
    `ENTRA_CLIENT_ID=${entraClientId ?? ''}`, `ENTRA_TENANT_ID=${entraTenantId ?? out.tenantId}`
  ];
}

function renderUnits() {
  const problems = releaseEnvProblems(readEnvFile(RELEASE_ENV));
  if (problems.length) fail(`release.env is not releasable:\n - ${problems.join('\n - ')}`);
  const migrateYaml = kustomize(join(K8S, 'overlays', 'aks-migrate'), { shareReleaseEnv: true });
  const appYaml = kustomize(join(K8S, 'overlays', 'aks'));
  return { values: readEnvFile(RELEASE_ENV), migrateYaml, appYaml };
}
const sha256 = text => createHash('sha256').update(text).digest('hex');

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (!isMain) { /* imported by tests */ } else if (command === 'env') {
  const deployment = option('--deployment'), hostname = option('--hostname');
  if (!deployment || !hostname) fail('Usage: env --deployment <name> --hostname <public host> [--data-mode mock|live] [--agent-mode mock|claude] [--model-id id] [--entra-client-id id]');
  console.log(environmentLines(outputs(deployment), { hostname, dataMode: option('--data-mode'), agentMode: option('--agent-mode'), modelId: option('--model-id'),
    entraClientId: option('--entra-client-id'), entraTenantId: option('--entra-tenant-id'), privateEndpointCidr: option('--private-endpoint-cidr') }).join('\n'));
} else if (command === 'images') {
  const registry = option('--registry'), tag = option('--tag');
  if (!registry || !/^[0-9a-f]{7,40}$/.test(tag ?? '')) fail('Usage: images --registry <acr name> --tag <git sha> [--release-id id]');
  console.log(`RELEASE_ID=${option('--release-id') ?? tag.slice(0, 12)}`);
  for (const image of ['web', 'api', 'worker', 'migrate']) {
    const digest = run('az', ['acr', 'manifest', 'show-metadata', '--registry', registry, '--name', `portfolio-pilot/${image}:${tag}`, '--query', 'digest', '-o', 'tsv']).stdout.trim();
    console.log(`${image.toUpperCase()}_IMAGE=${registry}.azurecr.io/portfolio-pilot/${image}@${digest}`);
  }
} else if (command === 'render') {
  const { values, migrateYaml, appYaml } = renderUnits();
  const out = option('--out') ?? mkdtempSync(join(tmpdir(), `pp-release-${values.RELEASE_ID}-`));
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, '1-migrate.yaml'), migrateYaml);
  writeFileSync(join(out, '2-app.yaml'), appYaml);
  writeFileSync(join(out, 'SHA256SUMS'), `${sha256(migrateYaml)}  1-migrate.yaml\n${sha256(appYaml)}  2-app.yaml\n`);
  console.log(`release ${values.RELEASE_ID} rendered to ${out} (${parseManifests(migrateYaml).length} + ${parseManifests(appYaml).length} objects)`);
} else if (command === 'plan') {
  const { values, migrateYaml } = renderUnits();
  const job = parseManifests(migrateYaml).find(o => o.kind === 'Job').metadata.name;
  console.log(`# Release ${values.RELEASE_ID} to https://${values.PUBLIC_HOSTNAME} — run in order; stop at the first failure.
npm run validate:k8s -- --release-env deploy/kubernetes/overlays/aks/release.env
node scripts/k8s-release.mjs render --out .release/${values.RELEASE_ID}
kubectl apply --server-side --dry-run=server --field-manager=portfolio-pilot-release -f .release/${values.RELEASE_ID}/1-migrate.yaml
kubectl apply --server-side --dry-run=server --field-manager=portfolio-pilot-release -f .release/${values.RELEASE_ID}/2-app.yaml
kubectl apply --server-side --field-manager=portfolio-pilot-release -f .release/${values.RELEASE_ID}/1-migrate.yaml
kubectl -n portfolio-pilot wait --for=condition=complete job/${job} --timeout=15m   # on failure: STOP (database-releases.md)
kubectl -n portfolio-pilot logs job/${job}
kubectl apply --server-side --field-manager=portfolio-pilot-release -f .release/${values.RELEASE_ID}/2-app.yaml
for d in web api worker-ingestion worker-outbox worker-agent tls-sync; do kubectl -n portfolio-pilot rollout status deploy/$d --timeout=10m; done
kubectl -n portfolio-pilot wait --for=condition=Programmed gateway.gateway.networking.k8s.io/portfolio-pilot --timeout=5m
node scripts/k8s-smoke.mjs --origin https://${values.PUBLIC_HOSTNAME} --http-origin http://${values.PUBLIC_HOSTNAME} --hold-seconds 330 --cookie-file <signed-in session cookie>`);
} else if (command === 'apply') {
  const { values, migrateYaml, appYaml } = renderUnits();
  const context = option('--context');
  if (!context) fail('apply needs --context <kube-context> (never the current context implicitly)');
  if (option('--i-am-authorized-to-release') !== values.PUBLIC_HOSTNAME) fail(`A release changes ${values.PUBLIC_HOSTNAME}. Repeat that host name after --i-am-authorized-to-release once the release is authorized.`);
  const dryRunOnly = rest.includes('--dry-run');
  const report = await releaseToCluster({ kubectl: kubectlFor(context), namespace: 'portfolio-pilot', migrateYaml, appYaml, dryRunOnly });
  for (const warning of report.warnings) console.log(`WARNING ${warning}`);
  if (!dryRunOnly) {
    const { results } = await smoke({ origin: `https://${values.PUBLIC_HOSTNAME}`, httpOrigin: `http://${values.PUBLIC_HOSTNAME}`, holdSeconds: 0 });
    const failed = results.filter(r => r.ok === false);
    console.log(JSON.stringify({ release: values.RELEASE_ID, smoke: results }, null, 2));
    if (failed.length) { console.error(`Smoke test failed after the rollout. Decide: fix forward, or roll the application back with \`kubectl rollout undo\` (the database stays migrated; docs/kubernetes/database-releases.md).`); process.exit(1); }
  }
} else {
  fail('Usage: node scripts/k8s-release.mjs env|images|render|plan|apply (see the header of this file)');
}
