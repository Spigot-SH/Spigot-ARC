import crypto from 'crypto';
import { Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection';
import { config } from '../config';
import { hashToken } from './vault';

export const SESSION_COOKIE = 'spigot_session';
export const LEGACY_SESSION_COOKIE = 'x402_session';

export interface User {
  id: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
  email_verified: number;
  auth_providers: string;
  publisher_id: string | null;
  created_at: string;
}

/**
 * Sessions are opaque random tokens stored as hashes, so a database leak cannot be
 * replayed and any session can be revoked server-side.
 */
export const createSession = (userId: string, userAgent?: string): string => {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + config.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

  getDb()
    .prepare(
      `
      INSERT INTO sessions (id, user_id, token_hash, user_agent, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `,
    )
    .run(
      uuidv4(),
      userId,
      hashToken(token),
      userAgent?.slice(0, 255) || null,
      expiresAt.toISOString(),
    );

  return token;
};

export const resolveSession = (token: string): User | null => {
  const db = getDb();
  const session = db
    .prepare(
      `
      SELECT * FROM sessions
      WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP
    `,
    )
    .get(hashToken(token)) as { user_id: string } | undefined;

  if (!session) return null;
  return (db.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id) as User) || null;
};

export const revokeSession = (token: string): void => {
  getDb()
    .prepare('UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP WHERE token_hash = ?')
    .run(hashToken(token));
};

export const setSessionCookie = (res: Response, token: string): void => {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: config.IS_PRODUCTION,
    sameSite: 'lax',
    maxAge: config.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
    path: '/',
  });
};

export const clearSessionCookie = (res: Response): void => {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.clearCookie(LEGACY_SESSION_COOKIE, { path: '/' });
};

/** Public view of a user — never includes wallet keys. */
export const publicUser = (user: User) => ({
  id: user.id,
  email: user.email,
  name: user.name,
  avatarUrl: user.avatar_url,
  emailVerified: Boolean(user.email_verified),
  authProviders: JSON.parse(user.auth_providers || '[]'),
  // Populated once a user registers as a publisher; the CLI needs it to address
  // publisher-scoped routes.
  publisherId: user.publisher_id || null,
});
