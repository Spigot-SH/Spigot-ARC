import type { Database } from 'better-sqlite3';
import { getDb } from './connection';
import { initializeDatabase } from './schema';

/** CREATE TABLE IF NOT EXISTS never alters an existing table, so widen columns explicitly. */
const addColumnIfMissing = (db: Database, table: string, column: string, definition: string) => {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (columns.some(c => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  console.log(`Migration: added ${table}.${column}`);
};

export const runMigrations = () => {
  const db = getDb();
  initializeDatabase(db);

  // Replay protection for x402 v2 payments on databases created before it existed.
  addColumnIfMissing(db, 'transactions', 'payment_hash', 'TEXT');
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_payment_hash ON transactions(payment_hash)',
  );

  addColumnIfMissing(db, 'usage', 'user_id', 'TEXT');
  addColumnIfMissing(db, 'transactions', 'user_id', 'TEXT');
  addColumnIfMissing(db, 'custodial_wallets', 'chain', "TEXT NOT NULL DEFAULT 'algorand'");

  migrateCustodialWalletsConstraint(db);

  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_custodial_wallets_user_chain ON custodial_wallets(user_id, chain)',
  );

  retireEmailWallets(db);

  console.log('Database initialized successfully.');
};

/**
 * Ensure custodial_wallets supports multiple chain wallets per user (Algorand + EVM)
 * by migrating from legacy UNIQUE(user_id) to UNIQUE(user_id, chain).
 */
const migrateCustodialWalletsConstraint = (db: Database) => {
  const table = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'custodial_wallets'")
    .get() as { sql?: string } | undefined;

  if (!table || !table.sql) return;

  const needsMigration =
    table.sql.includes('user_id TEXT NOT NULL UNIQUE') ||
    table.sql.includes('user_id TEXT UNIQUE') ||
    !table.sql.includes('UNIQUE(user_id, chain)');

  if (needsMigration) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS custodial_wallets_new (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id),
          chain TEXT NOT NULL DEFAULT 'arc-testnet',
          address TEXT NOT NULL,
          encrypted_key TEXT NOT NULL,
          opted_in BOOLEAN NOT NULL DEFAULT 0,
          funded_at DATETIME,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(user_id, chain)
        );
        INSERT OR IGNORE INTO custodial_wallets_new (id, user_id, chain, address, encrypted_key, opted_in, funded_at, created_at)
          SELECT id, user_id, COALESCE(chain, 'arc-testnet'), address, encrypted_key, opted_in, funded_at, created_at FROM custodial_wallets;
        DROP TABLE custodial_wallets;
        ALTER TABLE custodial_wallets_new RENAME TO custodial_wallets;
      `);
      console.log('Migration: migrated custodial_wallets table to UNIQUE(user_id, chain)');
    })();
  }
};

/**
 * Remove the legacy `email_wallets` table, which stored plaintext mnemonics and served them
 * over HTTP to anyone who guessed an email address.
 *
 * Those keys must be considered public. The table is only dropped once it is empty — if
 * rows remain, we refuse and print the addresses so their balances can be swept first,
 * because dropping it destroys the only copy of those keys.
 */
const retireEmailWallets = (db: Database) => {
  const exists = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'email_wallets'")
    .get();
  if (!exists) return;

  const rows = db.prepare('SELECT address FROM email_wallets').all() as { address: string }[];

  if (rows.length === 0) {
    db.exec('DROP TABLE email_wallets');
    console.log('Migration: dropped the legacy email_wallets table');
    return;
  }

  console.warn(
    `\nWARNING: ${rows.length} legacy email_wallets row(s) still hold PLAINTEXT mnemonics.\n` +
      'Those keys were previously served over HTTP and must be treated as compromised.\n' +
      'Sweep any balance from these addresses, then delete the rows to let this migration drop the table:\n' +
      rows.map(r => `  ${r.address}`).join('\n') +
      '\n',
  );
};
