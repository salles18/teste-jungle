import 'reflect-metadata';
import { createContainer } from './bootstrap/container';
import { createHttpApp } from './bootstrap/http-app';
import { Runtime } from './bootstrap/runtime';
import { loadConfig } from './config/app-config';
import { errorFields } from './observability/logger';

async function main(): Promise<void> {
  const config = loadConfig();
  const container = await createContainer(config);
  const { logger } = container;
  const runtime = new Runtime(container);

  const app = config.http.enabled ? await createHttpApp(container, runtime) : null;
  if (app) await app.listen(config.http.port);
  runtime.start();
  logger.info(
    {
      port: config.http.enabled ? config.http.port : null,
      roles: {
        http: config.http.enabled,
        sqsConsumer: config.consumer.enabled,
        outboxPublisher: config.outbox.enabled,
        pendingReferenceWorker: config.pendingReference.enabled,
      },
    },
    'jungle-wallet started',
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutdown requested');
    const force = setTimeout(() => {
      logger.error('graceful shutdown timed out, exiting');
      process.exit(1);
    }, config.consumer.shutdownGraceMs + 10_000);
    try {
      await app?.close(); // stop accepting HTTP, finish in-flight requests
      await runtime.stop(); // stop SQS intake, wait for in-flight messages, stop workers
      await container.close();
      logger.info('shutdown complete');
      clearTimeout(force);
      process.exit(0);
    } catch (error) {
      logger.error({ ...errorFields(error) }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
