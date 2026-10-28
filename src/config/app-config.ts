import { hostname } from 'node:os';

export interface AppConfig {
  nodeEnv: string;
  instanceId: string;
  logLevel: string;
  http: { enabled: boolean; port: number };
  database: {
    url: string;
    poolMax: number;
    lockTimeoutMs: number;
    statementTimeoutMs: number;
    debug: boolean;
  };
  /** Currencies enabled for this deployment (subset of what the domain knows). */
  supportedCurrencies: string[];
  /** Bounded retry of a whole SQL transaction on deadlock / serialization / lock timeout. */
  transactionRetry: { maxAttempts: number; baseDelayMs: number; maxDelayMs: number };
  aws: { region: string; endpoint: string | undefined; accessKeyId: string; secretAccessKey: string };
  sqs: {
    wagerQueueName: string;
    wagerDlqName: string;
    eventsQueueName: string;
    /** Redrive maxReceiveCount on the wager queue: safety net above the app's own limit. */
    redriveMaxReceiveCount: number;
    visibilityTimeoutSeconds: number;
  };
  consumer: {
    enabled: boolean;
    name: string;
    waitTimeSeconds: number;
    maxMessages: number;
    maxAttempts: number;
    baseBackoffMs: number;
    maxBackoffMs: number;
    shutdownGraceMs: number;
  };
  outbox: {
    enabled: boolean;
    batchSize: number;
    pollIntervalMs: number;
    leaseMs: number;
    maxAttempts: number;
    baseBackoffMs: number;
    maxBackoffMs: number;
  };
  pendingReference: {
    enabled: boolean;
    batchSize: number;
    pollIntervalMs: number;
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
    ttlMs: number;
  };
}

type Env = Record<string, string | undefined>;

function str(env: Env, key: string, fallback?: string): string {
  const value = env[key];
  if (value !== undefined && value !== '') return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required environment variable ${key}`);
}

function int(env: Env, key: string, fallback: number, min = 0): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${key} must be a non-negative integer, got "${raw}"`);
  const value = Number.parseInt(raw, 10);
  if (value < min) throw new Error(`${key} must be >= ${min}`);
  return value;
}

function bool(env: Env, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  if (['1', 'true', 'yes'].includes(raw.toLowerCase())) return true;
  if (['0', 'false', 'no'].includes(raw.toLowerCase())) return false;
  throw new Error(`${key} must be a boolean, got "${raw}"`);
}

export function loadConfig(env: Env = process.env): AppConfig {
  const consumerName = str(env, 'SQS_CONSUMER_NAME', 'wager-transactions-consumer');
  return {
    nodeEnv: str(env, 'NODE_ENV', 'development'),
    instanceId: str(env, 'INSTANCE_ID', `${hostname()}-${process.pid}`),
    logLevel: str(env, 'LOG_LEVEL', 'info'),
    http: { enabled: bool(env, 'RUN_HTTP', true), port: int(env, 'PORT', 3000) },
    database: {
      url: str(env, 'DATABASE_URL', 'postgresql://jungle:jungle@localhost:5432/jungle_wallet'),
      poolMax: int(env, 'DB_POOL_MAX', 20, 1),
      lockTimeoutMs: int(env, 'DB_LOCK_TIMEOUT_MS', 5000, 1),
      statementTimeoutMs: int(env, 'DB_STATEMENT_TIMEOUT_MS', 15000, 1),
      debug: bool(env, 'DB_DEBUG', false),
    },
    supportedCurrencies: str(env, 'SUPPORTED_CURRENCIES', 'BRL')
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean),
    transactionRetry: {
      maxAttempts: int(env, 'TX_RETRY_MAX_ATTEMPTS', 5, 1),
      baseDelayMs: int(env, 'TX_RETRY_BASE_DELAY_MS', 20),
      maxDelayMs: int(env, 'TX_RETRY_MAX_DELAY_MS', 500),
    },
    aws: {
      region: str(env, 'AWS_REGION', 'us-east-1'),
      // Outside production, never talk to real AWS by accident: default to LocalStack.
      endpoint:
        env.AWS_ENDPOINT_URL ||
        env.SQS_ENDPOINT ||
        ((env.NODE_ENV ?? 'development') === 'production' ? undefined : 'http://localhost:4566'),
      accessKeyId: str(env, 'AWS_ACCESS_KEY_ID', 'test'),
      secretAccessKey: str(env, 'AWS_SECRET_ACCESS_KEY', 'test'),
    },
    sqs: {
      wagerQueueName: str(env, 'SQS_WAGER_QUEUE', 'wager-transactions.fifo'),
      wagerDlqName: str(env, 'SQS_WAGER_DLQ', 'wager-transactions-dlq.fifo'),
      eventsQueueName: str(env, 'SQS_EVENTS_QUEUE', 'wallet-events.fifo'),
      redriveMaxReceiveCount: int(env, 'SQS_REDRIVE_MAX_RECEIVE_COUNT', 10, 1),
      visibilityTimeoutSeconds: int(env, 'SQS_VISIBILITY_TIMEOUT_SECONDS', 30, 1),
    },
    consumer: {
      enabled: bool(env, 'RUN_SQS_CONSUMER', true),
      name: consumerName,
      waitTimeSeconds: int(env, 'SQS_WAIT_TIME_SECONDS', 10),
      maxMessages: int(env, 'SQS_MAX_MESSAGES', 10, 1),
      maxAttempts: int(env, 'SQS_MAX_ATTEMPTS', 5, 1),
      baseBackoffMs: int(env, 'SQS_BASE_BACKOFF_MS', 1000),
      maxBackoffMs: int(env, 'SQS_MAX_BACKOFF_MS', 60000),
      shutdownGraceMs: int(env, 'SHUTDOWN_GRACE_MS', 20000),
    },
    outbox: {
      enabled: bool(env, 'RUN_OUTBOX_PUBLISHER', true),
      batchSize: int(env, 'OUTBOX_BATCH_SIZE', 50, 1),
      pollIntervalMs: int(env, 'OUTBOX_POLL_INTERVAL_MS', 500, 10),
      leaseMs: int(env, 'OUTBOX_LEASE_MS', 30000, 100),
      maxAttempts: int(env, 'OUTBOX_MAX_ATTEMPTS', 20, 1),
      baseBackoffMs: int(env, 'OUTBOX_BASE_BACKOFF_MS', 500),
      maxBackoffMs: int(env, 'OUTBOX_MAX_BACKOFF_MS', 300000),
    },
    pendingReference: {
      enabled: bool(env, 'RUN_PENDING_REFERENCE_WORKER', true),
      batchSize: int(env, 'PENDING_REFERENCE_BATCH_SIZE', 50, 1),
      pollIntervalMs: int(env, 'PENDING_REFERENCE_POLL_INTERVAL_MS', 1000, 10),
      maxAttempts: int(env, 'PENDING_REFERENCE_MAX_ATTEMPTS', 10, 1),
      baseDelayMs: int(env, 'PENDING_REFERENCE_BASE_DELAY_MS', 1000),
      maxDelayMs: int(env, 'PENDING_REFERENCE_MAX_DELAY_MS', 300000),
      ttlMs: int(env, 'PENDING_REFERENCE_TTL_MS', 3600000, 1),
    },
  };
}
