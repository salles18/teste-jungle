import { Migration } from '@mikro-orm/migrations';

/**
 * Tables, keys, CHECK constraints and indexes.
 * Money columns are NUMERIC(20,2) and are always read as strings (never JS numbers).
 */
export class Migration20261028000100_initial_schema extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE wallets (
        id          uuid           PRIMARY KEY,
        player_id   varchar(128)   NOT NULL CHECK (player_id ~ '^[A-Za-z0-9._:@-]{1,128}$'),
        currency    char(3)        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        balance     numeric(20,2)  NOT NULL CHECK (balance >= 0),
        version     integer        NOT NULL CHECK (version >= 1),
        created_at  timestamptz    NOT NULL DEFAULT now(),
        updated_at  timestamptz    NOT NULL DEFAULT now(),
        CONSTRAINT uq_wallets_player_currency UNIQUE (player_id, currency),
        -- target of composite FKs that force children to agree on player and currency
        CONSTRAINT uq_wallets_id_player_currency UNIQUE (id, player_id, currency),
        CONSTRAINT uq_wallets_id_currency UNIQUE (id, currency)
      )`);

    this.addSql(`
      CREATE TABLE wager_transactions (
        id                                 uuid           PRIMARY KEY,
        provider_id                        varchar(64)    NOT NULL CHECK (length(provider_id) > 0),
        external_transaction_id            varchar(128)   NOT NULL CHECK (length(external_transaction_id) > 0),
        idempotency_key                    varchar(128)   NOT NULL CHECK (length(idempotency_key) > 0),
        payload_hash                       char(64)       NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
        wallet_id                          uuid           NOT NULL,
        player_id                          varchar(128)   NOT NULL,
        currency                           char(3)        NOT NULL,
        round_id                           varchar(128),
        game_id                            varchar(128),
        kind                               varchar(16)    NOT NULL
          CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        amount                             numeric(20,2)  NOT NULL CHECK (amount >= 0),
        reference_external_transaction_id  varchar(128),
        reference_transaction_id           uuid,
        status                             varchar(24)    NOT NULL
          CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        failure_code                       varchar(64),
        result_balance                     numeric(20,2)  CHECK (result_balance >= 0),
        result_wallet_version              integer        CHECK (result_wallet_version >= 1),
        reference_attempts                 integer        NOT NULL DEFAULT 0 CHECK (reference_attempts >= 0),
        next_reference_check_at            timestamptz,
        reference_deadline_at              timestamptz,
        correlation_id                     varchar(128),
        processed_at                       timestamptz,
        created_at                         timestamptz    NOT NULL DEFAULT now(),
        updated_at                         timestamptz    NOT NULL DEFAULT now(),

        CONSTRAINT fk_wager_wallet FOREIGN KEY (wallet_id, player_id, currency)
          REFERENCES wallets (id, player_id, currency),
        CONSTRAINT uq_wager_provider_idempotency UNIQUE (provider_id, idempotency_key),
        CONSTRAINT uq_wager_provider_external UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT uq_wager_id_wallet_currency UNIQUE (id, wallet_id, currency),
        CONSTRAINT uq_wager_reference_target UNIQUE (id, provider_id, wallet_id, currency, round_id),
        -- a resolved reference must live in the same provider, wallet, currency and round
        CONSTRAINT fk_wager_reference FOREIGN KEY (reference_transaction_id, provider_id, wallet_id, currency, round_id)
          REFERENCES wager_transactions (id, provider_id, wallet_id, currency, round_id),

        CONSTRAINT ck_wager_round_game CHECK (kind = 'OPENING' OR (round_id IS NOT NULL AND game_id IS NOT NULL)),
        CONSTRAINT ck_wager_opening_internal CHECK ((kind = 'OPENING') = (provider_id = 'system')),
        CONSTRAINT ck_wager_positive_amount CHECK (kind = 'LOSS' OR amount > 0),
        CONSTRAINT ck_wager_reversal_has_reference CHECK (
          kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        CONSTRAINT ck_wager_no_reference_for_kind CHECK (
          kind NOT IN ('OPENING','BET') OR reference_external_transaction_id IS NULL),
        CONSTRAINT ck_wager_not_self_reference CHECK (
          reference_external_transaction_id IS DISTINCT FROM external_transaction_id),
        CONSTRAINT ck_wager_failure_code CHECK ((status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)),
        CONSTRAINT ck_wager_processed_snapshot CHECK (
          status <> 'PROCESSED' OR (processed_at IS NOT NULL AND result_balance IS NOT NULL AND result_wallet_version IS NOT NULL)),
        CONSTRAINT ck_wager_processed_reference_resolved CHECK (
          status <> 'PROCESSED' OR reference_external_transaction_id IS NULL OR reference_transaction_id IS NOT NULL),
        CONSTRAINT ck_wager_pending_schedule CHECK (
          status <> 'PENDING_REFERENCE' OR (next_reference_check_at IS NOT NULL AND reference_deadline_at IS NOT NULL))
      )`);

    // At most one *effective* reversal (REFUND or ROLLBACK) per referenced transaction.
    // Rejected attempts are allowed to accumulate; only PROCESSED ones count.
    this.addSql(`
      CREATE UNIQUE INDEX ux_wager_single_reversal ON wager_transactions (reference_transaction_id)
      WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')`);
    this.addSql(`CREATE INDEX ix_wager_wallet_created ON wager_transactions (wallet_id, created_at DESC)`);
    this.addSql(`
      CREATE INDEX ix_wager_pending_due ON wager_transactions (next_reference_check_at)
      WHERE status = 'PENDING_REFERENCE'`);
    this.addSql(`
      CREATE INDEX ix_wager_pending_by_reference ON wager_transactions (provider_id, reference_external_transaction_id)
      WHERE status = 'PENDING_REFERENCE'`);
    this.addSql(`CREATE INDEX ix_wager_reference_tx ON wager_transactions (reference_transaction_id)`);
    this.addSql(`CREATE INDEX ix_wager_status ON wager_transactions (status)`);

    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id              uuid           PRIMARY KEY,
        wallet_id       uuid           NOT NULL,
        transaction_id  uuid           NOT NULL,
        currency        char(3)        NOT NULL,
        direction       varchar(6)     NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
        amount          numeric(20,2)  NOT NULL CHECK (amount > 0),
        balance_before  numeric(20,2)  NOT NULL CHECK (balance_before >= 0),
        balance_after   numeric(20,2)  NOT NULL CHECK (balance_after >= 0),
        wallet_version  integer        NOT NULL CHECK (wallet_version >= 1),
        created_at      timestamptz    NOT NULL DEFAULT now(),
        CONSTRAINT fk_ledger_wallet FOREIGN KEY (wallet_id, currency) REFERENCES wallets (id, currency),
        CONSTRAINT fk_ledger_transaction FOREIGN KEY (transaction_id, wallet_id, currency)
          REFERENCES wager_transactions (id, wallet_id, currency),
        -- one entry per transaction (therefore per wallet + transaction)
        CONSTRAINT uq_ledger_transaction UNIQUE (transaction_id),
        -- total, gap-free order per wallet; also the keyset used by ledger pagination
        CONSTRAINT uq_ledger_wallet_version UNIQUE (wallet_id, wallet_version),
        CONSTRAINT ck_ledger_arithmetic CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount) OR
          (direction = 'DEBIT'  AND balance_after = balance_before - amount))
      )`);

    this.addSql(`
      CREATE TABLE inbox_messages (
        id                 uuid          PRIMARY KEY,
        consumer_name      varchar(64)   NOT NULL,
        message_id         varchar(128)  NOT NULL,
        status             varchar(16)   NOT NULL CHECK (status IN ('RECEIVED','PROCESSED','DEAD_LETTERED')),
        attempts           integer       NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        last_error         text,
        result             jsonb,
        transaction_id     uuid          REFERENCES wager_transactions (id),
        first_received_at  timestamptz   NOT NULL DEFAULT now(),
        last_received_at   timestamptz   NOT NULL DEFAULT now(),
        processed_at       timestamptz,
        CONSTRAINT uq_inbox_consumer_message UNIQUE (consumer_name, message_id),
        CONSTRAINT ck_inbox_completed CHECK ((status = 'RECEIVED') = (processed_at IS NULL))
      )`);
    this.addSql(`CREATE INDEX ix_inbox_open ON inbox_messages (last_received_at) WHERE status = 'RECEIVED'`);

    this.addSql(`
      CREATE TABLE outbox_messages (
        id                uuid          PRIMARY KEY,
        seq               bigint        GENERATED ALWAYS AS IDENTITY,
        event_type        varchar(64)   NOT NULL,
        event_version     integer       NOT NULL CHECK (event_version >= 1),
        aggregate_type    varchar(64)   NOT NULL,
        aggregate_id      varchar(64)   NOT NULL,
        message_group_id  varchar(128)  NOT NULL,
        payload           jsonb         NOT NULL,
        status            varchar(16)   NOT NULL CHECK (status IN ('PENDING','PUBLISHED','DEAD')),
        attempts          integer       NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at   timestamptz   NOT NULL DEFAULT now(),
        locked_by         varchar(128),
        locked_until      timestamptz,
        last_error        text,
        published_at      timestamptz,
        occurred_at       timestamptz   NOT NULL,
        created_at        timestamptz   NOT NULL DEFAULT now(),
        CONSTRAINT uq_outbox_seq UNIQUE (seq),
        CONSTRAINT ck_outbox_published CHECK ((status = 'PUBLISHED') = (published_at IS NOT NULL)),
        CONSTRAINT ck_outbox_lease CHECK ((locked_by IS NULL) = (locked_until IS NULL))
      )`);
    this.addSql(`CREATE INDEX ix_outbox_pending ON outbox_messages (next_attempt_at, seq) WHERE status = 'PENDING'`);
    this.addSql(`CREATE INDEX ix_outbox_aggregate ON outbox_messages (aggregate_id, seq)`);
  }

  override async down(): Promise<void> {
    this.addSql('DROP TABLE IF EXISTS outbox_messages');
    this.addSql('DROP TABLE IF EXISTS inbox_messages');
    this.addSql('DROP TABLE IF EXISTS wallet_ledger_entries');
    this.addSql('DROP TABLE IF EXISTS wager_transactions');
    this.addSql('DROP TABLE IF EXISTS wallets');
  }
}
