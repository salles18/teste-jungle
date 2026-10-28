import { Migrator } from '@mikro-orm/migrations';
import { defineConfig, MikroORM, type Options } from '@mikro-orm/postgresql';
import { ALL_SCHEMAS } from './entities';
import { Migration20261028000100_initial_schema } from './migrations/Migration20261028000100_initial_schema';
import { Migration20261028000200_integrity_triggers } from './migrations/Migration20261028000200_integrity_triggers';

/** Ordered, explicit list: no filesystem globbing, identical behaviour in every runtime. */
export const MIGRATIONS = [
  { name: 'Migration20261028000100_initial_schema', class: Migration20261028000100_initial_schema },
  { name: 'Migration20261028000200_integrity_triggers', class: Migration20261028000200_integrity_triggers },
];

export interface OrmSettings {
  url: string;
  poolMax: number;
  debug?: boolean;
}

export function ormOptions(settings: OrmSettings): Options {
  return defineConfig({
    clientUrl: settings.url,
    entities: ALL_SCHEMAS,
    extensions: [Migrator],
    // Every unit of work must fork its own EntityManager; using the global one throws.
    allowGlobalContext: false,
    forceUtcTimezone: true,
    debug: settings.debug ?? false,
    pool: { min: 0, max: settings.poolMax },
    migrations: {
      migrationsList: MIGRATIONS,
      tableName: 'mikro_orm_migrations',
      transactional: true,
      allOrNothing: true,
      snapshot: false,
      // must stay false: true would run migrations with session_replication_role=replica,
      // which silently disables our integrity triggers and requires superuser.
      disableForeignKeys: false,
    },
  });
}

export async function createOrm(settings: OrmSettings): Promise<MikroORM> {
  return MikroORM.init(ormOptions(settings));
}
