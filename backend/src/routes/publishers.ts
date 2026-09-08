import { errorMessage } from '../services/errors';
import crypto from 'crypto';
import { Router } from 'express';
import algosdk from 'algosdk';
import { v4 as uuidv4 } from 'uuid';
import { getDb, syncTursoRecord } from '../db/connection';
import { authenticate, AuthRequest } from '../middleware/auth';
import { SessionRequest, requireSession } from '../middleware/session';
import { limitPerIp, limitPerUser } from '../services/rateLimit';
import { hashToken, safeEqual } from '../services/vault';
import { sendEmail, payoutChangeEmail } from '../services/mailer';
import type { Publisher, Wallet, AuthToken } from '../types';

export const router = Router();

/**
 * Become a publisher.
 *
 * Requires a signed-in session: unauthenticated creation let anyone mint publisher accounts
 * and API keys at will. The new publisher is linked to the user, so the dashboard works off
 * the session cookie and the API key is only needed by server-to-server clients.
 */
router.post(
  '/',
  requireSession,
  limitPerIp('publisher-create', 5, 60 * 60_000),
  (req: SessionRequest, res) => {
    const { name, company, website } = req.body;
    // The verified session email is authoritative — a caller cannot claim someone else's.
    const email = req.user!.email;
    if (!name) return res.status(400).json({ error: 'Name is required' });

    const db0 = getDb();
    const alreadyLinked = db0
      .prepare('SELECT publisher_id FROM users WHERE id = ?')
      .get(req.user!.id) as { publisher_id: string | null } | undefined;

    if (alreadyLinked?.publisher_id) {
      const existing = db0
        .prepare<unknown[], Pick<Publisher, 'id' | 'api_key'>>(
          'SELECT id, api_key FROM publishers WHERE id = ?',
        )
        .get(alreadyLinked.publisher_id);
      if (existing) return res.json({ id: existing.id, api_key: existing.api_key });
    }

    const id = uuidv4();
    const apiKey = `pk_test_${uuidv4().replace(/-/g, '')}`;

    const db = getDb();
    try {
      db.prepare(
        `
      INSERT INTO publishers (id, name, email, company, website, api_key, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
      ).run(id, name, email, company || null, website || null, apiKey, 'ACTIVE');

      // Link it to the user so the dashboard authenticates off the session cookie.
      db.prepare('UPDATE users SET publisher_id = ? WHERE id = ?').run(id, req.user!.id);

      const publisherObj = db
        .prepare<unknown[], Publisher>('SELECT * FROM publishers WHERE id = ?')
        .get(id);
      if (publisherObj) syncTursoRecord('publishers', publisherObj);

      res.json({ id, api_key: apiKey });
    } catch (error) {
      // The email already belongs to a publisher — claim it for this verified user.
      if (errorMessage(error)?.includes('UNIQUE constraint')) {
        const existing = db
          .prepare<unknown[], Pick<Publisher, 'id' | 'api_key'>>(
            'SELECT id, api_key FROM publishers WHERE email = ?',
          )
          .get(email);
        if (existing) {
          db.prepare('UPDATE users SET publisher_id = ? WHERE id = ?').run(
            existing.id,
            req.user!.id,
          );
          return res.json({ id: existing.id, api_key: existing.api_key });
        }
      }
      console.error('Publisher creation failed:', errorMessage(error));
      res.status(500).json({ error: 'Could not create the publisher account' });
    }
  },
);

router.get('/:id', authenticate, (req: AuthRequest, res) => {
  if (req.publisher?.id !== req.params.id) return res.status(403).json({ error: 'Forbidden' });
  res.json(req.publisher);
});

router.put('/:id', authenticate, (req: AuthRequest, res) => {
  if (req.publisher?.id !== req.params.id) return res.status(403).json({ error: 'Forbidden' });
  const { name, company, website } = req.body;

  getDb()
    .prepare(
      `
    UPDATE publishers SET name = ?, company = ?, website = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `,
    )
    .run(
      name || req.publisher.name,
      company || req.publisher.company,
      website || req.publisher.website,
      req.params.id,
    );

  res.json({ success: true });
});

/** Set publisher's settlement wallet */
router.post(
  '/:id/wallet',
  authenticate,
  limitPerUser('payout-change', 10, 60 * 60_000),
  (req: AuthRequest, res) => {
    if (req.publisher?.id !== req.params.id) return res.status(403).json({ error: 'Forbidden' });
    const { address, chain, settlement_frequency, min_payout } = req.body;
    if (!address) return res.status(400).json({ error: 'Wallet address required' });

    const walletChain = chain || 'arc-testnet';
    const cleanAddress = String(address).trim();

    // Validate address format based on chain family.
    const isEvmChain =
      walletChain.startsWith('arc') ||
      walletChain === 'evm' ||
      walletChain.startsWith?.('eip155:') ||
      ['ethereum', 'base', 'arbitrum', 'optimism', 'avalanche', 'robinhood'].includes(walletChain);
    const isStellarChain = walletChain === 'stellar' || String(walletChain).startsWith('stellar:');
    const isSolanaChain = walletChain === 'solana' || String(walletChain).startsWith('solana:');

    if (isEvmChain) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(cleanAddress)) {
        return res.status(400).json({ error: 'Not a valid EVM address' });
      }
    } else if (isStellarChain) {
      if (!/^G[A-Z2-7]{55}$/.test(cleanAddress)) {
        return res.status(400).json({ error: 'Not a valid Stellar address (expected G...)' });
      }
    } else if (isSolanaChain) {
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(cleanAddress)) {
        return res.status(400).json({ error: 'Not a valid Solana address' });
      }
    } else if (!algosdk.isValidAddress(cleanAddress)) {
      return res.status(400).json({ error: 'Not a valid Algorand address' });
    }

    const db = getDb();
    const existing = db
      .prepare<unknown[], Wallet>('SELECT * FROM wallets WHERE publisher_id = ?')
      .get(req.params.id);

    // Changing where money goes is the highest-value action a publisher can take, so a
    // *change* must be confirmed by email. Setting it for the first time is not, because
    // there is no revenue to redirect yet.
    if (existing && existing.address !== cleanAddress) {
      const confirmation = String(req.body?.confirmationCode || '').trim();

      if (!confirmation) {
        const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
        db.prepare(
          `
        INSERT INTO auth_tokens (id, email, kind, token_hash, expires_at)
        VALUES (?, ?, 'PAYOUT_CHANGE', ?, ?)
      `,
        ).run(
          uuidv4(),
          req.publisher!.email,
          hashToken(`${req.params.id}:${cleanAddress}:${code}`),
          new Date(Date.now() + 15 * 60_000).toISOString(),
        );

        void sendEmail(payoutChangeEmail(req.publisher!.email, cleanAddress, code)).catch(error =>
          console.error('Payout confirmation email failed:', error?.message || error),
        );

        return res.status(202).json({
          confirmationRequired: true,
          message:
            'We emailed a confirmation code. Send it back as confirmationCode to apply the change.',
        });
      }

      const record = db
        .prepare<unknown[], AuthToken>(
          `
        SELECT * FROM auth_tokens
        WHERE email = ? AND kind = 'PAYOUT_CHANGE' AND consumed_at IS NULL
          AND expires_at > CURRENT_TIMESTAMP
        ORDER BY created_at DESC LIMIT 1
      `,
        )
        .get(req.publisher!.email);

      const expected = hashToken(`${req.params.id}:${cleanAddress}:${confirmation}`);
      if (!record || !safeEqual(record.token_hash, expected)) {
        return res
          .status(401)
          .json({ error: 'That confirmation code is incorrect or has expired' });
      }

      db.prepare('UPDATE auth_tokens SET consumed_at = CURRENT_TIMESTAMP WHERE id = ?').run(
        record.id,
      );
    }

    // Update in place rather than delete-and-reinsert: past settlements reference wallets(id),
    // so deleting the row trips a foreign key and locks the publisher out of ever changing
    // their payout address once they have any settlement history.
    if (existing) {
      db.prepare(
        `
      UPDATE wallets SET chain = ?, address = ?, settlement_frequency = ?, min_payout = ?
      WHERE id = ?
    `,
      ).run(
        chain || existing.chain,
        cleanAddress,
        settlement_frequency || existing.settlement_frequency,
        min_payout ?? existing.min_payout,
        existing.id,
      );
      return res.json({ id: existing.id, address: cleanAddress });
    }

    const id = uuidv4();
    db.prepare(
      `
    INSERT INTO wallets (id, publisher_id, chain, address, settlement_frequency, min_payout)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
    ).run(
      id,
      req.params.id,
      chain || 'arc-testnet',
      cleanAddress,
      settlement_frequency || 'weekly',
      min_payout ?? 10,
    );

    res.json({ id, address: cleanAddress });
  },
);

/** Get publisher's wallet */
router.get('/:id/wallet', authenticate, (req: AuthRequest, res) => {
  if (req.publisher?.id !== req.params.id) return res.status(403).json({ error: 'Forbidden' });
  const wallet = getDb().prepare('SELECT * FROM wallets WHERE publisher_id = ?').get(req.params.id);
  res.json(wallet || null);
});
