import { Request, Response, NextFunction } from 'express';
import { SESSION_COOKIE, LEGACY_SESSION_COOKIE, resolveSession, User } from '../services/session';

export interface SessionRequest extends Request {
  user?: User;
  sessionToken?: string;
}

const extractToken = (req: Request): string | undefined => {
  // cookie-parser types `cookies` as Record<string, any>, so narrow before trusting it.
  const cookieToken: unknown =
    req.cookies?.[SESSION_COOKIE] || req.cookies?.[LEGACY_SESSION_COOKIE];
  if (typeof cookieToken === 'string' && cookieToken) return cookieToken;

  // Bearer tokens let scripts and agents use the same sessions as the browser.
  const header = req.header('authorization');
  if (header?.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();

  return undefined;
};

/** Attaches req.user when a valid session is present. Never rejects. */
export const withSession = (req: SessionRequest, _res: Response, next: NextFunction) => {
  const token = extractToken(req);
  if (token) {
    const user = resolveSession(token);
    if (user) {
      req.user = user;
      req.sessionToken = token;
    }
  }
  next();
};

/** Rejects the request unless a valid session is present. */
export const requireSession = (req: SessionRequest, res: Response, next: NextFunction) => {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  next();
};
