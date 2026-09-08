import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection';
import { User } from './session';
import { createCustodialWallet, createCustodialEvmWallet } from './wallet';

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

export const isValidEmail = (email: string): boolean =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;

export const findUserByEmail = (email: string): User | undefined =>
  getDb().prepare('SELECT * FROM users WHERE email = ?').get(normalizeEmail(email)) as
    User | undefined;

interface UpsertOptions {
  name?: string | null;
  avatarUrl?: string | null;
  provider: 'google' | 'magic_link' | 'otp';
}

/**
 * Find or create the user for an email, record which provider signed them in, and make
 * sure they have a custodial wallet. Wallet provisioning runs in the background so a
 * slow chain never blocks sign-in.
 */
export const upsertUser = (
  email: string,
  options: UpsertOptions,
): { user: User; isNew: boolean } => {
  const db = getDb();
  const normalized = normalizeEmail(email);
  const existing = findUserByEmail(normalized);

  const existingPublisher = db
    .prepare('SELECT id FROM publishers WHERE LOWER(email) = LOWER(?)')
    .get(normalized) as { id: string } | undefined;
  const publisherId = existingPublisher?.id || null;

  if (existing) {
    const providers: string[] = JSON.parse(existing.auth_providers || '[]');
    if (!providers.includes(options.provider)) providers.push(options.provider);

    db.prepare(
      `
      UPDATE users
      SET name = COALESCE(?, name),
          avatar_url = COALESCE(?, avatar_url),
          auth_providers = ?,
          publisher_id = COALESCE(publisher_id, ?),
          email_verified = 1,
          last_login_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
    ).run(
      options.name || null,
      options.avatarUrl || null,
      JSON.stringify(providers),
      publisherId,
      existing.id,
    );

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(existing.id) as User;
    ensureWallet(user.id);
    return { user, isNew: false };
  }

  const id = uuidv4();
  db.prepare(
    `
    INSERT INTO users (id, email, name, avatar_url, email_verified, auth_providers, publisher_id, last_login_at)
    VALUES (?, ?, ?, ?, 1, ?, ?, CURRENT_TIMESTAMP)
  `,
  ).run(
    id,
    normalized,
    options.name || null,
    options.avatarUrl || null,
    JSON.stringify([options.provider]),
    publisherId,
  );

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as User;
  ensureWallet(user.id);
  return { user, isNew: true };
};

/**
 * Create the wallet records for both Algorand and EVM chains.
 *
 * Algorand wallet activation is not funded until explicit top-up. EVM wallets require no
 * minimum balance opt-in and are immediately addressable.
 */
export const ensureWallet = (userId: string) => {
  const algoWallet = createCustodialWallet(userId, 'algorand');
  const evmWallet = createCustodialEvmWallet(userId);
  return { algoWallet, evmWallet };
};
