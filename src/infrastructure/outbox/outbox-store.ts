import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import type { Clock } from '../../application/ports/persistence';
import type { EventEnvelope } from '../../domain/events/integration-event';
import { OutboxMessage, type OutboxStatus } from '../../domain/messaging/outbox-message';

interface OutboxRow {
  id: string;
  event_type: string;
  event_version: number;
  aggregate_type: string;
  aggregate_id: string;
  message_group_id: string;
  payload: EventEnvelope | string;
  status: string;
  attempts: number;
  next_attempt_at: Date | string;
  locked_by: string | null;
  locked_until: Date | string | null;
  last_error: string | null;
  published_at: Date | string | null;
  occurred_at: Date | string;
  created_at: Date | string;
}

const toDate = (v: Date | string): Date => (v instanceof Date ? v : new Date(v));

function fromRow(row: OutboxRow): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: row.id,
    eventType: row.event_type,
    eventVersion: Number(row.event_version),
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    messageGroupId: row.message_group_id,
    payload: typeof row.payload === 'string' ? (JSON.parse(row.payload) as EventEnvelope) : row.payload,
    status: row.status as OutboxStatus,
    attempts: Number(row.attempts),
    nextAttemptAt: toDate(row.next_attempt_at),
    lockedBy: row.locked_by,
    lockedUntil: row.locked_until === null ? null : toDate(row.locked_until),
    lastError: row.last_error,
    publishedAt: row.published_at === null ? null : toDate(row.published_at),
    occurredAt: toDate(row.occurred_at),
    createdAt: toDate(row.created_at),
  });
}

export interface OutboxStats {
  pending: number;
  oldestPendingAgeSeconds: number;
}

/**
 * Publisher-side access to outbox_messages. Each method is one short autocommit
 * statement, so no SQL transaction stays open while talking to the broker.
 *
 * Lease protocol:
 *  claim   — atomically pick due rows with FOR UPDATE SKIP LOCKED (concurrent publishers
 *            never pick the same row at the same time), stamp locked_by/locked_until,
 *            count the attempt. Uses the database clock, so instances need no clock sync.
 *  publish — happens outside any transaction.
 *  settle  — mark PUBLISHED, or record the failure and schedule a retry.
 *  crash   — the lease expires and another publisher re-claims the row (duplicate
 *            publication possible → at-least-once; consumers dedupe by eventId).
 */
export class OutboxStore {
  constructor(
    private readonly orm: MikroORM,
    private readonly clock: Clock,
  ) {}

  private em(): EntityManager {
    return this.orm.em.fork({ clear: true }) as EntityManager;
  }

  async claimBatch(owner: string, limit: number, leaseMs: number): Promise<OutboxMessage[]> {
    const rows = await this.em().execute<OutboxRow[]>(
      `UPDATE outbox_messages o
          SET locked_by = ?,
              locked_until = now() + (? * interval '1 millisecond'),
              attempts = o.attempts + 1
        WHERE o.id IN (
              SELECT id FROM outbox_messages
               WHERE status = 'PENDING'
                 AND next_attempt_at <= now()
                 AND (locked_until IS NULL OR locked_until < now())
               ORDER BY seq
               LIMIT ?
               FOR UPDATE SKIP LOCKED)
      RETURNING o.*`,
      [owner, leaseMs, limit],
    );
    return rows.map(fromRow).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  /** Marks as published. Deliberately not fenced by owner: the event *was* sent. */
  async markPublished(ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => '?').join(', ');
    const result = await this.em().execute<{ affectedRows?: number }>(
      `UPDATE outbox_messages
          SET status = 'PUBLISHED', published_at = now(), locked_by = NULL, locked_until = NULL
        WHERE status = 'PENDING' AND id IN (${placeholders})`,
      [...ids],
      'run',
    );
    return Number(result.affectedRows ?? 0);
  }

  /** Persists a failed attempt — only while we still own the lease (fencing). */
  /**
   * Persists a failed attempt — only while we still own the lease (fencing).
   * The retry time is computed on the DATABASE clock (now() + delay), like the lease
   * and the claim, so app-server clock skew can neither stall nor skip the backoff.
   * `decidedAt` is the instant the domain used to compute message.nextAttemptAt.
   */
  async saveFailure(message: OutboxMessage, owner: string, decidedAt: Date): Promise<boolean> {
    const delayMs = Math.max(0, message.nextAttemptAt.getTime() - decidedAt.getTime());
    const result = await this.em().execute<{ affectedRows?: number }>(
      `UPDATE outbox_messages
          SET status = ?,
              next_attempt_at = CASE WHEN ? = 'DEAD' THEN next_attempt_at ELSE now() + (? * interval '1 millisecond') END,
              last_error = ?, locked_by = NULL, locked_until = NULL
        WHERE id = ? AND locked_by = ? AND status = 'PENDING'`,
      [message.status, message.status, delayMs, message.lastError, message.id, owner],
      'run',
    );
    return Number(result.affectedRows ?? 0) === 1;
  }

  /** Served by the partial index ix_outbox_pending (status = 'PENDING'): cheap at any table size. */
  async stats(): Promise<OutboxStats> {
    const rows = await this.em().execute<{ pending: number; lag: number | null }[]>(
      `SELECT count(*)::int AS pending,
              EXTRACT(EPOCH FROM (now() - min(created_at)))::float8 AS lag
         FROM outbox_messages
        WHERE status = 'PENDING'`,
    );
    const row = rows[0];
    return {
      pending: Number(row?.pending ?? 0),
      oldestPendingAgeSeconds: row?.lag === null || row?.lag === undefined ? 0 : Math.max(0, Number(row.lag)),
    };
  }

  now(): Date {
    return this.clock.now();
  }
}
