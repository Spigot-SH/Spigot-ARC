import { errorMessage } from '../services/errors';
import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection';
import { config } from '../config';
import { Api, Endpoint, Pricing } from '../types';
import { SessionRequest, requireSession } from '../middleware/session';
import { limitPerUser } from '../services/rateLimit';
import { buildPaymentRequirements, fromAtomicUnits, toAtomicUnits } from '../services/x402';
import { getBalance, debit, credit, InsufficientCredit } from '../services/credits';
import {
  createPaymentForWallet,
  createEvmPaymentForWallet,
  createSolanaPaymentForWallet,
  createStellarPaymentForWallet,
  encodePaymentHeader,
} from '../services/payment';
import {
  getWalletByUserId,
  createCustodialWallet,
  createCustodialEvmWallet,
  createCustodialSolanaWallet,
  createCustodialStellarWallet,
} from '../services/wallet';
import { PaymentRequirements } from '../services/facilitator';
import { getExplorerTxUrl, getChainByNetwork } from '../services/chains';
import { provisionStellarWallet, ensureStellarUserFloat } from '../services/treasury';

export const router = Router();

const explorerUrl = (txId: string, network?: string) =>
  network ? getExplorerTxUrl(network, txId) : `${config.EXPLORER_BASE_URL}/tx/${txId}`;

/**
 * Call a paid endpoint on the user's behalf.
 *
 * The backend holds the key, builds the gasless payment group and replays the request
 * through the gateway with the payment attached. From the caller's point of view this is
 * a single authenticated request — there is no wallet, no popup and no ALGO to manage.
 */
// Credit makes abuse self-funding, but a burst can still exhaust a publisher's quota.
router.post(
  '/:apiSlug',
  requireSession,
  limitPerUser('consume', 120, 60_000),
  async (req: SessionRequest, res) => {
    const { apiSlug } = req.params;
    const { endpointId, query, body, headers, chain } = req.body || {};

    const db = getDb();

    const api = db.prepare('SELECT * FROM apis WHERE slug = ?').get(apiSlug) as Api | undefined;
    if (!api || api.status !== 'PUBLISHED') {
      return res.status(404).json({ error: 'API not found or not published' });
    }

    const endpoint = endpointId
      ? (db
          .prepare('SELECT * FROM endpoints WHERE id = ? AND api_id = ?')
          .get(endpointId, api.id) as Endpoint | undefined)
      : (db.prepare('SELECT * FROM endpoints WHERE api_id = ? LIMIT 1').get(api.id) as
          Endpoint | undefined);
    if (!endpoint) {
      return res.status(404).json({ error: 'Endpoint not found for this API' });
    }

    const pricing = db.prepare('SELECT * FROM pricing WHERE api_id = ?').get(api.id) as
      Pricing | undefined;
    if (!pricing) {
      return res.status(500).json({ error: 'Pricing not configured for this API' });
    }

    // ---- Reserve the credit BEFORE spending anything on chain ----
    //
    // Checking the balance and debiting afterwards is not safe: concurrent requests all pass
    // the check, all settle on chain, and only one debit lands — the custody account pays for
    // calls nobody was charged for. Debiting first makes the ledger the gate, because the
    // debit is atomic and refuses to go negative. A failed payment is refunded below.
    const holdRef = `hold:${uuidv4()}`;
    let balanceAfterHold: number;
    try {
      const held = debit({
        userId: req.user!.id,
        amount: pricing.price_per_request,
        source: 'crypto',
        reference: holdRef,
        description: `${endpoint.method} ${endpoint.path} on ${api.name}`,
        metadata: { apiId: api.id, endpointId: endpoint.id, state: 'held' },
      });
      balanceAfterHold = held.balance_after;
    } catch (error) {
      if (error instanceof InsufficientCredit) {
        return res.status(402).json({
          error: 'Insufficient credit',
          required: pricing.price_per_request,
          available: error.available,
          topUpRequired: true,
        });
      }
      throw error;
    }

    /** Give the credit back when the call could not be delivered. */
    const releaseHold = (reason: string) => {
      try {
        credit({
          userId: req.user!.id,
          kind: 'REFUND',
          amount: pricing.price_per_request,
          source: 'system',
          reference: `refund:${holdRef}`,
          description: `Refund — ${reason}`,
        });
      } catch (refundError) {
        console.error('Refund failed for', holdRef, errorMessage(refundError));
      }
    };

    // ---- Build and sign the gasless payment ----
    // EVM chains use the platform custody key; Algorand uses the user's custodial wallet.
    let requirements: PaymentRequirements;
    let paymentHeader: string;
    let payerAddress: string;
    try {
      const publisherWallet = db
        .prepare('SELECT * FROM wallets WHERE publisher_id = ?')
        .get(api.publisher_id) as { chain?: string; address?: string } | undefined;

      // Determine requested chain: priority is explicit body param, else publisher's wallet chain, else default Arc Testnet
      let targetChain = chain || publisherWallet?.chain;
      if (!targetChain || targetChain === 'algorand') {
        targetChain = config.IS_MAINNET ? 'arc' : 'arc-testnet';
      }

      const selectedChainInfo = getChainByNetwork(targetChain);
      const isEvm = selectedChainInfo ? selectedChainInfo.family === 'evm' : true;
      const isSolana = selectedChainInfo ? selectedChainInfo.family === 'solana' : false;
      const isStellar = selectedChainInfo ? selectedChainInfo.family === 'stellar' : false;

      if (isEvm && selectedChainInfo) {
        const payTo =
          config.ARC_SETTLEMENT_ADDRESS ||
          config.EVM_SETTLEMENT_ADDRESS ||
          '0x1ad87A1B6bae98d2Ef1f93f5fA4B4105E34f3477';

        requirements = {
          scheme: 'exact',
          network: selectedChainInfo.caip2,
          asset: selectedChainInfo.usdcAddress,
          amount: toAtomicUnits(pricing.price_per_request),
          payTo,
          maxTimeoutSeconds: config.PAYMENT_TIMEOUT_SECONDS,
          extra: {
            decimals: selectedChainInfo.usdcDecimals,
            name: selectedChainInfo.tokenName || 'USDC',
            version: selectedChainInfo.tokenVersion || '2',
            tag: config.X402_CHALLENGE_TAG,
          },
        };

        const userWallet =
          getWalletByUserId(req.user!.id, 'arc-testnet') || createCustodialEvmWallet(req.user!.id);
        const payload = await createEvmPaymentForWallet(userWallet, requirements);
        payerAddress = userWallet.address;
        paymentHeader = encodePaymentHeader(payload);
      } else if (isSolana && selectedChainInfo) {
        const payTo =
          config.SOLANA_SETTLEMENT_ADDRESS || 'GQoW27n442dBLb5FcMJuYmEbSEYQH5ueqF1tgSdNAUoN';

        requirements = {
          scheme: 'exact',
          network: selectedChainInfo.caip2,
          asset: selectedChainInfo.usdcAddress,
          amount: toAtomicUnits(pricing.price_per_request),
          payTo,
          maxTimeoutSeconds: config.PAYMENT_TIMEOUT_SECONDS,
          extra: {
            decimals: selectedChainInfo.usdcDecimals,
            name: selectedChainInfo.tokenName || 'USDC',
            tag: config.X402_CHALLENGE_TAG,
            feePayer:
              config.SOLANA_SETTLEMENT_ADDRESS || 'GQoW27n442dBLb5FcMJuYmEbSEYQH5ueqF1tgSdNAUoN',
          },
        };

        const userWallet =
          getWalletByUserId(req.user!.id, 'solana') || createCustodialSolanaWallet(req.user!.id);
        const payload = await createSolanaPaymentForWallet(userWallet, requirements);
        payerAddress = userWallet.address;
        paymentHeader = encodePaymentHeader(payload);
      } else if (isStellar && selectedChainInfo) {
        const payTo =
          config.STELLAR_SETTLEMENT_ADDRESS ||
          'GBE4VSYEGQZWNRRON4G4X44MTUFQKWG2EZKVFRU6HOINIMREL6YU7CAI';

        requirements = {
          scheme: 'exact',
          network: selectedChainInfo.caip2,
          asset: selectedChainInfo.usdcAddress,
          amount: Math.round(
            pricing.price_per_request * 10 ** selectedChainInfo.usdcDecimals,
          ).toString(),
          payTo,
          maxTimeoutSeconds: config.PAYMENT_TIMEOUT_SECONDS,
          extra: {
            decimals: selectedChainInfo.usdcDecimals,
            name: selectedChainInfo.tokenName || 'USDC',
            tag: config.X402_CHALLENGE_TAG,
            areFeesSponsored: true,
          },
        };

        const userWallet =
          getWalletByUserId(req.user!.id, 'stellar') || createCustodialStellarWallet(req.user!.id);

        await provisionStellarWallet(userWallet).catch(() => null);
        await ensureStellarUserFloat(userWallet.address, pricing.price_per_request).catch(
          () => null,
        );

        const payload = await createStellarPaymentForWallet(userWallet, requirements);
        payerAddress = userWallet.address;
        paymentHeader = encodePaymentHeader(payload);
      } else {
        // Algorand: sign from user's custodial wallet with payTo = Platform Treasury
        requirements = await buildPaymentRequirements(endpoint, pricing);

        const userWallet =
          getWalletByUserId(req.user!.id, 'algorand') ||
          createCustodialWallet(req.user!.id, 'algorand');
        payerAddress = userWallet.address;
        const payload = await createPaymentForWallet(userWallet, requirements);
        paymentHeader = encodePaymentHeader(payload);
      }
    } catch (error) {
      console.error('Payment construction failed:', errorMessage(error));
      releaseHold('payment could not be built');
      return res
        .status(502)
        .json({ error: 'Could not build the payment', details: errorMessage(error) });
    }

    // ---- Replay the request through the gateway with the payment attached ----
    const search =
      query && Object.keys(query).length
        ? `?${new URLSearchParams(query as Record<string, string>).toString()}`
        : '';
    const target = `${config.GATEWAY_BASE_URL}/nanopay/${apiSlug}${endpoint.path}${search}`;

    const started = Date.now();
    try {
      const upstream = await fetch(target, {
        method: endpoint.method,
        headers: {
          'Content-Type': 'application/json',
          'PAYMENT-SIGNATURE': paymentHeader,
          'NANOPAYMENT-SIGNATURE': paymentHeader,
          ...(headers && typeof headers === 'object' ? headers : {}),
        },
        body: ['GET', 'HEAD'].includes(endpoint.method) ? undefined : JSON.stringify(body ?? {}),
      });

      const text = await upstream.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        // Upstream returned something that is not JSON — pass the text through unchanged.
      }

      const settleHeader = upstream.headers.get('payment-response');
      const settlement = settleHeader
        ? JSON.parse(Buffer.from(settleHeader, 'base64').toString('utf8'))
        : null;

      // The upstream demanded its own payment, so the caller got a payment demand instead of
      // data despite having paid us. Refund, and suspend the API so it stops charging others.
      if (upstream.status === 402 && settlement?.transaction) {
        releaseHold('the publisher endpoint is itself x402-protected');
        getDb()
          .prepare(
            "UPDATE apis SET status = 'SUSPENDED', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
          )
          .run(api.id);
        console.error(
          `API ${api.slug} suspended: upstream ${api.base_url} is x402-protected and returned 402 ` +
            'after we had already settled. Publishers must supply a plain endpoint.',
        );
        return res.status(502).json({
          ok: false,
          status: 502,
          error: 'This API is misconfigured and has been suspended. You were not charged.',
          balance: getBalance(req.user!.id),
        });
      }

      // The credit was already taken above. If the gateway did not settle a payment, the
      // call was not delivered as paid, so give it back.
      if (!settlement?.transaction) {
        releaseHold(`gateway returned ${upstream.status} without settlement`);
        return res.status(upstream.status === 200 ? 502 : upstream.status).json({
          ok: false,
          status: upstream.status,
          error: 'The call did not settle — your credit was not charged',
          response: parsed,
          balance: getBalance(req.user!.id),
        });
      }

      // Link the reservation to the transaction that fulfilled it, so every debit can be
      // traced to an on-chain transfer.
      getDb()
        .prepare('UPDATE credit_transactions SET metadata = ? WHERE reference = ?')
        .run(
          JSON.stringify({
            apiId: api.id,
            endpointId: endpoint.id,
            state: 'settled',
            txId: settlement.transaction,
          }),
          holdRef,
        );

      const remainingBalance = balanceAfterHold;

      res.status(upstream.ok ? 200 : upstream.status).json({
        ok: upstream.ok,
        status: upstream.status,
        latencyMs: Date.now() - started,
        response: parsed,
        balance: remainingBalance,
        payment: settlement?.transaction
          ? {
              txId: settlement.transaction,
              network: settlement.network || requirements.network,
              amountUsdc: fromAtomicUnits(
                requirements.amount,
                typeof requirements.extra?.decimals === 'number'
                  ? requirements.extra.decimals
                  : config.USDC_DECIMALS,
              ),
              explorerUrl: explorerUrl(
                settlement.transaction,
                settlement.network || requirements.network,
              ),
              paidBy: payerAddress,
              gasPaidByFacilitator: Boolean(requirements.extra?.feePayer),
            }
          : null,
      });
    } catch (error) {
      console.error('Gateway call failed:', errorMessage(error));
      releaseHold('gateway call failed');
      res.status(502).json({ error: 'Gateway call failed', details: errorMessage(error) });
    }
  },
);

/** Price and readiness for an endpoint, so the UI can show cost before the user commits. */
router.get('/:apiSlug/quote', requireSession, async (req: SessionRequest, res) => {
  const db = getDb();
  const api = db.prepare('SELECT * FROM apis WHERE slug = ?').get(req.params.apiSlug) as
    Api | undefined;
  if (!api) return res.status(404).json({ error: 'API not found' });

  const pricing = db.prepare('SELECT * FROM pricing WHERE api_id = ?').get(api.id) as
    Pricing | undefined;
  const balance = getBalance(req.user!.id);

  return res.json({
    pricePerRequest: pricing?.price_per_request ?? null,
    currency: pricing?.currency ?? 'USDC',
    balance,
    canPay: Boolean(pricing && balance >= pricing.price_per_request),
    callsAffordable: pricing?.price_per_request
      ? Math.floor(balance / pricing.price_per_request)
      : 0,
  });
});
