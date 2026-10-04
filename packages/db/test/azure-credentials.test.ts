import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CredentialError, dataCredentialsFromEnv, postgresEntraPoolConfig, redisStreamingCredentials, workloadIdentityTokenSource, POSTGRES_ENTRA_SCOPE, type AccessToken } from '../src/azure-credentials.js';
import { databasePoolConfig, redisClientOptions } from '../src/index.js';

const TENANT = '11111111-2222-3333-4444-555555555555';
const CLIENT = '66666666-7777-8888-9999-000000000000';
const OBJECT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function tokenFile(content = 'federated-1') {
  const file = join(mkdtempSync(join(tmpdir(), 'pp-wi-')), 'token');
  writeFileSync(file, content);
  return file;
}
function tokenResponse(token: string, expiresIn = 3600, status = 200) {
  return new Response(JSON.stringify({ access_token: token, expires_in: expiresIn, token_type: 'Bearer' }), { status });
}

describe('workloadIdentityTokenSource', () => {
  it('exchanges the projected token for the requested scope and caches it', async () => {
    const file = tokenFile();
    const calls: { url: string; body: URLSearchParams }[] = [];
    const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => { calls.push({ url: String(url), body: init!.body as URLSearchParams }); return tokenResponse(`t${calls.length}`); });
    let clock = 1_000_000;
    const source = workloadIdentityTokenSource({ tenantId: TENANT, clientId: CLIENT, tokenFile: file }, POSTGRES_ENTRA_SCOPE, { fetch: fetch as typeof globalThis.fetch, now: () => clock });
    expect((await source()).token).toBe('t1');
    expect(calls[0]!.url).toBe(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`);
    expect(Object.fromEntries(calls[0]!.body)).toEqual({ client_id: CLIENT, scope: POSTGRES_ENTRA_SCOPE, grant_type: 'client_credentials', client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: 'federated-1' });
    clock += 30 * 60_000;
    expect((await source()).token).toBe('t1');
    expect(fetch).toHaveBeenCalledTimes(1);
    // Inside the five-minute margin a new token is fetched, with the kubelet's rotated assertion.
    writeFileSync(file, 'federated-2\n');
    clock += 26 * 60_000;
    expect((await source()).token).toBe('t2');
    expect(calls[1]!.body.get('client_assertion')).toBe('federated-2');
  });

  it('honours a larger minimum validity and single-flights concurrent callers', async () => {
    let n = 0;
    const fetch = vi.fn(async () => { await new Promise(r => setTimeout(r, 5)); return tokenResponse(`t${++n}`); });
    const clock = 0;
    const source = workloadIdentityTokenSource({ tenantId: TENANT, clientId: CLIENT, tokenFile: tokenFile() }, 'scope', { fetch: fetch as typeof globalThis.fetch, now: () => clock });
    const tokens = await Promise.all(Array.from({ length: 10 }, () => source()));
    expect(new Set(tokens.map(t => t.token))).toEqual(new Set(['t1']));
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(source(2 * 3600_000)).rejects.toThrow('shorter than the required validity');
  });

  it('uses the injected authority host and never leaks the error body', async () => {
    const fetch = vi.fn(async (url: URL | RequestInfo) => { expect(String(url)).toBe(`https://login.example.test/${TENANT}/oauth2/v2.0/token`); return new Response('{"error_description":"secret-assertion-echo"}', { status: 401 }); });
    const source = workloadIdentityTokenSource({ tenantId: TENANT, clientId: CLIENT, tokenFile: tokenFile(), authorityHost: 'https://login.example.test/' }, 'scope', { fetch: fetch as typeof globalThis.fetch });
    const error = await source().catch(e => e as Error);
    expect(error).toBeInstanceOf(CredentialError);
    expect(error.message).toBe('Entra token request failed with HTTP 401');
    expect(error.message).not.toContain('secret');
  });

  it('rejects malformed identities, authorities and token responses', async () => {
    expect(() => workloadIdentityTokenSource({ tenantId: 'x', clientId: CLIENT, tokenFile: 'f' }, 's')).toThrow(CredentialError);
    expect(() => workloadIdentityTokenSource({ tenantId: TENANT, clientId: CLIENT, tokenFile: 'f', authorityHost: 'http://login.example.test/' }, 's')).toThrow('authority');
    const bad = workloadIdentityTokenSource({ tenantId: TENANT, clientId: CLIENT, tokenFile: tokenFile() }, 's', { fetch: (async () => new Response('{"access_token":""}')) as typeof fetch });
    await expect(bad()).rejects.toThrow('incomplete');
    const empty = workloadIdentityTokenSource({ tenantId: TENANT, clientId: CLIENT, tokenFile: tokenFile('') }, 's', { fetch: (async () => tokenResponse('x')) as typeof fetch });
    await expect(empty()).rejects.toThrow('empty');
  });
});

describe('redisStreamingCredentials', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
  afterEach(() => { vi.useRealTimers(); });

  function source(lifetimeMs: number) {
    let n = 0; const asked: number[] = [];
    const fn = vi.fn(async (minValidityMs?: number): Promise<AccessToken> => { asked.push(minValidityMs ?? 0); return { token: `tok${++n}`, expiresAt: Date.now() + lifetimeMs }; });
    return { fn, asked };
  }

  it('re-authenticates before expiry with the object ID as user and fresh tokens', async () => {
    const { fn, asked } = source(60 * 60_000);
    const provider = redisStreamingCredentials({ username: OBJECT, source: fn, random: () => 0.5 });
    const next = vi.fn(); const onError = vi.fn();
    const [initial] = await provider.subscribe({ onNext: next, onError });
    expect(initial).toEqual({ username: OBJECT, password: 'tok1' });
    // 60 min lifetime - 5 min margin - 30 s jitter.
    await vi.advanceTimersByTimeAsync(54 * 60_000 + 29_000);
    expect(next).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(next).toHaveBeenCalledWith({ username: OBJECT, password: 'tok2' });
    // Each request demands more validity than the refresh lead, so a cached token cannot be reused.
    expect(asked.every(ms => ms > 5 * 60_000 + 60_000)).toBe(true);
    await vi.advanceTimersByTimeAsync(55 * 60_000);
    expect(next).toHaveBeenLastCalledWith({ username: OBJECT, password: 'tok3' });
    expect(onError).not.toHaveBeenCalled();
  });

  it('retries failed refreshes and reports an error only when the token would expire', async () => {
    let fail = false; let n = 0;
    const fn = vi.fn(async (): Promise<AccessToken> => { if (fail) throw new Error('entra down'); return { token: `tok${++n}`, expiresAt: Date.now() + 10 * 60_000 }; });
    const provider = redisStreamingCredentials({ username: OBJECT, source: fn, jitterMs: 0, retryMs: 60_000 });
    const next = vi.fn(); const onError = vi.fn();
    await provider.subscribe({ onNext: next, onError });
    fail = true;
    await vi.advanceTimersByTimeAsync(5 * 60_000); // first refresh attempt at expiry - 5 min
    expect(onError).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(onError).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
  });

  it('keeps only the newest subscription alive across reconnects', async () => {
    const { fn } = source(10 * 60_000);
    const provider = redisStreamingCredentials({ username: OBJECT, source: fn, jitterMs: 0 });
    const first = vi.fn(); const second = vi.fn();
    await provider.subscribe({ onNext: first, onError: vi.fn() });
    const [, disposable] = await provider.subscribe({ onNext: second, onError: vi.fn() });
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    disposable.dispose();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('connection configuration', () => {
  const wi = { DATABASE_AUTH: 'azure-workload-identity', REDIS_AUTH: 'azure-workload-identity', AZURE_TENANT_ID: TENANT, AZURE_CLIENT_ID: CLIENT, AZURE_FEDERATED_TOKEN_FILE: '/var/run/secrets/azure/tokens/azure-identity-token', REDIS_ENTRA_OBJECT_ID: OBJECT };

  it('defaults to URL credentials and validates workload identity variables', () => {
    expect(dataCredentialsFromEnv({})).toEqual({ databaseAuth: 'url', redisAuth: 'url' });
    expect(dataCredentialsFromEnv(wi)).toMatchObject({ databaseAuth: 'azure-workload-identity', redisUsername: OBJECT, identity: { tenantId: TENANT, clientId: CLIENT } });
    expect(() => dataCredentialsFromEnv({ ...wi, REDIS_ENTRA_OBJECT_ID: undefined })).toThrow('REDIS_ENTRA_OBJECT_ID');
    expect(() => dataCredentialsFromEnv({ DATABASE_AUTH: 'azure-workload-identity' })).toThrow('AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_FEDERATED_TOKEN_FILE');
    expect(() => dataCredentialsFromEnv({ REDIS_AUTH: 'keys' })).toThrow('REDIS_AUTH');
  });

  it('passes discrete PostgreSQL fields so the password callback is not overwritten', async () => {
    const password = async () => 'token';
    const config = postgresEntraPoolConfig('postgresql://id-pp-dev-api@psql-pp-dev-x.postgres.database.azure.com:5432/portfolio_pilot?sslmode=verify-full', password);
    expect(config).toEqual({ host: 'psql-pp-dev-x.postgres.database.azure.com', port: 5432, user: 'id-pp-dev-api', database: 'portfolio_pilot', password, ssl: { rejectUnauthorized: true, servername: 'psql-pp-dev-x.postgres.database.azure.com' } });
    expect(() => postgresEntraPoolConfig('postgresql://u:p@h/db?sslmode=verify-full', password)).toThrow('must not contain a password');
    expect(() => postgresEntraPoolConfig('postgresql://u@h.example/db?sslmode=require', password)).toThrow('verify-full');
    expect(() => postgresEntraPoolConfig('postgresql://u@db.example/db?sslmode=disable', password)).toThrow('loopback');
    expect(() => postgresEntraPoolConfig('postgresql://u@h.example/db?sslmode=verify-full&options=x', password)).toThrow('options');
    expect(postgresEntraPoolConfig('postgresql://u@127.0.0.1:5546/db?sslmode=disable', password).ssl).toBe(false);
    const pool = databasePoolConfig('postgresql://id@h.example/db?sslmode=verify-full', dataCredentialsFromEnv(wi), async () => ({ token: 'abc', expiresAt: Date.now() + 3600_000 }));
    expect(await (pool as { password: () => Promise<string> }).password()).toBe('abc');
    expect(databasePoolConfig('postgresql://u:p@h/db', dataCredentialsFromEnv({}))).toEqual({ connectionString: 'postgresql://u:p@h/db', connectionTimeoutMillis: 1000 });
  });

  it('requires TLS and credential-free URLs for Redis in Entra mode', () => {
    const creds = dataCredentialsFromEnv(wi);
    const options = redisClientOptions('rediss://amr-pp-dev-x.eastus2.redis.azure.net:10000', creds, async () => ({ token: 't', expiresAt: Date.now() + 3600_000 }));
    expect(options.credentialsProvider?.type).toBe('streaming-credentials-provider');
    expect(() => redisClientOptions('redis://amr.example:10000', creds)).toThrow('rediss://');
    expect(() => redisClientOptions('rediss://default:key@amr.example:10000', creds)).toThrow('must not contain credentials');
    expect(redisClientOptions('redis://127.0.0.1:6379', dataCredentialsFromEnv({})).credentialsProvider).toBeUndefined();
  });
});
