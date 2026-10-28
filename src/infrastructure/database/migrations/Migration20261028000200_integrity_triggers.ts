import { Migration } from '@mikro-orm/migrations';

/**
 * Invariants that CHECK/UNIQUE/FK cannot express. All raise SQLSTATE 'JW001'
 * (custom class) so the application can recognise them as integrity violations.
 *
 *  - ledger is append-only (no UPDATE / DELETE / TRUNCATE)
 *  - ledger entries chain: balance_before = previous balance_after, versions increase
 *  - ledger entry agrees with its transaction (amount, kind, direction; ROLLBACK inverts)
 *  - wallet version moves by exactly +1 iff the balance moves
 *  - (deferred) every wallet balance change has its ledger entry
 *  - (deferred) PROCESSED money-moving transactions have exactly one entry; others none
 *  - terminal wager transactions are immutable; business fields are always immutable
 *  - outbox events cannot disappear before being published; inbox terminal rows are immutable
 */
export class Migration20261028000200_integrity_triggers extends Migration {
  override async up(): Promise<void> {
    // ---------- generic guards ----------------------------------------------------
    this.addSql(`
      CREATE FUNCTION jw_forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION '% on % is forbidden: table is append-only', TG_OP, TG_TABLE_NAME
          USING ERRCODE = 'JW001';
      END $$`);

    for (const table of ['wallet_ledger_entries', 'wager_transactions', 'wallets', 'outbox_messages', 'inbox_messages']) {
      this.addSql(`
        CREATE TRIGGER trg_${table}_no_truncate BEFORE TRUNCATE ON ${table}
        FOR EACH STATEMENT EXECUTE FUNCTION jw_forbid_change()`);
    }
    this.addSql(`
      CREATE TRIGGER trg_ledger_append_only BEFORE UPDATE OR DELETE ON wallet_ledger_entries
      FOR EACH ROW EXECUTE FUNCTION jw_forbid_change()`);
    this.addSql(`
      CREATE TRIGGER trg_wallets_no_delete BEFORE DELETE ON wallets
      FOR EACH ROW EXECUTE FUNCTION jw_forbid_change()`);
    this.addSql(`
      CREATE TRIGGER trg_wager_no_delete BEFORE DELETE ON wager_transactions
      FOR EACH ROW EXECUTE FUNCTION jw_forbid_change()`);

    // ---------- ledger entry consistency (BEFORE INSERT) --------------------------
    // Callers hold the wallet row lock (SELECT ... FOR UPDATE), so "previous entry"
    // is stable; uq_ledger_wallet_version is the backstop if a caller forgets.
    this.addSql(`
      CREATE FUNCTION jw_ledger_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        tx   record;
        prev record;
        ref_direction text;
      BEGIN
        SELECT kind, amount, reference_transaction_id INTO tx
          FROM wager_transactions WHERE id = NEW.transaction_id;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'ledger entry references unknown transaction %', NEW.transaction_id USING ERRCODE = 'JW001';
        END IF;
        IF tx.kind = 'LOSS' THEN
          RAISE EXCEPTION 'LOSS transactions never create ledger entries' USING ERRCODE = 'JW001';
        END IF;
        IF tx.amount <> NEW.amount THEN
          RAISE EXCEPTION 'ledger amount % differs from transaction amount %', NEW.amount, tx.amount USING ERRCODE = 'JW001';
        END IF;
        IF tx.kind = 'BET' AND NEW.direction <> 'DEBIT'
           OR tx.kind IN ('WIN','REFUND','OPENING') AND NEW.direction <> 'CREDIT' THEN
          RAISE EXCEPTION '% must not be a %', tx.kind, NEW.direction USING ERRCODE = 'JW001';
        END IF;
        IF tx.kind = 'ROLLBACK' THEN
          SELECT direction INTO ref_direction FROM wallet_ledger_entries
           WHERE transaction_id = tx.reference_transaction_id;
          IF ref_direction IS NULL OR ref_direction = NEW.direction THEN
            RAISE EXCEPTION 'ROLLBACK must invert the ledger entry of its reference' USING ERRCODE = 'JW001';
          END IF;
        END IF;

        SELECT balance_after, wallet_version INTO prev
          FROM wallet_ledger_entries WHERE wallet_id = NEW.wallet_id
         ORDER BY wallet_version DESC LIMIT 1;
        IF NOT FOUND THEN
          IF NEW.balance_before <> 0 THEN
            RAISE EXCEPTION 'first ledger entry of wallet % must start at 0', NEW.wallet_id USING ERRCODE = 'JW001';
          END IF;
        ELSIF NEW.balance_before <> prev.balance_after OR NEW.wallet_version <= prev.wallet_version THEN
          RAISE EXCEPTION 'ledger chain broken for wallet % (prev after=%, v=%; new before=%, v=%)',
            NEW.wallet_id, prev.balance_after, prev.wallet_version, NEW.balance_before, NEW.wallet_version
            USING ERRCODE = 'JW001';
        END IF;
        RETURN NEW;
      END $$`);
    this.addSql(`
      CREATE TRIGGER trg_ledger_before_insert BEFORE INSERT ON wallet_ledger_entries
      FOR EACH ROW EXECUTE FUNCTION jw_ledger_before_insert()`);

    // ---------- wallet update rules (BEFORE UPDATE) -------------------------------
    this.addSql(`
      CREATE FUNCTION jw_wallets_before_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id <> OLD.id OR NEW.player_id <> OLD.player_id OR NEW.currency <> OLD.currency
           OR NEW.created_at <> OLD.created_at THEN
          RAISE EXCEPTION 'wallet identity columns are immutable' USING ERRCODE = 'JW001';
        END IF;
        IF NEW.balance = OLD.balance THEN
          IF NEW.version <> OLD.version THEN
            RAISE EXCEPTION 'wallet version may only change together with the balance' USING ERRCODE = 'JW001';
          END IF;
        ELSIF NEW.version <> OLD.version + 1 THEN
          RAISE EXCEPTION 'balance change must increment version by exactly 1 (% -> %)', OLD.version, NEW.version
            USING ERRCODE = 'JW001';
        END IF;
        RETURN NEW;
      END $$`);
    this.addSql(`
      CREATE TRIGGER trg_wallets_before_update BEFORE UPDATE ON wallets
      FOR EACH ROW EXECUTE FUNCTION jw_wallets_before_update()`);

    // ---------- (deferred) wallet balance <-> ledger -------------------------------
    this.addSql(`
      CREATE FUNCTION jw_wallets_ledger_check() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          IF NEW.balance > 0 AND NOT EXISTS (
            SELECT 1 FROM wallet_ledger_entries e
             WHERE e.wallet_id = NEW.id AND e.wallet_version = NEW.version AND e.balance_after = NEW.balance) THEN
            RAISE EXCEPTION 'wallet % opened with balance % but without a ledger entry', NEW.id, NEW.balance
              USING ERRCODE = 'JW001';
          END IF;
        ELSIF NEW.version <> OLD.version THEN
          IF NOT EXISTS (
            SELECT 1 FROM wallet_ledger_entries e
             WHERE e.wallet_id = NEW.id AND e.wallet_version = NEW.version
               AND e.balance_before = OLD.balance AND e.balance_after = NEW.balance) THEN
            RAISE EXCEPTION 'wallet % balance changed % -> % without matching ledger entry (v%)',
              NEW.id, OLD.balance, NEW.balance, NEW.version USING ERRCODE = 'JW001';
          END IF;
        END IF;
        RETURN NULL;
      END $$`);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER trg_wallets_ledger_check AFTER INSERT OR UPDATE ON wallets
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION jw_wallets_ledger_check()`);

    // ---------- wager transaction update rules (BEFORE UPDATE) ---------------------
    this.addSql(`
      CREATE FUNCTION jw_wager_before_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
          RAISE EXCEPTION 'wager transaction % is % (terminal) and cannot change', OLD.id, OLD.status
            USING ERRCODE = 'JW001';
        END IF;
        IF NEW.id <> OLD.id
           OR NEW.provider_id <> OLD.provider_id
           OR NEW.external_transaction_id <> OLD.external_transaction_id
           OR NEW.idempotency_key <> OLD.idempotency_key
           OR NEW.payload_hash <> OLD.payload_hash
           OR NEW.wallet_id <> OLD.wallet_id
           OR NEW.player_id <> OLD.player_id
           OR NEW.currency <> OLD.currency
           OR NEW.round_id IS DISTINCT FROM OLD.round_id
           OR NEW.game_id IS DISTINCT FROM OLD.game_id
           OR NEW.kind <> OLD.kind
           OR NEW.amount <> OLD.amount
           OR NEW.reference_external_transaction_id IS DISTINCT FROM OLD.reference_external_transaction_id
           OR NEW.created_at <> OLD.created_at THEN
          RAISE EXCEPTION 'business fields of wager transaction % are immutable', OLD.id USING ERRCODE = 'JW001';
        END IF;
        IF OLD.status = 'PENDING_REFERENCE' AND NEW.status = 'PENDING' THEN
          RAISE EXCEPTION 'PENDING_REFERENCE cannot go back to PENDING' USING ERRCODE = 'JW001';
        END IF;
        IF NEW.reference_attempts < OLD.reference_attempts THEN
          RAISE EXCEPTION 'reference_attempts cannot decrease' USING ERRCODE = 'JW001';
        END IF;
        RETURN NEW;
      END $$`);
    this.addSql(`
      CREATE TRIGGER trg_wager_before_update BEFORE UPDATE ON wager_transactions
      FOR EACH ROW EXECUTE FUNCTION jw_wager_before_update()`);

    // ---------- (deferred) transaction status <-> ledger ---------------------------
    this.addSql(`
      CREATE FUNCTION jw_wager_ledger_check() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        entries integer;
        current_status text;
      BEGIN
        -- evaluate the row as it is at commit time, not as it was when the event fired
        SELECT status INTO current_status FROM wager_transactions WHERE id = NEW.id;
        SELECT count(*) INTO entries FROM wallet_ledger_entries WHERE transaction_id = NEW.id;
        IF current_status = 'PROCESSED' AND NEW.kind <> 'LOSS' THEN
          IF entries <> 1 THEN
            RAISE EXCEPTION 'processed % % must have exactly one ledger entry, found %', NEW.kind, NEW.id, entries
              USING ERRCODE = 'JW001';
          END IF;
        ELSIF entries <> 0 THEN
          RAISE EXCEPTION '% transaction % (%) must not have ledger entries', NEW.kind, NEW.id, current_status
            USING ERRCODE = 'JW001';
        END IF;
        RETURN NULL;
      END $$`);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER trg_wager_ledger_check AFTER INSERT OR UPDATE ON wager_transactions
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION jw_wager_ledger_check()`);

    // ---------- outbox: committed events cannot disappear ---------------------------
    this.addSql(`
      CREATE FUNCTION jw_outbox_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          IF OLD.status <> 'PUBLISHED' THEN
            RAISE EXCEPTION 'outbox message % is % and cannot be deleted', OLD.id, OLD.status USING ERRCODE = 'JW001';
          END IF;
          RETURN OLD;
        END IF;
        IF NEW.payload <> OLD.payload OR NEW.event_type <> OLD.event_type OR NEW.id <> OLD.id
           OR NEW.message_group_id <> OLD.message_group_id OR NEW.occurred_at <> OLD.occurred_at THEN
          RAISE EXCEPTION 'outbox message content is immutable' USING ERRCODE = 'JW001';
        END IF;
        IF OLD.status = 'PUBLISHED' AND NEW.status <> 'PUBLISHED' THEN
          RAISE EXCEPTION 'published outbox message cannot be reopened' USING ERRCODE = 'JW001';
        END IF;
        IF NEW.attempts < OLD.attempts THEN
          RAISE EXCEPTION 'outbox attempts cannot decrease' USING ERRCODE = 'JW001';
        END IF;
        RETURN NEW;
      END $$`);
    this.addSql(`
      CREATE TRIGGER trg_outbox_guard BEFORE UPDATE OR DELETE ON outbox_messages
      FOR EACH ROW EXECUTE FUNCTION jw_outbox_guard()`);

    // ---------- inbox: terminal rows are immutable ----------------------------------
    this.addSql(`
      CREATE FUNCTION jw_inbox_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'inbox messages cannot be deleted by the application' USING ERRCODE = 'JW001';
        END IF;
        IF OLD.status <> 'RECEIVED' AND (NEW.status <> OLD.status OR NEW.result IS DISTINCT FROM OLD.result
           OR NEW.transaction_id IS DISTINCT FROM OLD.transaction_id) THEN
          RAISE EXCEPTION 'inbox message % is % (terminal)', OLD.id, OLD.status USING ERRCODE = 'JW001';
        END IF;
        IF NEW.consumer_name <> OLD.consumer_name OR NEW.message_id <> OLD.message_id THEN
          RAISE EXCEPTION 'inbox identity is immutable' USING ERRCODE = 'JW001';
        END IF;
        RETURN NEW;
      END $$`);
    this.addSql(`
      CREATE TRIGGER trg_inbox_guard BEFORE UPDATE OR DELETE ON inbox_messages
      FOR EACH ROW EXECUTE FUNCTION jw_inbox_guard()`);
  }

  override async down(): Promise<void> {
    this.addSql('DROP TRIGGER IF EXISTS trg_inbox_guard ON inbox_messages');
    this.addSql('DROP TRIGGER IF EXISTS trg_outbox_guard ON outbox_messages');
    this.addSql('DROP TRIGGER IF EXISTS trg_wager_ledger_check ON wager_transactions');
    this.addSql('DROP TRIGGER IF EXISTS trg_wager_before_update ON wager_transactions');
    this.addSql('DROP TRIGGER IF EXISTS trg_wallets_ledger_check ON wallets');
    this.addSql('DROP TRIGGER IF EXISTS trg_wallets_before_update ON wallets');
    this.addSql('DROP TRIGGER IF EXISTS trg_ledger_before_insert ON wallet_ledger_entries');
    this.addSql('DROP TRIGGER IF EXISTS trg_wager_no_delete ON wager_transactions');
    this.addSql('DROP TRIGGER IF EXISTS trg_wallets_no_delete ON wallets');
    this.addSql('DROP TRIGGER IF EXISTS trg_ledger_append_only ON wallet_ledger_entries');
    for (const table of ['wallet_ledger_entries', 'wager_transactions', 'wallets', 'outbox_messages', 'inbox_messages']) {
      this.addSql(`DROP TRIGGER IF EXISTS trg_${table}_no_truncate ON ${table}`);
    }
    this.addSql('DROP FUNCTION IF EXISTS jw_inbox_guard()');
    this.addSql('DROP FUNCTION IF EXISTS jw_outbox_guard()');
    this.addSql('DROP FUNCTION IF EXISTS jw_wager_ledger_check()');
    this.addSql('DROP FUNCTION IF EXISTS jw_wager_before_update()');
    this.addSql('DROP FUNCTION IF EXISTS jw_wallets_ledger_check()');
    this.addSql('DROP FUNCTION IF EXISTS jw_wallets_before_update()');
    this.addSql('DROP FUNCTION IF EXISTS jw_ledger_before_insert()');
    this.addSql('DROP FUNCTION IF EXISTS jw_forbid_change()');
  }
}
