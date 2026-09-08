import { errorMessage } from '../services/errors';
import crypto from 'crypto';
import { Router, type Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { OAuth2Client } from 'google-auth-library';
import { getDb } from '../db/connection';
import { config } from '../config';
import { hashToken, safeEqual } from '../services/vault';
import { sendEmail, magicLinkEmail, otpEmail } from '../services/mailer';
import { upsertUser, normalizeEmail, isValidEmail } from '../services/users';
import {
  createSession,
  setSessionCookie,
  clearSessionCookie,
  revokeSession,
  publicUser,
  type User,
} from '../services/session';
import { SessionRequest, requireSession } from '../middleware/session';
import {
  getWalletByUserId,
  getBalances,
  withdrawUsdc,
  createCustodialWallet,
  createCustodialEvmWallet,
} from '../services/wallet';
import { getBalance as getCreditBalance } from '../services/credits';
import { provisionWallet, getOperationsAddress } from '../services/treasury';

export const router = Router();

// ---- Rate limiting -------------------------------------------------------
// Keeps a single address from being used to spam sign-in emails. In-memory is
// adequate for a single instance; move to a shared store when running several.
const attempts = new Map<string, number[]>();

const rateLimit = (key: string, max: number, windowMs: number): boolean => {
  const now = Date.now();
  const hits = (attempts.get(key) || []).filter(t => now - t < windowMs);
  if (hits.length >= max) {
    attempts.set(key, hits);
    return false;
  }
  hits.push(now);
  attempts.set(key, hits);
  return true;
};

setInterval(() => attempts.clear(), 60 * 60 * 1000).unref?.();

// ---- Single-use token helpers -------------------------------------------
const issueToken = (
  email: string,
  kind: 'MAGIC_LINK' | 'OTP',
  token: string,
  ttlMinutes: number,
) => {
  const db = getDb();
  // Only one live token per email and kind — requesting a new one invalidates the old.
  db.prepare(
    'UPDATE auth_tokens SET consumed_at = CURRENT_TIMESTAMP WHERE email = ? AND kind = ? AND consumed_at IS NULL',
  ).run(email, kind);

  db.prepare(
    `
    INSERT INTO auth_tokens (id, email, kind, token_hash, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `,
  ).run(
    uuidv4(),
    email,
    kind,
    hashToken(token),
    new Date(Date.now() + ttlMinutes * 60_000).toISOString(),
  );
};

interface StoredToken {
  id: string;
  email: string;
  token_hash: string;
  attempts: number;
}

const consumeToken = (email: string, kind: 'MAGIC_LINK' | 'OTP', token: string): boolean => {
  const db = getDb();
  const record = db
    .prepare(
      `
      SELECT * FROM auth_tokens
      WHERE email = ? AND kind = ? AND consumed_at IS NULL AND expires_at > CURRENT_TIMESTAMP
      ORDER BY created_at DESC LIMIT 1
    `,
    )
    .get(email, kind) as StoredToken | undefined;

  if (!record) return false;

  if (record.attempts >= config.OTP_MAX_ATTEMPTS) {
    db.prepare('UPDATE auth_tokens SET consumed_at = CURRENT_TIMESTAMP WHERE id = ?').run(
      record.id,
    );
    return false;
  }

  if (!safeEqual(record.token_hash, hashToken(token))) {
    db.prepare('UPDATE auth_tokens SET attempts = attempts + 1 WHERE id = ?').run(record.id);
    return false;
  }

  db.prepare('UPDATE auth_tokens SET consumed_at = CURRENT_TIMESTAMP WHERE id = ?').run(record.id);
  return true;
};

const startSession = (req: SessionRequest, res: Response, user: User) => {
  const token = createSession(user.id, req.header('user-agent'));
  setSessionCookie(res, token);
  return token;
};

/**
 * Headless clients — a CLI, a script, CI — cannot use an httpOnly cookie, so they ask for
 * the raw token and send it back as `Authorization: Bearer …`.
 *
 * This is opt-in via `mode: "token"` and never the default: returning the token in the body
 * to a browser would hand it to any XSS, undoing the reason the cookie is httpOnly.
 */
const wantsRawToken = (req: SessionRequest): boolean =>
  req.body?.mode === 'token' || req.header('x-client-type') === 'cli';

const sessionResponse = (req: SessionRequest, token: string, user: User, isNew: boolean) => ({
  user: publicUser(user),
  isNew,
  ...(wantsRawToken(req)
    ? {
        token,
        expiresAt: new Date(Date.now() + config.SESSION_TTL_DAYS * 86_400_000).toISOString(),
        tokenUsage: 'Send as: Authorization: Bearer <token>',
      }
    : {}),
});

// ---- Magic link ----------------------------------------------------------

router.post('/magic-link', async (req, res) => {
  const email = normalizeEmail(String(req.body?.email || ''));
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'A valid email address is required' });
  }
  if (!rateLimit(`magic:${email}`, 5, 15 * 60_000)) {
    return res
      .status(429)
      .json({ error: 'Too many sign-in requests. Try again in a few minutes.' });
  }

  const token = crypto.randomBytes(32).toString('base64url');
  issueToken(email, 'MAGIC_LINK', token, config.MAGIC_LINK_TTL_MINUTES);

  const link = `${config.GATEWAY_BASE_URL}/api/auth/magic-link/callback?token=${token}&email=${encodeURIComponent(email)}`;

  try {
    const result = await sendEmail(magicLinkEmail(email, link));
    // Never reveal whether the address is registered.
    res.json({
      sent: true,
      channel: result.channel,
      expiresInMinutes: config.MAGIC_LINK_TTL_MINUTES,
      // Local convenience when no mail provider is wired up. Handing the link back over the
      // API is an account-takeover primitive, so it is barred outright in production even
      // if RESEND_API_KEY is missing there.
      devLink: !config.IS_PRODUCTION && result.channel === 'console' ? link : undefined,
    });
  } catch (error) {
    console.error('Magic link delivery failed:', errorMessage(error));
    res.status(502).json({ error: 'Could not send the sign-in email. Try again shortly.' });
  }
});

router.get('/magic-link/callback', (req: SessionRequest, res) => {
  const token = String(req.query.token || '');
  const email = normalizeEmail(String(req.query.email || ''));

  if (!token || !isValidEmail(email) || !consumeToken(email, 'MAGIC_LINK', token)) {
    return res.redirect(`${config.APP_BASE_URL}/?auth_error=invalid_or_expired_link`);
  }

  const { user } = upsertUser(email, { provider: 'magic_link' });
  startSession(req, res, user);
  res.redirect(`${config.APP_BASE_URL}/?signed_in=1`);
});

// ---- One-time passcode ---------------------------------------------------

router.post('/otp', async (req, res) => {
  const email = normalizeEmail(String(req.body?.email || ''));
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'A valid email address is required' });
  }
  if (!rateLimit(`otp:${email}`, 5, 15 * 60_000)) {
    return res.status(429).json({ error: 'Too many codes requested. Try again in a few minutes.' });
  }

  // crypto.randomInt avoids the modulo bias of Math.random-based codes.
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  issueToken(email, 'OTP', code, config.OTP_TTL_MINUTES);

  try {
    const result = await sendEmail(otpEmail(email, code));
    res.json({
      sent: true,
      channel: result.channel,
      expiresInMinutes: config.OTP_TTL_MINUTES,
      // See the magic-link note above: dev-only, never in production.
      devCode: !config.IS_PRODUCTION && result.channel === 'console' ? code : undefined,
    });
  } catch (error) {
    console.error('OTP delivery failed:', errorMessage(error));
    res.status(502).json({ error: 'Could not send the verification code. Try again shortly.' });
  }
});

router.post('/otp/verify', (req: SessionRequest, res) => {
  const email = normalizeEmail(String(req.body?.email || ''));
  const code = String(req.body?.code || '').trim();

  if (!isValidEmail(email) || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: 'Email and a 6-digit code are required' });
  }
  if (!rateLimit(`otpverify:${email}`, 10, 15 * 60_000)) {
    return res.status(429).json({ error: 'Too many attempts. Request a new code.' });
  }
  if (!consumeToken(email, 'OTP', code)) {
    return res.status(401).json({ error: 'That code is incorrect or has expired' });
  }

  const { user, isNew } = upsertUser(email, { provider: 'otp' });
  const token = startSession(req, res, user);
  res.json(sessionResponse(req, token, user, isNew));
});

// ---- Google ---------------------------------------------------------------

let googleClient: OAuth2Client | null = null;

router.post('/google', async (req: SessionRequest, res) => {
  const credential = String(req.body?.credential || '');
  if (!credential) return res.status(400).json({ error: 'A Google credential is required' });
  if (!config.GOOGLE_CLIENT_ID) {
    return res.status(503).json({ error: 'Google sign-in is not configured on this server' });
  }

  try {
    if (!googleClient) googleClient = new OAuth2Client(config.GOOGLE_CLIENT_ID);

    // Verifies signature, issuer, audience and expiry against Google's public keys.
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: config.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();

    if (!payload?.email) return res.status(401).json({ error: 'Google account has no email' });
    if (!payload.email_verified) {
      return res.status(401).json({ error: 'Google account email is not verified' });
    }

    const { user, isNew } = upsertUser(payload.email, {
      provider: 'google',
      name: payload.name,
      avatarUrl: payload.picture,
    });
    const token = startSession(req, res, user);
    res.json(sessionResponse(req, token, user, isNew));
  } catch (error) {
    console.error('Google sign-in failed:', errorMessage(error));
    res.status(401).json({ error: 'Invalid Google credential' });
  }
});

// ---- Session ---------------------------------------------------------------

router.get('/me', async (req: SessionRequest, res) => {
  if (!req.user) return res.json({ user: null });

  const wallet =
    getWalletByUserId(req.user.id, 'arc-testnet') ||
    createCustodialWallet(req.user.id, 'arc-testnet');
  const evmWallet = wallet;
  let balances = null;

  if (wallet) {
    try {
      balances = await getBalances(wallet.address);
    } catch (error) {
      console.error('Balance lookup failed:', errorMessage(error));
    }
  }

  const db = getDb();
  interface PublisherSummary {
    id: string;
    name: string;
    company: string | null;
    website: string | null;
    status: string;
  }
  let publisher: PublisherSummary | null = null;
  if (req.user.id) {
    let p = db
      .prepare(
        `
        SELECT p.id, p.name, p.company, p.website, p.status FROM publishers p
        JOIN users u ON u.publisher_id = p.id
        WHERE u.id = ?
      `,
      )
      .get(req.user.id) as PublisherSummary | undefined;

    if (!p && req.user.email) {
      p = db
        .prepare(
          'SELECT id, name, company, website, status FROM publishers WHERE LOWER(email) = LOWER(?)',
        )
        .get(req.user.email) as PublisherSummary | undefined;
      if (p) {
        db.prepare('UPDATE users SET publisher_id = ? WHERE id = ?').run(p.id, req.user.id);
      }
    }
    publisher = p || null;
  }

  res.json({
    user: publicUser(req.user),
    publisher,
    // Spendable credit — what the UI shows everywhere.
    credits: getCreditBalance(req.user.id),
    // The address is safe to show; the key never leaves the server.
    wallet: wallet
      ? {
          address: wallet.address,
          optedIn: true,
          explorerUrl: `${config.ARC_EXPLORER_URL}/address/${wallet.address}`,
        }
      : null,
    evmWallet: evmWallet
      ? {
          address: evmWallet.address,
          optedIn: true,
          explorerUrl: `${config.ARC_EXPLORER_URL}/address/${evmWallet.address}`,
        }
      : null,
    balances,
  });
});

router.post('/logout', (req: SessionRequest, res) => {
  if (req.sessionToken) revokeSession(req.sessionToken);
  clearSessionCookie(res);
  res.json({ success: true });
});

/**
 * Get or create an EVM custodial wallet for the authenticated user.
 */
router.post('/wallet/evm', requireSession, (req: SessionRequest, res) => {
  const evmWallet =
    getWalletByUserId(req.user!.id, 'evm') || createCustodialEvmWallet(req.user!.id);
  res.json({
    address: evmWallet.address,
    chain: 'evm',
    explorerUrl: `https://sepolia.basescan.org/address/${evmWallet.address}`,
  });
});

/**
 * Activate a wallet so it can receive USDC: the treasury funds the ALGO minimum balance
 * and the wallet opts into the asset.
 *
 * Deliberately user-triggered rather than automatic at sign-up — activation costs the
 * treasury ALGO, so mass registration must not be able to spend it. The cost is recovered
 * by the withdrawal fee, or in full when the user closes the wallet out.
 */
router.post(
  ['/wallet/activate', '/wallet/provision'],
  requireSession,
  async (req: SessionRequest, res) => {
    const wallet =
      getWalletByUserId(req.user!.id, 'arc-testnet') ||
      createCustodialWallet(req.user!.id, 'arc-testnet');
    const result = await provisionWallet(wallet);
    res.status(result.status === 'READY' ? 200 : 503).json(result);
  },
);

/** Send USDC out of the custodial wallet to any address the user controls. */
router.post('/wallet/withdraw', requireSession, async (req: SessionRequest, res) => {
  const destination = String(req.body?.address || '').trim();
  const requested = req.body?.amount === undefined ? null : Number(req.body.amount);

  if (requested !== null && (!Number.isFinite(requested) || requested <= 0)) {
    return res.status(400).json({ error: 'Amount must be a positive number' });
  }

  const wallet = getWalletByUserId(req.user!.id, 'arc-testnet') || getWalletByUserId(req.user!.id);
  if (!wallet) return res.status(409).json({ error: 'No wallet to withdraw from' });

  let balances;
  try {
    balances = await getBalances(wallet.address);
  } catch (error) {
    return res
      .status(502)
      .json({ error: 'Could not read the wallet balance', details: errorMessage(error) });
  }

  // Omitting the amount means "everything", which closes the wallet and returns the
  // activation ALGO to the treasury — so no fee is charged in that case. It also works on
  // an empty wallet, which is how an abandoned activation gives its ALGO back.
  const closeOut = requested === null || requested >= balances.usdc;

  if (balances.usdc <= 0 && !closeOut) {
    return res.status(400).json({ error: 'Nothing to withdraw' });
  }
  if (balances.usdc <= 0 && !balances.optedIn) {
    return res.status(400).json({ error: 'Wallet is not active — nothing to close' });
  }
  const fee = closeOut ? 0 : config.WITHDRAWAL_FEE_USDC;
  const gross = closeOut ? balances.usdc : requested!;

  if (gross + fee > balances.usdc) {
    return res.status(400).json({
      error: 'Amount plus the withdrawal fee exceeds the balance',
      balance: balances.usdc,
      fee,
    });
  }
  // The minimum guards partial withdrawals from costing more than they move. A close-out
  // is exempt: it must always be possible to empty and shut a wallet.
  if (!closeOut && gross < config.MIN_WITHDRAWAL_USDC) {
    return res.status(400).json({
      error: `Minimum withdrawal is ${config.MIN_WITHDRAWAL_USDC} USDC`,
    });
  }

  try {
    const result = await withdrawUsdc(wallet, destination, gross, {
      closeOut,
      feeUsdc: fee,
      treasuryAddress: getOperationsAddress(),
    });
    res.json({
      ...result,
      destination,
      explorerUrls: result.txIds.map(id => `${config.EXPLORER_BASE_URL}/tx/${id}`),
    });
  } catch (error) {
    console.error('Withdrawal failed:', errorMessage(error));
    res.status(502).json({ error: errorMessage(error, 'Withdrawal failed') });
  }
});
