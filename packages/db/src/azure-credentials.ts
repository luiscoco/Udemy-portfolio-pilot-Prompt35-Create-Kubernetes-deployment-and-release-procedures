import { readFile } from 'node:fs/promises';
import type { RedisClientOptions } from 'redis';

type StreamingCredentialsProvider = Extract<NonNullable<RedisClientOptions['credentialsProvider']>, { type: 'streaming-credentials-provider' }>;

/**
 * Microsoft Entra credentials for PostgreSQL and Redis through AKS workload identity (milestone 34).
 *
 * - PostgreSQL validates the token only when a connection signs in, so node-postgres asks for a
 *   password per new physical connection; established connections survive token expiry.
 * - Azure Managed Redis closes connections whose token expires, so the client must send `AUTH` with
 *   a fresh token before expiry; node-redis does that for a streaming credentials provider.
 * The federated service-account token is re-read on every exchange because the kubelet rotates it.
 */
export const POSTGRES_ENTRA_SCOPE = 'https://ossrdbms-aad.database.windows.net/.default';
export const REDIS_ENTRA_SCOPE = 'https://redis.azure.com/.default';
const DEFAULT_AUTHORITY = 'https://login.microsoftonline.com/';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
export const isLoopbackHost = (hostname: string) => LOOPBACK.has(hostname);

export type AccessToken = { token: string; expiresAt: number };
/** Returns a token valid for at least `minValidityMs` (default five minutes). */
export type TokenSource = (minValidityMs?: number) => Promise<AccessToken>;
export type WorkloadIdentity = { tenantId: string; clientId: string; tokenFile: string; authorityHost?: string | undefined };

export class CredentialError extends Error {}

export function workloadIdentityTokenSource(identity: WorkloadIdentity, scope: string, options: { fetch?: typeof fetch; now?: () => number } = {}): TokenSource {
  if (!UUID.test(identity.tenantId) || !UUID.test(identity.clientId)) throw new CredentialError('Invalid workload identity tenant or client ID');
  const authority = new URL(identity.authorityHost || DEFAULT_AUTHORITY);
  if (authority.protocol !== 'https:' || authority.search || authority.hash || authority.username) throw new CredentialError('Invalid Entra authority host');
  const endpoint = new URL(`${identity.tenantId}/oauth2/v2.0/token`, authority.href.endsWith('/') ? authority : `${authority.href}/`);
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  let cached: AccessToken | null = null;
  let pending: Promise<AccessToken> | null = null;
  async function exchange(): Promise<AccessToken> {
    const assertion = (await readFile(identity.tokenFile, 'utf8')).trim();
    if (!assertion) throw new CredentialError('Federated token file is empty');
    let response: Response;
    try {
      response = await fetcher(endpoint, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        body: new URLSearchParams({ client_id: identity.clientId, scope, grant_type: 'client_credentials', client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: assertion })
      });
    } catch { throw new CredentialError('Entra token request failed'); }
    // Never include the response body: error descriptions can echo request details.
    if (!response.ok) throw new CredentialError(`Entra token request failed with HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > 64000) throw new CredentialError('Entra token response too large');
    let body: { access_token?: unknown; expires_in?: unknown };
    try { body = JSON.parse(text) as typeof body; } catch { throw new CredentialError('Entra token response was not JSON'); }
    const seconds = Number(body.expires_in);
    if (typeof body.access_token !== 'string' || !body.access_token || !Number.isFinite(seconds) || seconds <= 0) throw new CredentialError('Entra token response was incomplete');
    return { token: body.access_token, expiresAt: now() + seconds * 1000 };
  }
  return async (minValidityMs = 5 * 60_000) => {
    if (cached && cached.expiresAt - now() > minValidityMs) return cached;
    // Single flight: a pool opening many connections at once performs one exchange.
    pending ??= exchange().then(token => { cached = token; return token; }).finally(() => { pending = null; });
    const token = await pending;
    if (token.expiresAt - now() <= minValidityMs) throw new CredentialError('Entra token lifetime is shorter than the required validity');
    return token;
  };
}

export type RedisStreamingOptions = {
  username: string;
  source: TokenSource;
  /** Refresh this long before expiry; Azure asks for at least three minutes. */
  refreshMarginMs?: number;
  /** Random extra lead so replicas do not all re-authenticate at once. */
  jitterMs?: number;
  retryMs?: number;
  now?: () => number;
  random?: () => number;
  onError?: (error: Error) => void;
};

/**
 * node-redis calls `subscribe` during every handshake (first connect and each reconnect) and sends
 * `AUTH` itself whenever `onNext` delivers new credentials. Only the newest subscription stays
 * active, because the client does not dispose the previous one when it reconnects.
 */
export function redisStreamingCredentials(options: RedisStreamingOptions): StreamingCredentialsProvider {
  const margin = options.refreshMarginMs ?? 5 * 60_000;
  const jitter = options.jitterMs ?? 60_000;
  const retry = options.retryMs ?? 10_000;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  let active: { dispose(): void } | null = null;
  return {
    type: 'streaming-credentials-provider',
    async subscribe(listener) {
      active?.dispose();
      let disposed = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let current = await options.source(margin + jitter + retry);
      const schedule = (delay: number) => {
        timer = setTimeout(refresh, Math.max(0, delay));
        timer.unref?.();
      };
      const refreshDelay = () => current.expiresAt - margin - Math.floor(random() * jitter) - now();
      const refresh = async () => {
        if (disposed) return;
        try {
          // Ask for a token that outlives the next refresh point, so the cache cannot hand back the current one.
          const next = await options.source(margin + jitter + retry);
          if (disposed) return;
          current = next;
          listener.onNext({ username: options.username, password: next.token });
          schedule(refreshDelay());
        } catch (error) {
          if (disposed) return;
          if (current.expiresAt - now() > retry) schedule(retry);
          else listener.onError(error instanceof Error ? error : new CredentialError('Token refresh failed'));
        }
      };
      schedule(refreshDelay());
      const subscription = { dispose() { disposed = true; clearTimeout(timer); if (active === subscription) active = null; } };
      active = subscription;
      return [{ username: options.username, password: current.token }, subscription];
    },
    onReAuthenticationError(error) { options.onError?.(error); }
  };
}

/**
 * pg merges a parsed `connectionString` over explicit options, and the parser turns a missing
 * password into '' — which would replace a password callback. Entra mode therefore passes discrete
 * fields. TLS is mandatory except against a loopback test server.
 */
export type EntraPoolFields = { host: string; port: number; user: string; database: string; password: () => Promise<string>; ssl: false | { rejectUnauthorized: true; servername: string } };
export function postgresEntraPoolConfig(databaseUrl: string, password: () => Promise<string>): EntraPoolFields {
  const url = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.hash) throw new CredentialError('DATABASE_URL must be a postgres URL');
  if (url.password) throw new CredentialError('DATABASE_URL must not contain a password when DATABASE_AUTH=azure-workload-identity');
  const user = decodeURIComponent(url.username);
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!user || !database) throw new CredentialError('DATABASE_URL must name the database role and database');
  const extra = [...url.searchParams.keys()].filter(key => key !== 'sslmode');
  if (extra.length) throw new CredentialError(`Unsupported DATABASE_URL parameters in Entra mode: ${extra.join(', ')}`);
  const sslmode = url.searchParams.get('sslmode');
  if (sslmode !== 'verify-full' && !(sslmode === 'disable' && LOOPBACK.has(url.hostname))) throw new CredentialError('Entra mode requires sslmode=verify-full (sslmode=disable only for loopback tests)');
  return {
    host: url.hostname.replace(/^\[|\]$/g, ''), port: url.port ? Number(url.port) : 5432, user, database, password,
    ssl: sslmode === 'verify-full' ? { rejectUnauthorized: true, servername: url.hostname } : false
  };
}

export type CredentialMode = 'url' | 'azure-workload-identity';
export type DataCredentials = { databaseAuth: CredentialMode; redisAuth: CredentialMode; identity?: WorkloadIdentity | undefined; redisUsername?: string | undefined };

/** Strict parsing of the variables the AKS workload identity webhook and manifests provide. */
export function dataCredentialsFromEnv(env: NodeJS.ProcessEnv): DataCredentials {
  const mode = (name: string): CredentialMode => {
    const value = env[name] || 'url';
    if (value !== 'url' && value !== 'azure-workload-identity') throw new CredentialError(`${name} must be url or azure-workload-identity`);
    return value;
  };
  const databaseAuth = mode('DATABASE_AUTH');
  const redisAuth = mode('REDIS_AUTH');
  if (databaseAuth === 'url' && redisAuth === 'url') return { databaseAuth, redisAuth };
  const missing = ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_FEDERATED_TOKEN_FILE'].filter(name => !env[name]);
  if (redisAuth === 'azure-workload-identity' && !env.REDIS_ENTRA_OBJECT_ID) missing.push('REDIS_ENTRA_OBJECT_ID');
  if (missing.length) throw new CredentialError(`Workload identity requires ${missing.join(', ')}`);
  if (env.REDIS_ENTRA_OBJECT_ID && !UUID.test(env.REDIS_ENTRA_OBJECT_ID)) throw new CredentialError('REDIS_ENTRA_OBJECT_ID must be the identity object (principal) ID');
  return {
    databaseAuth, redisAuth, redisUsername: env.REDIS_ENTRA_OBJECT_ID,
    identity: { tenantId: env.AZURE_TENANT_ID!, clientId: env.AZURE_CLIENT_ID!, tokenFile: env.AZURE_FEDERATED_TOKEN_FILE!, authorityHost: env.AZURE_AUTHORITY_HOST }
  };
}
