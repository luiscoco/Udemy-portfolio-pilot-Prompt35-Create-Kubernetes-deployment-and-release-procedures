// Unit tests for the milestone-35 release helpers (node --test; npm run test:k8s).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { K8S, readEnvFile, releaseEnvProblems } from './k8s-lib.mjs';
import { environmentLines } from './k8s-release.mjs';

const uuid = n => `6b1f3c2a-9d4e-4f5a-8b7c-${String(n).padStart(12, '0')}`;
// Shape of `az deployment sub show ... properties.outputs` for infra/azure (values invented).
const outputs = {
  tenantId: uuid(900), keyVaultName: 'kv-pp-dev-q7w2', postgresFqdn: 'psql-pp-dev-q7w2.postgres.database.azure.com', postgresDatabase: 'portfolio_pilot',
  redisHostName: 'amr-pp-dev-q7w2.eastus2.redis.azure.net', redisPort: 10000, sessionBlobContainerUrl: 'https://stppdevq7w2.blob.core.windows.net/session-artifacts',
  workloadIdentities: ['api', 'ingestion', 'outbox', 'agent', 'migrate', 'otel', 'tls'].map((workload, i) => ({ workload, identityName: `id-pp-dev-${workload}`, clientId: uuid(i + 1), principalId: uuid(i + 101) }))
};
const images = ['RELEASE_ID=3f2a9c1d7b4e', ...['web', 'api', 'worker', 'migrate'].map((image, i) => `${image.toUpperCase()}_IMAGE=acrppdevq7w2.azurecr.io/portfolio-pilot/${image}@sha256:${String(i + 1).repeat(64)}`)];
const parse = lines => Object.fromEntries(lines.map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
const generated = () => parse([...images, ...environmentLines(outputs, { hostname: 'portfolio.contoso.dev', entraClientId: uuid(500) })]);

test('release.env generated from deployment outputs is releasable', () => {
  assert.deepEqual(releaseEnvProblems(generated()), []);
  assert.equal(generated().API_DATABASE_URL, 'postgresql://id-pp-dev-api@psql-pp-dev-q7w2.postgres.database.azure.com:5432/portfolio_pilot?sslmode=verify-full');
  assert.equal(generated().TLS_CLIENT_ID, uuid(7));
});
test('the committed example renders but can never be released', () => {
  const example = readEnvFile(join(K8S, 'overlays', 'aks', 'release.env.example'));
  assert.deepEqual(releaseEnvProblems(example, { allowExample: true }), []);
  assert.ok(releaseEnvProblems(example).some(p => p.includes('example value')));
});
test('a pasted secret or mutable tag is rejected by format', () => {
  assert.ok(releaseEnvProblems({ ...generated(), API_DATABASE_URL: 'postgresql://pp:hunter22@db.postgres.database.azure.com:5432/x?sslmode=verify-full' }).some(p => p.startsWith('API_DATABASE_URL')));
  assert.ok(releaseEnvProblems({ ...generated(), API_IMAGE: 'acrppdevq7w2.azurecr.io/portfolio-pilot/api:latest' }).some(p => p.startsWith('API_IMAGE')));
  assert.ok(releaseEnvProblems({ ...generated(), ANTHROPIC_API_KEY: 'sk-ant-xxxxxxxxxxxx' }).some(p => p.includes('not a known release parameter')));
});
test('every workload keeps its own identity', () => {
  assert.ok(releaseEnvProblems({ ...generated(), AGENT_CLIENT_ID: uuid(1) }).some(p => p.includes('own identity')));
  assert.ok(releaseEnvProblems({ ...generated(), AGENT_DATABASE_URL: generated().API_DATABASE_URL }).some(p => p.includes('agent identity')));
});
test('Claude mode needs an explicit model choice', () => {
  assert.ok(releaseEnvProblems({ ...generated(), AGENT_MODE: 'claude' }).some(p => p.includes('AGENT_MODEL_ID')));
});
