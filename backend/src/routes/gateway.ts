import { errorMessage } from '../services/errors';
import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection';
import { Api, Endpoint, Pricing } from '../types';
import { config } from '../config';
import {
  buildPaymentRequirementsList,
  encodeHeader,
  buildExtensions,
  describeEndpoint,
  decodePaymentPayload,
  paymentFingerprint,
  NANOPAYMENT_VERSION,
  X402_VERSION,
} from '../services/x402';
import { verifyPayment, settlePayment } from '../services/facilitator';
import { proxyRequest } from '../services/proxy';
import { getPayerAddress } from '../services/payment';
import { getChainByNetwork } from '../services/chains';

export const router = Router();

/**
 * x402 v2 gateway.
 *
 * 1. Resolve the API, endpoint and price from the slug and path
 * 2. Without a payment header, answer 402 with the payment requirements. The
 *    requirements carry the facilitator's `feePayer`, so the consumer never needs ALGO
 * 3. With a payment header, ask the facilitator to verify (it simulates the group
 *    on-chain), then settle it — the facilitator signs the fee transaction and pays gas
 * 4. Only then proxy upstream and record usage
 *
 * Settling before proxying means a failing upstream cannot be served for free. The
 * trade-off is that a consumer can pay for a request whose upstream then errors; those
 * are recorded in `usage` with the upstream status for refund reconciliation.
 */
router.use(async (req: Request, res: Response) => {
  const fullPath = req.path.replace(/^\//, '');
  const parts = fullPath.split('/');
  const apiSlug = parts[0];
  const rawPath = parts.slice(1).join('/');
  const path = `/${rawPath}`;
  const method = req.method;

  const db = getDb();

  const api = db.prepare('SELECT * FROM apis WHERE slug = ?').get(apiSlug) as Api | undefined;
  if (!api || api.status !== 'PUBLISHED') {
    res.status(404).json({ error: 'API not found or not published' });
    return;
  }

  const normalizedPath = path.replace(/,/g, '/');
  const endpoint = db
    .prepare(
      "SELECT * FROM endpoints WHERE api_id = ? AND method = ? AND (path = ? OR path = ? OR REPLACE(path, ',', '/') = ?)",
    )
    .get(api.id, method, path, normalizedPath, normalizedPath) as Endpoint | undefined;
  if (!endpoint) {
    res.status(404).json({ error: 'Endpoint not found', method, path });
    return;
  }

  const pricing = db.prepare('SELECT * FROM pricing WHERE api_id = ?').get(api.id) as
    Pricing | undefined;
  if (!pricing) {
    res.status(500).json({ error: 'Pricing not configured for this API' });
    return;
  }

  let requirementsList;
  try {
    requirementsList = await buildPaymentRequirementsList(endpoint, pricing);
  } catch (error) {
    console.error('Could not build payment requirements:', errorMessage(error));
    res
      .status(503)
      .json({ error: 'Payment facilitator unavailable', details: errorMessage(error) });
    return;
  }

  // ---- 402 challenge ----
  const paymentHeader =
    req.header('payment-signature') ||
    req.header('nanopayment-signature') ||
    req.header('x-payment');
  const routePrefix = req.baseUrl.includes('x402') ? 'x402' : 'nanopay';
  const resourceUrl = `${config.GATEWAY_BASE_URL}/${routePrefix}/${apiSlug}${path}`;

  if (!paymentHeader) {
    // Multi-chain challenge: accepts[] lists every enabled network
    const challenge = {
      nanopaymentVersion: NANOPAYMENT_VERSION,
      x402Version: X402_VERSION,
      error: 'Payment required',
      resource: {
        url: resourceUrl,
        description: describeEndpoint(endpoint, api.name),
        mimeType: 'application/json',
      },
      accepts: requirementsList,
      extensions: buildExtensions(endpoint),
    };
    res.setHeader('NANOPAYMENT-REQUIRED', encodeHeader(challenge));
    res.setHeader('PAYMENT-REQUIRED', encodeHeader(challenge));
    res.setHeader(
      'Access-Control-Expose-Headers',
      'NANOPAYMENT-REQUIRED, NANOPAYMENT-RESPONSE, PAYMENT-REQUIRED, PAYMENT-RESPONSE',
    );
    res.status(402).json(challenge);
    return;
  }

  const payload = decodePaymentPayload(paymentHeader);
  if (!payload) {
    res.status(400).json({
      error: 'Malformed payment payload',
      nanopaymentVersion: NANOPAYMENT_VERSION,
      x402Version: X402_VERSION,
    });
    return;
  }

  // Match the payment's network against any of the accepted networks
  const requirements = requirementsList.find(r => r.network === payload.network);
  if (!requirements) {
    const chain = getChainByNetwork(payload.network);
    res.status(402).json({
      error: chain ? 'Payment is for an unsupported network' : 'Payment is for the wrong network',
      accepted: requirementsList.map(r => r.network),
      received: payload.network,
    });
    return;
  }

  // ---- Replay protection, before any on-chain work ----
  const fingerprint = paymentFingerprint(payload);
  const alreadyUsed = db
    .prepare('SELECT id FROM transactions WHERE payment_hash = ?')
    .get(fingerprint);
  if (alreadyUsed) {
    res.status(402).json({ error: 'This payment has already been used' });
    return;
  }

  // ---- Verify ----
  let verification;
  try {
    verification = await verifyPayment(payload, requirements);
  } catch (error) {
    console.error('Facilitator verification error:', errorMessage(error));
    res.status(502).json({ error: 'Payment verification failed', details: errorMessage(error) });
    return;
  }

  if (!verification.isValid) {
    res.status(402).json({
      error: 'Payment verification failed',
      reason: verification.invalidReason || 'Unknown reason',
    });
    return;
  }

  // ---- Settle ----
  let settlement;
  try {
    settlement = await settlePayment(payload, requirements);
  } catch (error) {
    console.error('Facilitator settlement error:', errorMessage(error));
    res.status(502).json({ error: 'Payment settlement failed', details: errorMessage(error) });
    return;
  }

  if (!settlement.success || !settlement.transaction) {
    res.status(402).json({
      error: 'Payment settlement failed',
      reason: settlement.errorReason || 'Unknown reason',
    });
    return;
  }

  const txId = settlement.transaction;
  const payerAddress = getPayerAddress(payload) || 'unknown';

  try {
    db.prepare(
      `
      INSERT INTO transactions (id, api_id, tx_id, payment_hash, payer_address, amount, asset_id, network, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      uuidv4(),
      api.id,
      txId,
      fingerprint,
      payerAddress,
      pricing.price_per_request,
      requirements.asset,
      requirements.network,
      'CONFIRMED',
      new Date().toISOString(),
    );
  } catch (error: unknown) {
    const sqlError = error as { code?: string };
    if (sqlError.code?.startsWith('SQLITE_CONSTRAINT')) {
      res.status(402).json({ error: 'This payment has already been used' });
      return;
    }
    throw error;
  }

  // ---- Serve ----
  res.setHeader('NANOPAYMENT-RESPONSE', encodeHeader(settlement));
  res.setHeader('PAYMENT-RESPONSE', encodeHeader(settlement));
  res.setHeader(
    'Access-Control-Expose-Headers',
    'NANOPAYMENT-REQUIRED, NANOPAYMENT-RESPONSE, PAYMENT-REQUIRED, PAYMENT-RESPONSE',
  );

  const result = await proxyRequest(req, res, api, endpoint);

  const fee = pricing.price_per_request * (config.PLATFORM_FEE_PERCENT / 100);
  const publisherRevenue = pricing.price_per_request - fee;

  db.prepare(
    `
    INSERT INTO usage (id, api_id, endpoint_id, consumer_address, transaction_id, method, path,
                       status_code, latency_ms, response_size, revenue, platform_fee, publisher_revenue, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    uuidv4(),
    api.id,
    endpoint.id,
    payerAddress,
    txId,
    method,
    path,
    result.statusCode,
    result.latency,
    result.responseSize,
    pricing.price_per_request,
    fee,
    publisherRevenue,
    new Date().toISOString(),
  );
});
