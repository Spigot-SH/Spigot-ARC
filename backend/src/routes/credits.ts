import { errorMessage } from '../services/errors';
import crypto from 'crypto';
import { Router } from 'express';
import { config } from '../config';
import { SessionRequest, requireSession } from '../middleware/session';
import { limitPerUser, limitPerIp } from '../services/rateLimit';
import { getDb } from '../db/connection';
import {
  TIERS,
  resolveTier,
  getBalance,
  getHistory,
  credit,
  DuplicateCredit,
} from '../services/credits';
import {
  getCustodyAddress,
  provisionWallet,
  provisionStellarWallet,
  sendArcUsdc,
  sendEvmUsdc,
  sendSolanaUsdc,
  sendUsdc,
} from '../services/treasury';
import {
  getFeePayer,
  verifyPayment,
  settlePayment,
  PaymentRequirements,
} from '../services/facilitator';
import { toAtomicUnits, decodePaymentPayload, encodeHeader } from '../services/x402';
import {
  getBalances,
  getWalletByUserId,
  createCustodialWallet,
  createCustodialEvmWallet,
  createCustodialSolanaWallet,
  createCustodialStellarWallet,
  getAllChainBalances,
} from '../services/wallet';
import {
  getChainByNetwork,
  isEvmNetwork,
  isArcNetwork,
  isSolanaNetwork,
  isStellarNetwork,
  getExplorerTxUrl,
  getEnabledChains,
  getExplorerAddressUrl,
} from '../services/chains';

export const router = Router();

/** Available top-up amounts, the user's balance, and their dedicated email-mapped wallets. */
router.get('/', requireSession, async (req: SessionRequest, res) => {
  const wallet =
    getWalletByUserId(req.user!.id, 'arc-testnet') ||
    createCustodialWallet(req.user!.id, 'arc-testnet');
  const evmWallet = wallet;
  const solanaWallet =
    getWalletByUserId(req.user!.id, 'solana') || createCustodialSolanaWallet(req.user!.id);
  const stellarWallet =
    getWalletByUserId(req.user!.id, 'stellar') || createCustodialStellarWallet(req.user!.id);

  // Auto-provision custodial wallets in background if not yet active on-chain
  provisionWallet(wallet).catch(() => null);
  provisionStellarWallet(stellarWallet).catch(() => null);

  const chainBalances = await getAllChainBalances(req.user!.id);
  res.json({
    balance: getBalance(req.user!.id),
    currency: 'USDC',
    walletAddress: wallet.address,
    evmWalletAddress: evmWallet.address,
    solanaWalletAddress: solanaWallet.address,
    stellarWalletAddress: stellarWallet.address,
    // Built server-side so the explorer follows ALGORAND_NETWORK_PROFILE. The frontend used
    // to hardcode Sepolia and Pera testnet links, which silently stayed on testnet after a
    // mainnet switch.
    explorerUrls: {
      arc: `${config.ARC_EXPLORER_URL}/address/${wallet.address}`,
      evm: `${config.ARC_EXPLORER_URL}/address/${evmWallet.address}`,
      solana: getExplorerAddressUrl('solana', solanaWallet.address),
      stellar: getExplorerAddressUrl('stellar', stellarWallet.address),
    },
    chainBalances,
    tiers: TIERS,
    custom: { min: config.MIN_RECHARGE_USDC, max: config.MAX_RECHARGE_USDC },
    history: getHistory(req.user!.id, 25),
  });
});

/**
 * Payment requirements for a top-up.
 *
 * Supports both Algorand and EVM chains. The user pays into their own email-mapped custodial wallet.
 */
router.post(
  '/recharge/quote',
  requireSession,
  limitPerUser('recharge-quote', 30, 60_000),
  async (req: SessionRequest, res) => {
    const tier = resolveTier(req.body?.tierId, req.body?.amount);
    if (!tier) {
      return res.status(400).json({
        error: `Choose a tier, or a custom amount between ${config.MIN_RECHARGE_USDC} and ${config.MAX_RECHARGE_USDC} USDC`,
      });
    }

    const chainParam = req.body?.chain;
    const chainInfo = chainParam
      ? getChainByNetwork(chainParam) ||
        getEnabledChains().find(c => c.name === String(chainParam).toLowerCase())
      : undefined;

    try {
      if (chainInfo && chainInfo.family === 'evm') {
        const evmWallet =
          getWalletByUserId(req.user!.id, 'evm') || createCustodialEvmWallet(req.user!.id);
        const requirements: PaymentRequirements = {
          scheme: 'exact',
          network: chainInfo.caip2,
          asset: chainInfo.usdcAddress,
          amount: toAtomicUnits(tier.amountUsdc),
          payTo: evmWallet.address,
          maxTimeoutSeconds: config.PAYMENT_TIMEOUT_SECONDS,
          extra: {
            decimals: chainInfo.usdcDecimals,
            name: chainInfo.tokenName || 'USDC',
            version: chainInfo.tokenVersion || '2',
          },
        };

        return res.json({
          tier,
          requirements,
          challenge: encodeHeader({
            x402Version: 2,
            error: 'Payment required',
            resource: {
              url: `${config.GATEWAY_BASE_URL}/api/credits/recharge`,
              description: `Account top-up ${tier.label}`,
              mimeType: 'application/json',
            },
            accepts: [requirements],
          }),
        });
      }

      if (chainInfo && chainInfo.family === 'solana') {
        const solanaWallet =
          getWalletByUserId(req.user!.id, 'solana') || createCustodialSolanaWallet(req.user!.id);
        const requirements: PaymentRequirements = {
          scheme: 'exact',
          network: chainInfo.caip2,
          asset: chainInfo.usdcAddress,
          amount: toAtomicUnits(tier.amountUsdc),
          payTo: solanaWallet.address,
          maxTimeoutSeconds: config.PAYMENT_TIMEOUT_SECONDS,
          extra: {
            decimals: chainInfo.usdcDecimals,
            name: chainInfo.tokenName || 'USDC',
          },
        };

        return res.json({
          tier,
          requirements,
          challenge: encodeHeader({
            x402Version: 2,
            error: 'Payment required',
            resource: {
              url: `${config.GATEWAY_BASE_URL}/api/credits/recharge`,
              description: `Account top-up ${tier.label}`,
              mimeType: 'application/json',
            },
            accepts: [requirements],
          }),
        });
      }

      if (chainInfo && chainInfo.family === 'stellar') {
        const stellarWallet =
          getWalletByUserId(req.user!.id, 'stellar') || createCustodialStellarWallet(req.user!.id);
        await provisionStellarWallet(stellarWallet).catch(() => null);
        const requirements: PaymentRequirements = {
          scheme: 'exact',
          network: chainInfo.caip2,
          asset: chainInfo.usdcAddress,
          amount: Math.round(tier.amountUsdc * 10 ** chainInfo.usdcDecimals).toString(),
          payTo: stellarWallet.address,
          maxTimeoutSeconds: config.PAYMENT_TIMEOUT_SECONDS,
          extra: {
            decimals: chainInfo.usdcDecimals,
            name: chainInfo.tokenName || 'USDC',
            areFeesSponsored: true,
          },
        };

        return res.json({
          tier,
          requirements,
          challenge: encodeHeader({
            x402Version: 2,
            error: 'Payment required',
            resource: {
              url: `${config.GATEWAY_BASE_URL}/api/credits/recharge`,
              description: `Account top-up ${tier.label}`,
              mimeType: 'application/json',
            },
            accepts: [requirements],
          }),
        });
      }

      if (chainInfo && chainInfo.family === 'algorand') {
        const feePayer = await getFeePayer().catch(() => undefined);
        const userWallet =
          getWalletByUserId(req.user!.id, 'algorand') ||
          createCustodialWallet(req.user!.id, 'algorand');
        await provisionWallet(userWallet).catch(error => {
          console.warn('Wallet auto-provisioning warning:', errorMessage(error));
        });

        const requirements: PaymentRequirements = {
          scheme: 'exact',
          network: config.ALGORAND_NETWORK,
          asset: config.USDC_ASA_ID.toString(),
          amount: toAtomicUnits(tier.amountUsdc),
          payTo: userWallet.address,
          maxTimeoutSeconds: config.PAYMENT_TIMEOUT_SECONDS,
          extra: { decimals: config.USDC_DECIMALS, ...(feePayer ? { feePayer } : {}) },
        };

        return res.json({
          tier,
          requirements,
          challenge: encodeHeader({
            x402Version: 2,
            error: 'Payment required',
            resource: {
              url: `${config.GATEWAY_BASE_URL}/api/credits/recharge`,
              description: `Account top-up ${tier.label}`,
              mimeType: 'application/json',
            },
            accepts: [requirements],
          }),
        });
      }

      // Arc Testnet quote (default)
      const arcWallet =
        getWalletByUserId(req.user!.id, 'arc-testnet') ||
        getWalletByUserId(req.user!.id, 'evm') ||
        createCustodialEvmWallet(req.user!.id);
      await provisionWallet(arcWallet).catch(error => {
        console.warn('Wallet auto-provisioning warning:', errorMessage(error));
      });

      const requirements: PaymentRequirements = {
        scheme: 'exact',
        network: config.ARC_NETWORK,
        asset: config.ARC_USDC_ADDRESS,
        amount: toAtomicUnits(tier.amountUsdc),
        payTo: arcWallet.address,
        maxTimeoutSeconds: config.PAYMENT_TIMEOUT_SECONDS,
        extra: {
          decimals: 6,
          name: 'USDC',
          version: '2',
        },
      };

      res.json({
        tier,
        requirements,
        challenge: encodeHeader({
          x402Version: 2,
          error: 'Payment required',
          resource: {
            url: `${config.GATEWAY_BASE_URL}/api/credits/recharge`,
            description: `Account top-up ${tier.label}`,
            mimeType: 'application/json',
          },
          accepts: [requirements],
        }),
      });
    } catch (error) {
      console.error('Could not build a recharge quote:', errorMessage(error));
      res
        .status(503)
        .json({ error: 'Payment facilitator unavailable', details: errorMessage(error) });
    }
  },
);

/**
 * Confirm a top-up: verify and settle the signed payment, then credit the full tier.
 */
router.post(
  '/recharge',
  requireSession,
  limitPerUser('recharge', 20, 60_000),
  async (req: SessionRequest, res) => {
    const tier = resolveTier(req.body?.tierId, req.body?.amount);
    if (!tier) return res.status(400).json({ error: 'Unknown tier or invalid amount' });

    const header = String(req.body?.paymentSignature || req.header('payment-signature') || '');
    if (!header) return res.status(400).json({ error: 'A signed payment is required' });

    const payload = decodePaymentPayload(header);
    if (!payload) return res.status(400).json({ error: 'Malformed payment payload' });

    const isEvm = isEvmNetwork(payload.network);
    const isSolana = isSolanaNetwork(payload.network);
    const isStellar = isStellarNetwork(payload.network);
    let requirements: PaymentRequirements;

    // Rebuild the requirements server-side. Trusting a client-supplied copy would let a
    // caller claim a $50 tier while having signed a $1 payment.
    if (isStellar) {
      const chainInfo = getChainByNetwork(payload.network);
      if (!chainInfo) {
        return res.status(400).json({ error: 'Unsupported Stellar network' });
      }
      const stellarWallet =
        getWalletByUserId(req.user!.id, 'stellar') || createCustodialStellarWallet(req.user!.id);
      requirements = {
        scheme: 'exact',
        network: chainInfo.caip2,
        asset: chainInfo.usdcAddress,
        amount: Math.round(tier.amountUsdc * 10 ** chainInfo.usdcDecimals).toString(),
        payTo: stellarWallet.address,
        maxTimeoutSeconds: config.PAYMENT_TIMEOUT_SECONDS,
        extra: {
          decimals: chainInfo.usdcDecimals,
          name: chainInfo.tokenName || 'USDC',
          areFeesSponsored: true,
        },
      };
    } else if (isSolana) {
      const chainInfo = getChainByNetwork(payload.network);
      if (!chainInfo) {
        return res.status(400).json({ error: 'Unsupported Solana network' });
      }
      const solanaWallet =
        getWalletByUserId(req.user!.id, 'solana') || createCustodialSolanaWallet(req.user!.id);
      requirements = {
        scheme: 'exact',
        network: chainInfo.caip2,
        asset: chainInfo.usdcAddress,
        amount: toAtomicUnits(tier.amountUsdc),
        payTo: solanaWallet.address,
        maxTimeoutSeconds: config.PAYMENT_TIMEOUT_SECONDS,
        extra: {
          decimals: chainInfo.usdcDecimals,
          name: chainInfo.tokenName || 'USDC',
        },
      };
    } else if (isEvm) {
      const chainInfo = getChainByNetwork(payload.network);
      if (!chainInfo) {
        return res.status(400).json({ error: 'Unsupported EVM network' });
      }
      const evmWallet =
        getWalletByUserId(req.user!.id, 'arc-testnet') ||
        getWalletByUserId(req.user!.id, 'evm') ||
        createCustodialEvmWallet(req.user!.id);
      requirements = {
        scheme: 'exact',
        network: chainInfo.caip2,
        asset: chainInfo.usdcAddress,
        amount: toAtomicUnits(tier.amountUsdc),
        payTo: evmWallet.address,
        maxTimeoutSeconds: config.PAYMENT_TIMEOUT_SECONDS,
        extra: {
          decimals: chainInfo.usdcDecimals,
          name: chainInfo.tokenName || 'USDC',
          version: chainInfo.tokenVersion || '2',
        },
      };
    } else {
      if (payload.network !== config.ALGORAND_NETWORK) {
        return res.status(400).json({ error: 'Payment is for the wrong network' });
      }

      let feePayer: string | undefined;
      try {
        feePayer = await getFeePayer();
      } catch (error) {
        return res
          .status(503)
          .json({ error: 'Payment facilitator unavailable', details: errorMessage(error) });
      }

      const userWallet =
        getWalletByUserId(req.user!.id, 'algorand') ||
        createCustodialWallet(req.user!.id, 'algorand');
      await provisionWallet(userWallet).catch(() => null);

      requirements = {
        scheme: 'exact',
        network: config.ALGORAND_NETWORK,
        asset: config.USDC_ASA_ID.toString(),
        amount: toAtomicUnits(tier.amountUsdc),
        payTo: userWallet.address,
        maxTimeoutSeconds: config.PAYMENT_TIMEOUT_SECONDS,
        extra: { decimals: config.USDC_DECIMALS, ...(feePayer ? { feePayer } : {}) },
      };
    }

    try {
      const verification = await verifyPayment(payload, requirements);
      if (!verification.isValid) {
        return res.status(402).json({
          error: 'Payment verification failed',
          reason: verification.invalidReason || 'Unknown reason',
        });
      }

      const settlement = await settlePayment(payload, requirements);
      if (!settlement.success || !settlement.transaction) {
        return res.status(402).json({
          error: 'Payment settlement failed',
          reason: settlement.errorReason || 'Unknown reason',
        });
      }

      // The chain transaction id is the idempotency key: replaying it cannot credit twice.
      const entry = credit({
        userId: req.user!.id,
        amount: tier.amountUsdc,
        source: 'crypto',
        reference: `${payload.network}:${settlement.transaction}`,
        description: `Top-up ${tier.label}`,
        metadata: { tierId: tier.id, txId: settlement.transaction, network: payload.network },
      });

      res.json({
        credited: tier.amountUsdc,
        balance: entry.balance_after,
        txId: settlement.transaction,
        explorerUrl: getExplorerTxUrl(payload.network, settlement.transaction),
      });
    } catch (error) {
      if (error instanceof DuplicateCredit) {
        return res.status(409).json({ error: 'This payment has already been credited' });
      }
      console.error('Recharge failed:', errorMessage(error));
      res.status(502).json({ error: 'Recharge failed', details: errorMessage(error) });
    }
  },
);

/**
 * Instant testnet top-up funded from platform treasury for authenticated users.
 * Automatically provisions on-chain testnet USDC and updates the user's credit balance.
 */
router.post(
  '/treasury-topup',
  requireSession,
  limitPerUser('treasury-topup', 10, 60_000),
  async (req: SessionRequest, res) => {
    const tier = resolveTier(req.body?.tierId, req.body?.amount);
    if (!tier) return res.status(400).json({ error: 'Unknown tier or invalid amount' });

    const chain = (req.body?.chain as string) || 'arc-testnet';
    const amountUsdc = tier.amountUsdc;

    try {
      let txId: string;
      let explorerUrl: string;

      if (chain === 'arc' || chain === 'arc-testnet' || isArcNetwork(chain)) {
        const arcWallet =
          getWalletByUserId(req.user!.id, 'arc-testnet') ||
          getWalletByUserId(req.user!.id, 'evm') ||
          createCustodialEvmWallet(req.user!.id);
        const hash = await sendArcUsdc(arcWallet.address, amountUsdc, 'operations');
        txId = hash || `0x${crypto.randomBytes(32).toString('hex')}`;
        explorerUrl = getExplorerTxUrl(config.ARC_NETWORK, txId);
      } else if (chain === 'algorand') {
        const userWallet =
          getWalletByUserId(req.user!.id, 'algorand') ||
          createCustodialWallet(req.user!.id, 'algorand');
        await provisionWallet(userWallet);
        txId = await sendUsdc(userWallet.address, amountUsdc, 'operations');
        explorerUrl = getExplorerTxUrl(config.ALGORAND_NETWORK, txId);
      } else if (chain === 'solana') {
        const solanaWallet =
          getWalletByUserId(req.user!.id, 'solana') || createCustodialSolanaWallet(req.user!.id);
        const hash = await sendSolanaUsdc(solanaWallet.address, amountUsdc);
        txId = hash || `solana_${Date.now().toString(16)}`;
        explorerUrl = getExplorerTxUrl('solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', txId);
      } else {
        const chainInfo =
          getChainByNetwork(chain) ||
          getEnabledChains().find(c => c.name === chain.toLowerCase()) ||
          getChainByNetwork('eip155:11155111');
        const evmWallet =
          getWalletByUserId(req.user!.id, 'arc-testnet') ||
          getWalletByUserId(req.user!.id, 'evm') ||
          createCustodialEvmWallet(req.user!.id);
        const hash = await sendEvmUsdc(
          evmWallet.address,
          amountUsdc,
          chainInfo?.name || 'ethereum',
        );
        txId = hash || `0x${Date.now().toString(16)}`;
        explorerUrl = getExplorerTxUrl(chainInfo?.caip2 || 'eip155:11155111', txId);
      }

      const entry = credit({
        userId: req.user!.id,
        amount: amountUsdc,
        source: 'crypto',
        reference: `${chain}:${txId}`,
        description: `Treasury top-up ${tier.label}`,
        metadata: { tierId: tier.id, txId, chain },
      });

      res.json({
        credited: amountUsdc,
        balance: entry.balance_after,
        txId,
        explorerUrl,
      });
    } catch (error) {
      console.error('Treasury top-up failed:', errorMessage(error));
      res.status(502).json({ error: 'Treasury top-up failed', details: errorMessage(error) });
    }
  },
);

/**
 * Fiat onramp callback. Not wired to a provider yet — the shape and safety properties are
 * in place so a provider can be dropped in without redesigning crediting.
 *
 * Requires an HMAC signature over the raw body and treats the provider's payment id as the
 * idempotency key, because onramps retry deliveries.
 */
router.post('/onramp/webhook', limitPerIp('onramp', 60, 60_000), (req, res) => {
  if (!config.ONRAMP_WEBHOOK_SECRET) {
    return res.status(503).json({ error: 'Fiat onramp is not configured' });
  }

  const signature = String(req.header('x-onramp-signature') || '');
  const expected = crypto
    .createHmac('sha256', config.ONRAMP_WEBHOOK_SECRET)
    .update(JSON.stringify(req.body || {}))
    .digest('hex');

  const provided = Buffer.from(signature);
  const computed = Buffer.from(expected);
  if (provided.length !== computed.length || !crypto.timingSafeEqual(provided, computed)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const { userId, email, amount, paymentId, status } = req.body || {};
  if (status && status !== 'completed') {
    return res.json({ ignored: true, reason: `status is ${status}` });
  }
  if (!paymentId) return res.status(400).json({ error: 'paymentId is required' });

  const amountUsdc = Number(amount);
  if (!Number.isFinite(amountUsdc) || amountUsdc <= 0) {
    return res.status(400).json({ error: 'A positive amount is required' });
  }

  // Bound the webhook the same way the user-facing recharge path is bounded by resolveTier.
  // A valid signature is not a reason to mint unlimited credit: if the onramp is compromised,
  // or simply sends a malformed payload, the blast radius should be one MAX_RECHARGE_USDC —
  // not the entire custody float, which is other users' money.
  if (amountUsdc > config.MAX_RECHARGE_USDC) {
    console.warn(
      `Onramp webhook rejected: ${amountUsdc} USDC exceeds MAX_RECHARGE_USDC ` +
        `(${config.MAX_RECHARGE_USDC}) for payment ${paymentId}`,
    );
    return res.status(400).json({
      error: `Amount exceeds the maximum of ${config.MAX_RECHARGE_USDC} USDC`,
    });
  }

  const db = getDb();
  const user = userId
    ? (db.prepare('SELECT id FROM users WHERE id = ?').get(userId) as { id: string } | undefined)
    : (db.prepare('SELECT id FROM users WHERE email = ?').get(String(email || '').toLowerCase()) as
        { id: string } | undefined);

  if (!user) return res.status(404).json({ error: 'Unknown user' });

  try {
    const entry = credit({
      userId: user.id,
      amount: amountUsdc,
      source: 'fiat',
      reference: `onramp:${paymentId}`,
      description: `Fiat top-up ${amountUsdc} USDC`,
      metadata: { paymentId },
    });
    res.json({ credited: amountUsdc, balance: entry.balance_after });
  } catch (error) {
    if (error instanceof DuplicateCredit) {
      // Onramps retry; acknowledging keeps them from redelivering forever.
      return res.json({ credited: 0, duplicate: true });
    }
    console.error('Onramp crediting failed:', errorMessage(error));
    res.status(500).json({ error: 'Could not apply the credit' });
  }
});

// ---- Razorpay Standard Checkout ------------------------------------------
//
// Two calls. `create-order` opens an order with Razorpay and hands the client the id and
// key to launch the hosted checkout. `verify-payment` takes the handshake back, proves it
// with the HMAC, and credits the account.
//
// The amount is never taken from the client on the way back in. The order is re-read from
// Razorpay and the USDC figure is recovered from the notes we wrote when we created it, so
// a caller cannot pay ₹100 and claim $1000.

interface RazorpayOrder {
  id?: string;
  amount?: number;
  currency?: string;
  status?: string;
  notes?: { userId?: string; amountUsdc?: string | number };
  error?: { description?: string };
}

const razorpayAuthHeader = () =>
  `Basic ${Buffer.from(`${config.RAZORPAY_KEY_ID}:${config.RAZORPAY_KEY_SECRET}`).toString('base64')}`;

const razorpayConfigured = () => Boolean(config.RAZORPAY_KEY_ID && config.RAZORPAY_KEY_SECRET);

router.post(
  '/razorpay/create-order',
  requireSession,
  limitPerUser('razorpay-order', 20, 60_000),
  async (req: SessionRequest, res) => {
    if (!razorpayConfigured()) {
      return res.status(503).json({ error: 'Razorpay is not configured' });
    }

    // Same bounds as the crypto path: the fiat rail must not be a way around the cap.
    const amountUsdc = Number(req.body?.amount);
    if (
      !Number.isFinite(amountUsdc) ||
      amountUsdc < config.MIN_RECHARGE_USDC ||
      amountUsdc > config.MAX_RECHARGE_USDC
    ) {
      return res.status(400).json({
        error: `Choose an amount between ${config.MIN_RECHARGE_USDC} and ${config.MAX_RECHARGE_USDC} USDC`,
      });
    }

    const amountPaise = Math.round(amountUsdc * config.USD_TO_INR_RATE * 100);
    if (amountPaise < 100) {
      return res.status(400).json({ error: 'Minimum order amount is 100 paise' });
    }

    try {
      const rzpRes = await fetch('https://api.razorpay.com/v1/orders', {
        method: 'POST',
        headers: {
          Authorization: razorpayAuthHeader(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          amount: amountPaise,
          currency: 'INR',
          receipt: `rcpt_${crypto.randomUUID()}`,
          // Read back at verification time. This is the only trusted record of who the
          // order belongs to and how much USDC it buys.
          notes: { userId: req.user!.id, amountUsdc: String(amountUsdc) },
        }),
      });

      const order = (await rzpRes.json()) as RazorpayOrder;

      if (!rzpRes.ok || order?.error || !order.id) {
        console.error('Razorpay order creation failed:', rzpRes.status, order?.error);
        return res.status(502).json({ error: 'Razorpay order creation failed' });
      }

      return res.json({
        orderId: order.id,
        amountPaise: order.amount,
        currency: order.currency || 'INR',
        keyId: config.RAZORPAY_KEY_ID,
        amountUsdc,
      });
    } catch (error) {
      console.error('Razorpay order creation exception:', errorMessage(error));
      return res.status(502).json({ error: 'Could not reach Razorpay' });
    }
  },
);

router.post(
  '/razorpay/verify-payment',
  requireSession,
  limitPerUser('razorpay-verify', 20, 60_000),
  async (req: SessionRequest, res) => {
    if (!razorpayConfigured()) {
      return res.status(503).json({ error: 'Razorpay is not configured' });
    }

    const body = req.body || {};
    const orderId = String(body.razorpayOrderId || body.razorpay_order_id || '').trim();
    const paymentId = String(body.razorpayPaymentId || body.razorpay_payment_id || '').trim();
    const signature = String(body.razorpaySignature || body.razorpay_signature || '').trim();

    // All three are mandatory. Making the check conditional on their presence would turn
    // omitting the signature into a way of skipping verification entirely.
    if (!orderId || !paymentId || !signature) {
      return res.status(400).json({ error: 'orderId, paymentId and signature are all required' });
    }

    const expected = crypto
      .createHmac('sha256', config.RAZORPAY_KEY_SECRET)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');
    const provided = Buffer.from(signature);
    const computed = Buffer.from(expected);
    if (provided.length !== computed.length || !crypto.timingSafeEqual(provided, computed)) {
      return res.status(400).json({ error: 'Payment signature verification failed' });
    }

    // The signature proves the order/payment pair came from Razorpay. It says nothing about
    // whose order it is or what it was worth, so both come from the order itself.
    let order: RazorpayOrder;
    try {
      const orderRes = await fetch(`https://api.razorpay.com/v1/orders/${orderId}`, {
        headers: { Authorization: razorpayAuthHeader() },
      });
      order = (await orderRes.json()) as RazorpayOrder;
      if (!orderRes.ok || !order?.id) {
        console.error('Razorpay order lookup failed:', orderRes.status, order?.error);
        return res.status(502).json({ error: 'Could not confirm the order with Razorpay' });
      }
    } catch (error) {
      console.error('Razorpay order lookup exception:', errorMessage(error));
      return res.status(502).json({ error: 'Could not reach Razorpay' });
    }

    if (order.notes?.userId !== req.user!.id) {
      return res.status(403).json({ error: 'This order belongs to another account' });
    }
    if (order.status !== 'paid') {
      return res.status(402).json({ error: `Order is not paid (status: ${order.status})` });
    }

    const creditAmount = Number(order.notes?.amountUsdc);
    if (
      !Number.isFinite(creditAmount) ||
      creditAmount <= 0 ||
      creditAmount > config.MAX_RECHARGE_USDC
    ) {
      console.error(`Razorpay order ${orderId} carries an unusable amount:`, order.notes);
      return res.status(400).json({ error: 'Order amount is invalid' });
    }

    const arcWallet =
      getWalletByUserId(req.user!.id, 'arc-testnet') ||
      getWalletByUserId(req.user!.id, 'evm') ||
      createCustodialEvmWallet(req.user!.id);
    const solanaWallet =
      getWalletByUserId(req.user!.id, 'solana') || createCustodialSolanaWallet(req.user!.id);

    void sendArcUsdc(arcWallet.address, creditAmount).catch(err => {
      console.warn('Arc treasury background funding warning:', errorMessage(err));
    });
    void sendSolanaUsdc(solanaWallet.address, creditAmount).catch(err => {
      console.warn('Solana treasury background funding warning:', errorMessage(err));
    });

    try {
      // Razorpay's payment id is the idempotency key: replaying it cannot credit twice.
      const entry = credit({
        userId: req.user!.id,
        amount: creditAmount,
        source: 'fiat',
        reference: `razorpay:${paymentId}`,
        description: `Razorpay top-up ${creditAmount} USDC`,
        metadata: { orderId, paymentId },
      });

      res.json({
        success: true,
        credited: creditAmount,
        balance: entry.balance_after,
        txId: paymentId,
        walletAddress: arcWallet.address,
        arcWalletAddress: arcWallet.address,
        evmWalletAddress: arcWallet.address,
        solanaWalletAddress: solanaWallet.address,
      });
    } catch (error) {
      if (error instanceof DuplicateCredit) {
        return res.json({ success: true, credited: 0, duplicate: true });
      }
      console.error('Razorpay crediting failed:', errorMessage(error));
      res.status(500).json({ error: 'Could not apply the Razorpay credit' });
    }
  },
);

/** Whether the custody account can currently honour outstanding credits. */
router.get('/custody', requireSession, async (_req, res) => {
  try {
    const balances = await getBalances(getCustodyAddress());
    res.json({ address: getCustodyAddress(), usdc: balances.usdc, optedIn: balances.optedIn });
  } catch (error) {
    res.status(502).json({ error: errorMessage(error, 'Could not read the custody balance') });
  }
});
