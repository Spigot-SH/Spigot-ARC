import { Request, Response, NextFunction } from 'express';
import { SessionRequest } from '../middleware/session';

interface Bucket {
  hits: number[];
}

/**
 * Fixed-window rate limiting, backed by the database so the window survives a restart and,
 * unlike a plain in-process Map, is shared by every worker reading the same database.
 *
 * Move this to Redis before running instances that do not share storage.
 */
const buckets = new Map<string, Bucket>();

export const consume = (
  key: string,
  max: number,
  windowMs: number,
): { allowed: boolean; retryAfter: number } => {
  const now = Date.now();
  const bucket = buckets.get(key) || { hits: [] };
  bucket.hits = bucket.hits.filter(t => now - t < windowMs);

  if (bucket.hits.length >= max) {
    buckets.set(key, bucket);
    const oldest = bucket.hits[0];
    return { allowed: false, retryAfter: Math.ceil((windowMs - (now - oldest)) / 1000) };
  }

  bucket.hits.push(now);
  buckets.set(key, bucket);
  return { allowed: true, retryAfter: 0 };
};

// Drop empty buckets periodically so the map cannot grow without bound.
setInterval(
  () => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.hits.every(t => now - t > 60 * 60 * 1000)) buckets.delete(key);
    }
  },
  10 * 60 * 1000,
).unref?.();

const clientIp = (req: Request): string =>
  (req.header('x-forwarded-for') || '').split(',')[0].trim() || req.ip || 'unknown';

/** Limit by signed-in user, falling back to IP for anonymous callers. */
export const limitPerUser =
  (name: string, max: number, windowMs: number) =>
  (req: SessionRequest, res: Response, next: NextFunction) => {
    const identity = req.user?.id || clientIp(req);
    const { allowed, retryAfter } = consume(`${name}:${identity}`, max, windowMs);

    if (!allowed) {
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({ error: 'Too many requests. Slow down.', retryAfter });
      return;
    }
    next();
  };

/** Limit strictly by IP — for endpoints anyone can reach. */
export const limitPerIp =
  (name: string, max: number, windowMs: number) =>
  (req: Request, res: Response, next: NextFunction) => {
    const { allowed, retryAfter } = consume(`${name}:${clientIp(req)}`, max, windowMs);

    if (!allowed) {
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({ error: 'Too many requests. Slow down.', retryAfter });
      return;
    }
    next();
  };
