import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection';
import { config } from '../config';

export type CreditKind = 'RECHARGE' | 'SPEND' | 'REFUND' | 'ADJUST';
export type CreditSource = 'crypto' | 'fiat' | 'stripe' | 'system';

export interface CreditEntry {
  id: string;
  user_id: string;
  kind: CreditKind;
  amount: number;
  balance_after: number;
  source: CreditSource;
  reference: string | null;
  description: string | null;
  created_at: string;
}

/** Credits are held to 6 decimals, matching USDC, so arithmetic never drifts. */
const round = (value: number): number => Math.round(value * 1e6) / 1e6;

/**
 * Balance is derived from the ledger rather than stored on the user, so it can always be
 * recomputed and can never silently disagree with its own history.
 */
export const getBalance = (userId: string): number => {
  const row = getDb()
    .prepare(
      'SELECT COALESCE(SUM(amount), 0) AS balance FROM credit_transactions WHERE user_id = ?',
    )
    .get(userId) as { balance: number };
  return round(row?.balance || 0);
};

export class InsufficientCredit extends Error {
  constructor(
    public required: number,
    public available: number,
  ) {
    super(`Insufficient credit: ${required} required, ${available} available`);
    this.name = 'InsufficientCredit';
  }
}

export class DuplicateCredit extends Error {
  constructor(public reference: string) {
    super(`Credit for reference ${reference} has already been applied`);
    this.name = 'DuplicateCredit';
  }
}

interface EntryInput {
  userId: string;
  kind: CreditKind;
  amount: number;
  source?: CreditSource;
  reference?: string | null;
  description?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Append a ledger entry inside a transaction, so balance is read and written atomically.
 *
 * `reference` is uniquely indexed: replaying the same on-chain transaction or webhook can
 * never credit twice, which is the property that makes recharge safe to retry.
 */
export const record = (input: EntryInput): CreditEntry => {
  const db = getDb();

  const write = db.transaction((entry: EntryInput) => {
    if (entry.reference) {
      const existing = db
        .prepare('SELECT id FROM credit_transactions WHERE reference = ?')
        .get(entry.reference);
      if (existing) throw new DuplicateCredit(entry.reference);
    }

    const current = getBalance(entry.userId);
    const amount = round(entry.amount);
    const next = round(current + amount);

    // A debit may never take the balance negative — the ledger is the spend authority.
    if (amount < 0 && next < 0) throw new InsufficientCredit(Math.abs(amount), current);

    const id = uuidv4();
    db.prepare(
      `
      INSERT INTO credit_transactions
        (id, user_id, kind, amount, balance_after, source, reference, description, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      id,
      entry.userId,
      entry.kind,
      amount,
      next,
      entry.source || 'system',
      entry.reference || null,
      entry.description || null,
      entry.metadata ? JSON.stringify(entry.metadata) : null,
    );

    return db.prepare('SELECT * FROM credit_transactions WHERE id = ?').get(id) as CreditEntry;
  });

  return write(input);
};

export const credit = (input: Omit<EntryInput, 'kind'> & { kind?: CreditKind }): CreditEntry =>
  record({ ...input, kind: input.kind || 'RECHARGE', amount: Math.abs(input.amount) });

export const debit = (input: Omit<EntryInput, 'kind'> & { kind?: CreditKind }): CreditEntry =>
  record({ ...input, kind: input.kind || 'SPEND', amount: -Math.abs(input.amount) });

export const getHistory = (userId: string, limit = 50): CreditEntry[] =>
  getDb()
    .prepare(
      'SELECT * FROM credit_transactions WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
    )
    .all(userId, limit) as CreditEntry[];

export interface Tier {
  id: string;
  label: string;
  amountUsdc: number;
}

/**
 * Purchasable amounts. The user is credited the full tier even when network or facilitator
 * costs mean slightly less arrives — the shortfall is absorbed so the balance matches what
 * they believe they bought.
 */
export const TIERS: Tier[] = [
  { id: 'starter', label: '$5', amountUsdc: 5 },
  { id: 'standard', label: '$20', amountUsdc: 20 },
  { id: 'pro', label: '$50', amountUsdc: 50 },
];

export const resolveTier = (tierId?: string, customAmount?: number): Tier | null => {
  if (tierId && tierId !== 'custom') {
    return TIERS.find(t => t.id === tierId) || null;
  }

  const amount = round(Number(customAmount));
  if (
    !Number.isFinite(amount) ||
    amount < config.MIN_RECHARGE_USDC ||
    amount > config.MAX_RECHARGE_USDC
  ) {
    return null;
  }
  return { id: 'custom', label: `$${amount}`, amountUsdc: amount };
};

/** Total credits outstanding across all users — what the custody account must cover. */
export const getOutstandingCredits = (): number => {
  const row = getDb()
    .prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM credit_transactions')
    .get() as { total: number };
  return round(row?.total || 0);
};
