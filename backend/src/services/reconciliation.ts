import { errorMessage } from './errors';
import { getDb } from '../db/connection';
import { credit } from './credits';

/**
 * Refund credit that was reserved for a call which never settled.
 *
 * `/consume` debits before spending on chain and refunds inline when the payment fails, but
 * a crash between those two points would strand the hold. This sweeps anything older than
 * the grace period that has neither a settlement nor a refund, so a user is never left
 * silently short.
 */
export const reconcileStaleHolds = (graceMinutes = 10): { refunded: number; total: number } => {
  const db = getDb();

  const stale = db
    .prepare(
      `
      SELECT h.id, h.user_id, h.amount, h.reference
      FROM credit_transactions h
      WHERE h.kind = 'SPEND'
        AND h.reference LIKE 'hold:%'
        AND json_extract(h.metadata, '$.state') = 'held'
        AND h.created_at < datetime('now', ?)
        AND NOT EXISTS (
          SELECT 1 FROM credit_transactions r
          WHERE r.reference = 'refund:' || h.reference
        )
    `,
    )
    .all(`-${graceMinutes} minutes`) as {
    id: string;
    user_id: string;
    amount: number;
    reference: string;
  }[];

  let refunded = 0;
  for (const hold of stale) {
    try {
      credit({
        userId: hold.user_id,
        kind: 'REFUND',
        amount: Math.abs(hold.amount),
        source: 'system',
        reference: `refund:${hold.reference}`,
        description: 'Refund — call never settled',
      });
      refunded += 1;
    } catch (error) {
      console.error(`Could not refund stale hold ${hold.reference}:`, errorMessage(error));
    }
  }

  if (refunded > 0) {
    console.log(`Reconciliation: refunded ${refunded} stranded hold(s)`);
  }
  return { refunded, total: stale.length };
};

/** Run the sweep on an interval. Safe to call repeatedly — refunds are idempotent by reference. */
export const startReconciliation = (intervalMinutes = 15) => {
  const run = () => {
    try {
      reconcileStaleHolds();
    } catch (error) {
      console.error('Reconciliation pass failed:', errorMessage(error));
    }
  };

  run();
  return setInterval(run, intervalMinutes * 60_000).unref?.();
};
