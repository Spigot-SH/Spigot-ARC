import { errorMessage } from '../services/errors';
import Database from 'better-sqlite3';
import { createClient, Client } from '@libsql/client';
import { config } from '../config';
import fs from 'fs';
import path from 'path';

const tursoUrl = process.env.TURSO_DATABASE_URL || config.TURSO_DATABASE_URL;
const tursoToken = process.env.TURSO_AUTH_TOKEN || config.TURSO_AUTH_TOKEN;

const dbPath = config.DATABASE_PATH;
const dbDir = path.dirname(dbPath);

if (!fs.existsSync(dbDir)) {
  try {
    fs.mkdirSync(dbDir, { recursive: true });
  } catch (err) {
    console.error('Failed to create db directory:', err);
  }
}

let db: Database.Database | null = null;
let tursoClient: Client | null = null;
let tursoInitialSynced = false;

if (tursoUrl && tursoToken) {
  try {
    tursoClient = createClient({ url: tursoUrl, authToken: tursoToken });
  } catch (e) {
    // Ignore offline initialization
  }
}

/** A value SQLite can store, which is everything a row column can hold. */
type SqlValue = string | number | bigint | boolean | Uint8Array | null;

/**
 * Replicate one row to Turso.
 *
 * Accepts any object because callers pass typed row interfaces (`Api`, `Pricing`, …) which
 * have no index signature. The values are narrowed to `SqlValue` here, at the one place that
 * actually talks to the driver.
 */
export const syncTursoRecord = (table: string, record: object) => {
  if (!tursoClient) return;
  const row = record as Record<string, SqlValue | undefined>;
  const keys = Object.keys(row);
  if (keys.length === 0) return;

  const cols = keys.join(', ');
  const placeholders = keys.map(() => '?').join(', ');
  const args: SqlValue[] = keys.map(k => row[k] ?? null);

  const sql = `INSERT OR REPLACE INTO ${table} (${cols}) VALUES (${placeholders})`;
  tursoClient.execute({ sql, args }).catch((error: unknown) => {
    // Replication is best-effort, but a silent failure means the replica drifts out of
    // date without anyone noticing. Log it, and rate-limit the noise if it keeps failing.
    reportSyncFailure(table, errorMessage(error, String(error)));
  });
};

let syncFailures = 0;
let lastSyncWarning = 0;

const reportSyncFailure = (table: string, message: string) => {
  syncFailures += 1;
  const now = Date.now();

  // One line per minute is enough to notice; more would drown the log.
  if (now - lastSyncWarning > 60_000) {
    lastSyncWarning = now;
    console.warn(
      `Turso replication failing (${syncFailures} failure(s) so far, latest on '${table}'): ${message}`,
    );
  }
};

/** Replication health, so a drifting replica is visible rather than silent. */
export const getSyncStatus = () => ({
  enabled: Boolean(tursoClient),
  failures: syncFailures,
  healthy: !tursoClient || syncFailures === 0,
});

export const getDb = (): Database.Database => {
  if (!db) {
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // On container boot in serverless, pull latest data from Turso Cloud DB
    if (tursoClient && !tursoInitialSynced) {
      tursoInitialSynced = true;
      const currentDb = db;

      const tables = [
        'publishers',
        'apis',
        'endpoints',
        'pricing',
        'wallets',
        'verifications',
        'skills',
        'email_wallets',
      ];
      tables.forEach(table => {
        tursoClient!
          .execute(`SELECT * FROM ${table}`)
          .then(res => {
            if (res.rows && res.rows.length > 0 && currentDb) {
              for (const r of res.rows) {
                const keys = Object.keys(r);
                const cols = keys.join(', ');
                const placeholders = keys.map(() => '?').join(', ');
                const args = keys.map(k => r[k] ?? null);
                try {
                  currentDb
                    .prepare(`INSERT OR REPLACE INTO ${table} (${cols}) VALUES (${placeholders})`)
                    .run(...args);
                } catch (e) {
                  // Ignore transient sync conflicts
                }
              }
            }
          })
          .catch(() => {});
      });
    }
  }
  return db;
};
