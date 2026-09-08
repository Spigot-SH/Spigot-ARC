import { errorMessage, errorField } from '../services/errors';
import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import dns from 'dns/promises';
import { getDb } from '../db/connection';
import { authenticate, AuthRequest } from '../middleware/auth';
import { config } from '../config';
import type { Verification } from '../types';

export const router = Router();

const TXT_PREFIX = 'spigot-verification=';
const TXT_PREFIX_LEGACY = 'x402-verification=';

/** Strip scheme, path and port so DNS lookups get a bare hostname. */
const toHostname = (input: string): string | null => {
  const cleaned = input
    .trim()
    .replace(/^https?:\/\//, '')
    .split('/')[0]
    .split(':')[0];
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(cleaned) ? cleaned.toLowerCase() : null;
};

router.post('/initiate', authenticate, (req: AuthRequest, res) => {
  const domain = toHostname(String(req.body?.domain || ''));
  if (!domain) return res.status(400).json({ error: 'A valid domain is required' });

  const challenge = crypto.randomBytes(32).toString('hex');
  const id = uuidv4();
  const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();

  getDb()
    .prepare(
      `
    INSERT INTO verifications (id, publisher_id, domain, challenge, status, expires_at)
    VALUES (?, ?, ?, ?, 'PENDING', ?)
  `,
    )
    .run(id, req.publisher!.id, domain, challenge, expiresAt);

  res.json({
    id,
    challenge,
    expires_at: expiresAt,
    record: { type: 'TXT', name: domain, value: `${TXT_PREFIX}${challenge}` },
    instructions: `Add a TXT record on ${domain} with the value ${TXT_PREFIX}${challenge}, then check again.`,
  });
});

router.post('/check', authenticate, async (req: AuthRequest, res) => {
  const db = getDb();
  const v = db
    .prepare<unknown[], Verification>('SELECT * FROM verifications WHERE id = ?')
    .get(req.body?.verification_id);

  if (!v) return res.status(404).json({ error: 'Verification not found' });
  if (v.publisher_id !== req.publisher!.id) return res.status(403).json({ error: 'Forbidden' });
  if (v.status === 'VERIFIED') return res.json({ status: 'VERIFIED' });
  if (new Date(v.expires_at) < new Date()) {
    return res.status(410).json({ status: 'EXPIRED', error: 'Challenge expired — start again' });
  }

  const markVerified = () => {
    db.prepare(
      "UPDATE verifications SET status = 'VERIFIED', verified_at = CURRENT_TIMESTAMP WHERE id = ?",
    ).run(v.id);
    db.prepare('UPDATE publishers SET domain = ? WHERE id = ?').run(v.domain, req.publisher!.id);
  };

  if (config.DOMAIN_VERIFY_BYPASS) {
    markVerified();
    return res.json({ status: 'VERIFIED', bypassed: true });
  }

  // Proof of control: the challenge must appear in a TXT record on the domain itself.
  try {
    const records = await dns.resolveTxt(v.domain);
    const found = records.some(chunks => {
      const text = chunks.join('').trim();
      return (
        text === `${TXT_PREFIX}${v.challenge}` || text === `${TXT_PREFIX_LEGACY}${v.challenge}`
      );
    });

    if (!found) {
      return res.status(400).json({
        status: 'PENDING',
        error: 'TXT record not found yet. DNS changes can take a few minutes to propagate.',
      });
    }

    markVerified();
    res.json({ status: 'VERIFIED' });
  } catch (error) {
    res.status(400).json({
      status: 'PENDING',
      error:
        errorField<string>(error, 'code') === 'ENOTFOUND' ||
        errorField<string>(error, 'code') === 'ENODATA'
          ? 'No TXT records found for that domain yet'
          : `DNS lookup failed: ${errorMessage(error, 'unknown error')}`,
    });
  }
});
