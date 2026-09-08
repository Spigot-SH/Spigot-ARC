import { Request, Response, NextFunction } from 'express';
import { getDb } from '../db/connection';
import { Publisher } from '../types';
import { User } from '../services/session';

export interface AuthRequest extends Request {
  publisher?: Publisher;
  user?: User;
}

/**
 * Resolve the acting publisher.
 *
 * The browser authenticates with the httpOnly session cookie, which JavaScript cannot read —
 * so an XSS on the dashboard can no longer steal a long-lived credential and redirect a
 * vendor's payouts. The `X-API-Key` header remains for server-to-server clients, where there
 * is no browser to attack.
 */
export const authenticate = (req: AuthRequest, res: Response, next: NextFunction) => {
  const db = getDb();

  // Preferred: a signed-in user who owns a publisher account.
  if (req.user?.id) {
    let linked = db
      .prepare(
        `
        SELECT p.* FROM publishers p
        JOIN users u ON u.publisher_id = p.id
        WHERE u.id = ?
      `,
      )
      .get(req.user.id) as Publisher | undefined;

    if (!linked && req.user.email) {
      linked = db
        .prepare('SELECT * FROM publishers WHERE LOWER(email) = LOWER(?)')
        .get(req.user.email) as Publisher | undefined;
      if (linked) {
        db.prepare('UPDATE users SET publisher_id = ? WHERE id = ?').run(linked.id, req.user.id);
      }
    }

    if (linked) {
      req.publisher = linked;
      return next();
    }
  }

  const apiKey = req.header('X-API-Key');
  if (!apiKey) {
    return res.status(401).json({ error: 'Sign in, or supply an X-API-Key header' });
  }

  const publisher = db.prepare('SELECT * FROM publishers WHERE api_key = ?').get(apiKey) as
    Publisher | undefined;

  if (!publisher) {
    return res.status(401).json({ error: 'Invalid API key' });
  }

  req.publisher = publisher;
  next();
};

export const getAuthenticatedPublisher = (req: AuthRequest): Publisher => {
  if (!req.publisher) throw new Error('Publisher not authenticated');
  return req.publisher;
};
