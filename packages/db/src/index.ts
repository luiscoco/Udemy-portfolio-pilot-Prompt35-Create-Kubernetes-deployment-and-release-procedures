import { PrismaPg } from '@prisma/adapter-pg';
import { createLogger } from '@portfolio-pilot/observability';
import { createClient, type RedisClientOptions } from 'redis';
import { CredentialError, dataCredentialsFromEnv, isLoopbackHost, postgresEntraPoolConfig, POSTGRES_ENTRA_SCOPE, REDIS_ENTRA_SCOPE, redisStreamingCredentials, workloadIdentityTokenSource, type DataCredentials, type TokenSource } from './azure-credentials.js';
import { PrismaClient } from './generated/prisma/client.js';



function validatedUrl(value: string, protocols: string[], name: string): string {
  try {
    const url = new URL(value);
    if (protocols.includes(url.protocol) && url.hostname && !url.hash) return value;
  } catch { /* handled below */ }
  throw new Error(`${name} must be a valid ${protocols.join(' or ')} URL`);
}

const RETRIES = 3;
const RETRY_DELAY_MS = 200;
async function retry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (attempt >= RETRIES) throw error;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * (attempt + 1)));
    }
  }
}

let database: PrismaClient | undefined;
let redis: ReturnType<typeof createClient> | undefined;
let credentials: DataCredentials | undefined;
const tokenSources = new Map<string, TokenSource>();

/** DATABASE_AUTH/REDIS_AUTH select the mode; the default 'url' keeps any credentials in the URL itself. */
function dataCredentials() { return credentials ??= dataCredentialsFromEnv(process.env); }
function tokenSource(creds: DataCredentials, scope: string) {
  let source = tokenSources.get(scope);
  if (!source) { source = workloadIdentityTokenSource(creds.identity!, scope); tokenSources.set(scope, source); }
  return source;
}

/** The adapter bundles its own pg typings; use its constructor input rather than the root @types/pg. */
type PoolConfig = Exclude<ConstructorParameters<typeof PrismaPg>[0], string | { connect: unknown }>;

/** node-postgres pool options; in Entra mode each new connection signs in with a current token. */
export function databasePoolConfig(databaseUrl: string, creds: DataCredentials = dataCredentials(), source?: TokenSource): PoolConfig {
  if (creds.databaseAuth === 'url') return { connectionString: databaseUrl, connectionTimeoutMillis: 1000 };
  const tokens = source ?? tokenSource(creds, POSTGRES_ENTRA_SCOPE);
  // The timeout also covers a token exchange on a cold cache.
  return { ...postgresEntraPoolConfig(databaseUrl, async () => (await tokens()).token), connectionTimeoutMillis: 10000 };
}

const log = createLogger('data-credentials');
/** Redis client options; in Entra mode live connections re-authenticate before each token expires. */
export function redisClientOptions(redisUrl: string, creds: DataCredentials = dataCredentials(), source?: TokenSource): RedisClientOptions {
  const socket = {
    connectTimeout: creds.redisAuth === 'url' ? 1000 : 10000,
    reconnectStrategy: (retries: number) => retries >= RETRIES ? false as const : RETRY_DELAY_MS * (retries + 1)
  };
  if (creds.redisAuth === 'url') return { url: redisUrl, socket };
  const url = new URL(redisUrl);
  if (url.username || url.password) throw new CredentialError('REDIS_URL must not contain credentials when REDIS_AUTH=azure-workload-identity');
  if (url.protocol !== 'rediss:' && !isLoopbackHost(url.hostname)) throw new CredentialError('Entra authentication requires rediss:// (TLS)');
  return {
    url: redisUrl, socket,
    credentialsProvider: redisStreamingCredentials({
      username: creds.redisUsername!, source: source ?? tokenSource(creds, REDIS_ENTRA_SCOPE),
      onError: error => log.warn('redis.reauthentication_failed', { reason: error.message })
    })
  };
}

/** A Prisma client over the credential mode in `creds`; `getDatabase` keeps the process-wide one. */
export function createDatabaseClient(databaseUrl: string, creds?: DataCredentials, source?: TokenSource): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg(databasePoolConfig(databaseUrl, creds, source)) });
}

export async function getDatabase(databaseUrl: string): Promise<PrismaClient> {
  validatedUrl(databaseUrl, ['postgresql:', 'postgres:'], 'DATABASE_URL');
  if (!database) {
    const candidate = createDatabaseClient(databaseUrl);
    try {
      await retry(() => candidate.$connect());
      database = candidate;
    } catch (error) {
      await candidate.$disconnect();
      throw error;
    }
  }
  return database;
}

export async function getRedis(redisUrl: string) {
  validatedUrl(redisUrl, ['redis:', 'rediss:'], 'REDIS_URL');
  if (redis && !redis.isOpen) redis = undefined;
  if (!redis) {
    const candidate = createClient(redisClientOptions(redisUrl));
    candidate.on('error', () => { /* readiness reports connection failure without logging credentials */ });
    try {
      await candidate.connect();
      redis = candidate;
    } catch (error) {
      candidate.destroy();
      throw error;
    }
  }
  return redis;
}

export async function checkDatabase(databaseUrl: string): Promise<boolean> {
  try {
    const client = await getDatabase(databaseUrl);
    await client.$queryRaw`SELECT 1`;
    return true;
  } catch { return false; }
}

export async function checkRedis(redisUrl: string): Promise<boolean> {
  try { return (await (await getRedis(redisUrl)).ping()) === 'PONG'; }
  catch { return false; }
}

export async function closeConnections(): Promise<void> {
  const currentRedis = redis;
  const currentDatabase = database;
  redis = undefined;
  database = undefined;
  if (currentRedis?.isOpen) await currentRedis.close();
  await currentDatabase?.$disconnect();
}

export { CredentialError, dataCredentialsFromEnv, postgresEntraPoolConfig, redisStreamingCredentials, workloadIdentityTokenSource, POSTGRES_ENTRA_SCOPE, REDIS_ENTRA_SCOPE } from './azure-credentials.js';
export type { AccessToken, DataCredentials, TokenSource, WorkloadIdentity } from './azure-credentials.js';
export { authenticateOwner, ownerRepositories } from './repositories.js';
export type { AuthenticatedOwner } from './repositories.js';
export { portfolioService, PortfolioError } from './portfolio-service.js';
export { summaryService } from './summary-service.js';
export { watchlistService } from './watchlist-service.js';
export { ingestionRepository, canonicalUrl } from './ingestion.js';
export type { Lease } from './ingestion.js';

export { appendEvent, buildEvent, outboxRepository, uuidV5, OUTBOX_POLICY } from './outbox.js';
export type { ClaimedEvent, NewAppEvent, OutboxRepository } from './outbox.js';
export { createCache, invalidateForEvent, jitteredTtl, CACHE_POLICIES, GENERATION_TTL_MS, SINGLE_FLIGHT } from './cache.js';
export type { Cache, CachePolicy, CacheOptions } from './cache.js';
export { redisKeys, safeKeyId, KEY_SCHEMA_VERSION } from './redis-keys.js';
export type { RedisClient, RedisKeys } from './redis-keys.js';
export { publishEvent, readEvents, currentCursor, streamEpoch, encodeCursor, decodeCursor, compareEntryIds, consumeOnce, EventDeduper, STREAM_RETENTION } from './event-stream.js';
export type { StreamRead, StreamScope } from './event-stream.js';
export { quoteReads, newsReads } from './cached-reads.js';
export { recoverySnapshot } from './recovery.js';
export { agentToolReads } from './agent-tool-reads.js';
export type { AgentToolReads } from './agent-tool-reads.js';
export { chatService } from './chat-service.js';
export type { ChatService, RunOutcome, SessionBinding } from './chat-service.js';
export { researchService, sharedAnalyses, invalidateArticleResearch, articleRevisionKey, analysisCacheKey, RESEARCH_CACHE_POLICY } from './research-service.js';
export type { AnalysisInput, AnalysisRunOutcome, AnalyzerBinding, EnsuredAnalysis, ResearchService } from './research-service.js';
export { ownerInterest } from './news-service.js';

export { alertService, processResearchNews } from './alert-service.js';

export * from './approval-service.js';

export * from './run-lease.js';
export * from './run-progress.js';
export * from './agent-jobs.js';
export { ownerForAgentRun } from './repositories.js';
export * from './operations.js';
export * from './admin.js';
