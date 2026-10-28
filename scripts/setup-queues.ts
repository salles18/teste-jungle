import { loadConfig } from '../src/config/app-config';
import { createSqsClient, ensureQueues } from '../src/infrastructure/sqs/sqs';

/** Idempotently creates wager-transactions.fifo, its DLQ and wallet-events.fifo. */
const config = loadConfig();
const client = createSqsClient(config);
try {
  const urls = await ensureQueues(client, config);
  console.log('SQS queues ready:');
  console.log(`  wager : ${urls.wager}`);
  console.log(`  dlq   : ${urls.dlq}`);
  console.log(`  events: ${urls.events}`);
} finally {
  client.destroy();
}
