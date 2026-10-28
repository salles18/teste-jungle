import { loadConfig } from '../../config/app-config';
import { createOrm } from './orm';

/**
 * bun run db:migrate   -> apply all pending migrations
 * bun run db:rollback  -> revert the last applied migration
 * bun run db:fresh     -> revert everything, then apply everything (empty database)
 * bun run db:status    -> list executed / pending migrations
 */
async function main(): Promise<void> {
  const command = process.argv[2] ?? 'up';
  const config = loadConfig();
  const orm = await createOrm({ url: config.database.url, poolMax: 2 });
  const migrator = orm.getMigrator();
  try {
    switch (command) {
      case 'up': {
        const applied = await migrator.up();
        console.log(applied.length ? `Applied: ${applied.map((m) => m.name).join(', ')}` : 'Database is up to date');
        break;
      }
      case 'down': {
        const reverted = await migrator.down();
        console.log(reverted.length ? `Reverted: ${reverted.map((m) => m.name).join(', ')}` : 'Nothing to revert');
        break;
      }
      case 'fresh': {
        await migrator.down({ to: 0 });
        const applied = await migrator.up();
        console.log(`Fresh schema. Applied: ${applied.map((m) => m.name).join(', ')}`);
        break;
      }
      case 'status': {
        const executed = await migrator.getExecutedMigrations();
        const pending = await migrator.getPendingMigrations();
        console.log(
          'Executed:',
          executed.map((m) => m.name),
        );
        console.log(
          'Pending :',
          pending.map((m) => m.name),
        );
        break;
      }
      default:
        throw new Error(`Unknown command "${command}" (expected up | down | fresh | status)`);
    }
  } finally {
    await orm.close(true);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
