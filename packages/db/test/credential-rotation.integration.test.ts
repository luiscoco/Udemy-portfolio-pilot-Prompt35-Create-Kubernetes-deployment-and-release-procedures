import { randomBytes } from 'node:crypto';
import { createClient } from 'redis';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { redisStreamingCredentials } from '../src/azure-credentials.js';
import { createDatabaseClient, dataCredentialsFromEnv, redisClientOptions, type AccessToken, type TokenSource } from '../src/index.js';

// Milestone 34: the Entra code paths, driven against real PostgreSQL and Redis whose credentials are
// rotated underneath live clients. A "token" here is a password that the test rotates; the Entra
// exchange itself is unit-tested and needs Azure for a live check (docs/azure/credentials.md).
const databaseUrl = process.env.CREDENTIAL_TEST_DATABASE_URL;
const redisUrl = process.env.CREDENTIAL_TEST_REDIS_URL;
const OBJECT_ID = '0f0e0d0c-0b0a-4908-8706-050403020100';
const entra = dataCredentialsFromEnv({
  DATABASE_AUTH: 'azure-workload-identity', REDIS_AUTH: 'azure-workload-identity', REDIS_ENTRA_OBJECT_ID: OBJECT_ID,
  AZURE_TENANT_ID: '11111111-2222-3333-4444-555555555555', AZURE_CLIENT_ID: '66666666-7777-8888-9999-000000000000', AZURE_FEDERATED_TOKEN_FILE: '/unused'
});
const secret = () => randomBytes(18).toString('base64url');

/** A token source whose current value the test rotates, counting each fetch. */
function rotatingSource(initial: string, lifetimeMs: number) {
  const state = { current: initial, fetches: 0 };
  const source: TokenSource = async () => { state.fetches++; return { token: state.current, expiresAt: Date.now() + lifetimeMs } satisfies AccessToken; };
  return { state, source };
}
const until = async (check: () => Promise<boolean> | boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!(await check())) { if (Date.now() > end) throw new Error('condition not reached'); await new Promise(r => setTimeout(r, 50)); }
};

describe.skipIf(!databaseUrl || !redisUrl)('credential rotation against real services', () => {
  const cleanups: (() => Promise<unknown>)[] = [];
  afterAll(async () => { for (const cleanup of cleanups.reverse()) await cleanup().catch(() => undefined); });

  it('Prisma signs each new PostgreSQL connection in with the current token', async () => {
    const admin = createDatabaseClient(databaseUrl!, { databaseAuth: 'url', redisAuth: 'url' });
    cleanups.push(() => admin.$disconnect());
    const role = `pp_rotation_${randomBytes(4).toString('hex')}`;
    const first = secret();
    await admin.$executeRawUnsafe(`CREATE ROLE "${role}" LOGIN PASSWORD '${first}'`);
    cleanups.push(() => admin.$executeRawUnsafe(`DROP ROLE IF EXISTS "${role}"`));
    const target = new URL(databaseUrl!);
    target.username = role; target.password = ''; target.search = 'sslmode=disable';
    const { state, source } = rotatingSource(first, 60 * 60_000);

    const client = createDatabaseClient(target.href, entra, source);
    cleanups.push(() => client.$disconnect());
    expect(await client.$queryRaw<{ user: string }[]>`SELECT current_user AS "user"`).toEqual([{ user: role }]);
    expect(state.fetches).toBeGreaterThan(0);

    // Rotate: the server now accepts only the second credential.
    const second = secret();
    await admin.$executeRawUnsafe(`ALTER ROLE "${role}" PASSWORD '${second}'`);
    state.current = second;
    // Like an expired Entra token, the change does not affect an already signed-in connection.
    expect(await client.$queryRaw<{ ok: number }[]>`SELECT 1 AS ok`).toEqual([{ ok: 1 }]);
    // New physical connections ask for the password again and succeed with the rotated value.
    const before = state.fetches;
    await client.$disconnect();
    expect(await client.$queryRaw<{ user: string }[]>`SELECT current_user AS "user"`).toEqual([{ user: role }]);
    expect(state.fetches).toBeGreaterThan(before);

    // A stale credential is really rejected, so the successes above prove the callback is used.
    const stale = createDatabaseClient(target.href, entra, rotatingSource(first, 60 * 60_000).source);
    cleanups.push(() => stale.$disconnect());
    await expect(stale.$queryRaw`SELECT 1`).rejects.toThrow();
  });

  it('node-redis re-authenticates a live connection and reconnects with the newest token', async () => {
    const admin = createClient({ url: redisUrl! });
    admin.on('error', () => undefined);
    await admin.connect();
    cleanups.push(() => admin.close());
    // Azure uses the identity's object ID as the Redis user name; a local ACL user stands in for it.
    const [p1, p2] = [secret(), secret()];
    await admin.sendCommand(['ACL', 'SETUSER', OBJECT_ID, 'reset', 'on', `>${p1}`, '~*', '&*', '+@all']);
    cleanups.push(() => admin.sendCommand(['ACL', 'DELUSER', OBJECT_ID]));
    await admin.sendCommand(['ACL', 'LOG', 'RESET']);

    const { state, source } = rotatingSource(p1, 4000);
    const onError = vi.fn();
    const options = redisClientOptions(redisUrl!, entra, source);
    // Shorten the refresh schedule (production: five minutes before expiry plus up to a minute of jitter).
    options.credentialsProvider = redisStreamingCredentials({ username: OBJECT_ID, source, refreshMarginMs: 3000, jitterMs: 0, retryMs: 200, onError });
    const client = createClient(options);
    client.on('error', () => undefined);
    await client.connect();
    cleanups.push(() => client.isOpen ? client.close() : Promise.resolve());
    expect(await client.sendCommand(['ACL', 'WHOAMI'])).toBe(OBJECT_ID);
    const id = await client.clientId();

    // A refresh with a rejected token must reach the server as AUTH on this connection.
    state.current = 'not-a-valid-token';
    await until(() => onError.mock.calls.length > 0);
    expect(String(onError.mock.calls[0]![0])).toMatch(/WRONGPASS|invalid username-password/i);
    const log = await admin.sendCommand(['ACL', 'LOG']) as unknown[][];
    expect(JSON.stringify(log)).toContain(OBJECT_ID);
    // A failed AUTH leaves the connection signed in as before.
    expect(await client.ping()).toBe('PONG');

    // Rotate on the server, deliver the new token, then retire the old one.
    await admin.sendCommand(['ACL', 'SETUSER', OBJECT_ID, `>${p2}`]);
    state.current = p2;
    const fetches = state.fetches;
    await until(() => state.fetches > fetches + 1);
    await admin.sendCommand(['ACL', 'SETUSER', OBJECT_ID, `<${p1}`]);
    expect(await client.clientId()).toBe(id);
    expect(await client.ping()).toBe('PONG');

    // Drop the connection: the reconnect handshake must use the newest token (p1 no longer exists).
    await admin.sendCommand(['CLIENT', 'KILL', 'ID', String(id)]);
    await until(async () => { try { return (await client.clientId()) !== id; } catch { return false; } });
    expect(await client.sendCommand(['ACL', 'WHOAMI'])).toBe(OBJECT_ID);

    // And a client still holding the retired token cannot sign in at all.
    const staleOptions = redisClientOptions(redisUrl!, entra, rotatingSource(p1, 60 * 60_000).source);
    staleOptions.socket = { ...staleOptions.socket, reconnectStrategy: false };
    const stale = createClient(staleOptions);
    stale.on('error', () => undefined);
    await expect(stale.connect()).rejects.toThrow(/WRONGPASS|invalid username-password/i);
  }, 30000);
});
