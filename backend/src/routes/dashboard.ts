import { Router } from 'express';
import { getDb } from '../db/connection';
import { authenticate, AuthRequest } from '../middleware/auth';
import {
  getPublisherBalance,
  getSettlementHistory,
  processSettlement,
} from '../services/settlement';
import { config } from '../config';
import { getExplorerTxUrl } from '../services/chains';

import type { HealthCheck } from '../types';

/** Aggregate row from the usage rollup. SUM/AVG over no rows yields NULL, not 0. */
interface UsageTotals {
  requests_today: number | null;
  requests_month: number | null;
  revenue_today: number | null;
  revenue_month: number | null;
  avg_latency: number | null;
  success_rate: number | null;
}

/** One metered call, joined to the API that served it. */
interface CallRow {
  created_at: string;
  method: string;
  path: string;
  status_code: number;
  latency_ms: number;
  revenue: number;
  platform_fee: number;
  publisher_revenue: number;
  txId: string | null;
  api_name: string;
  api_slug: string;
}

export const router = Router({ mergeParams: true });

/** Every dashboard route is API-key authenticated and scoped to its own publisher. */
router.use(authenticate, (req: AuthRequest, res, next) => {
  const requested = (req.params as Record<string, string>).publisherId;
  if (requested !== 'active' && requested !== req.publisher!.id) {
    res.status(403).json({ error: 'Access denied. You can only view your own dashboard.' });
    return;
  }
  next();
});

router.get('/', (req: AuthRequest, res) => {
  const authPublisher = req.publisher!;

  const publisherId = authPublisher.id;
  const db = getDb();

  const balance = getPublisherBalance(publisherId);

  const usageStats = db
    .prepare<unknown[], UsageTotals>(
      `
    SELECT 
      SUM(CASE WHEN date(created_at) >= date('now', 'start of day') THEN 1 ELSE 0 END) as requests_today,
      SUM(CASE WHEN date(created_at) >= date('now', 'start of month') THEN 1 ELSE 0 END) as requests_month,
      SUM(CASE WHEN date(created_at) >= date('now', 'start of day') THEN revenue ELSE 0 END) as revenue_today,
      SUM(CASE WHEN date(created_at) >= date('now', 'start of month') THEN revenue ELSE 0 END) as revenue_month,
      AVG(latency_ms) as avg_latency,
      (CAST(SUM(CASE WHEN status_code < 400 THEN 1 ELSE 0 END) AS FLOAT) / COUNT(*)) * 100 as success_rate
    FROM usage
    WHERE api_id IN (SELECT id FROM apis WHERE publisher_id = ?)
  `,
    )
    .get(publisherId);

  const health = db
    .prepare<unknown[], Pick<HealthCheck, 'status'>>(
      `
    SELECT status FROM health_checks 
    WHERE api_id IN (SELECT id FROM apis WHERE publisher_id = ?)
    ORDER BY created_at DESC LIMIT 1
  `,
    )
    .get(publisherId);

  const transactions = db
    .prepare(
      `
    SELECT t.*, a.name as api_name
    FROM transactions t
    JOIN apis a ON t.api_id = a.id
    WHERE a.publisher_id = ?
    ORDER BY t.created_at DESC
    LIMIT 50
  `,
    )
    .all(publisherId);

  const endpoints = db
    .prepare(
      `
    SELECT e.*, a.name as api_name,
           COUNT(u.id) as request_count,
           SUM(u.revenue) as total_revenue,
           AVG(u.latency_ms) as avg_latency
    FROM endpoints e
    JOIN apis a ON e.api_id = a.id
    LEFT JOIN usage u ON u.endpoint_id = e.id
    WHERE a.publisher_id = ?
    GROUP BY e.id
  `,
    )
    .all(publisherId);

  const settlements = getSettlementHistory(publisherId);

  res.json({
    publisherId: authPublisher.id,
    publisherName: authPublisher.name,
    ...balance,
    requests_today: usageStats?.requests_today || 0,
    requests_month: usageStats?.requests_month || 0,
    revenue_today: usageStats?.revenue_today || 0,
    revenue_month: usageStats?.revenue_month || 0,
    avg_latency: usageStats?.avg_latency ? Math.round(usageStats.avg_latency) : 0,
    success_rate: usageStats?.success_rate != null ? Math.round(usageStats.success_rate) : 100,
    health_status: health?.status || 'ONLINE',
    transactions,
    endpoints,
    settlements,
  });
});

router.get('/transactions', (req: AuthRequest, res) => {
  const authPublisher = req.publisher!;

  const db = getDb();
  const transactions = db
    .prepare(
      `
    SELECT t.*, a.name as api_name
    FROM transactions t
    JOIN apis a ON t.api_id = a.id
    WHERE a.publisher_id = ?
    ORDER BY t.created_at DESC
    LIMIT 50
  `,
    )
    .all(authPublisher.id);
  res.json(transactions);
});

/** Pay the publisher's outstanding balance to their own payout address, on demand. */
router.post('/settle', async (req: AuthRequest, res) => {
  const result = await processSettlement(req.publisher!.id);

  const statusCode = {
    PAID: 200,
    NOTHING_DUE: 400,
    NO_WALLET: 409,
    BELOW_MINIMUM: 400,
    FAILED: 502,
  }[result.status];

  res.status(statusCode).json(
    result.status === 'PAID'
      ? {
          ...result,
          explorerUrl: getExplorerTxUrl(
            result.chain ||
              (result.walletAddress?.startsWith('0x') ? 'base' : config.ALGORAND_NETWORK),
            result.txId,
          ),
        }
      : result,
  );
});

/**
 * Verifiable call log.
 *
 * Publishers should not have to trust that the gateway pays for every call it makes. Each
 * proxied request is listed here with the on-chain transaction that paid for it, so a
 * publisher can reconcile their own server logs against Algorand independently: any request
 * their upstream saw that is missing here, or any row here without a `txId`, is a discrepancy.
 *
 * The gateway settles before proxying, so a call without a transaction cannot occur by design.
 */
router.get('/calls', (req: AuthRequest, res) => {
  const db = getDb();
  const limit = Math.min(Number(req.query.limit) || 100, 500);

  const calls = db
    .prepare<unknown[], CallRow>(
      `
      SELECT u.created_at, u.method, u.path, u.status_code, u.latency_ms,
             u.revenue, u.platform_fee, u.publisher_revenue,
             u.transaction_id AS txId, a.name AS api_name, a.slug AS api_slug
      FROM usage u
      JOIN apis a ON u.api_id = a.id
      WHERE a.publisher_id = ?
      ORDER BY u.created_at DESC
      LIMIT ?
    `,
    )
    .all(req.publisher!.id, limit);

  const unpaid = calls.filter(c => !c.txId).length;

  res.json({
    calls: calls.map(c => ({
      ...c,
      explorerUrl: c.txId ? `${config.EXPLORER_BASE_URL}/tx/${c.txId}` : null,
    })),
    // Any non-zero value here is a bug or an abuse and should be reported.
    unpaidCalls: unpaid,
    verifyHint:
      'Every row carries the Algorand transaction that paid for it. Compare this against your ' +
      'own upstream access logs — a request you served that is not listed here, or a row with ' +
      'no transaction, is a discrepancy worth raising.',
  });
});

router.get('/settlements', (req: AuthRequest, res) => {
  const authPublisher = req.publisher!;

  res.json(getSettlementHistory(authPublisher.id));
});

router.get('/endpoints', (req: AuthRequest, res) => {
  const authPublisher = req.publisher!;

  const db = getDb();
  const endpoints = db
    .prepare(
      `
    SELECT e.*, a.name as api_name,
           COUNT(u.id) as request_count,
           SUM(u.revenue) as total_revenue,
           AVG(u.latency_ms) as avg_latency
    FROM endpoints e
    JOIN apis a ON e.api_id = a.id
    LEFT JOIN usage u ON u.endpoint_id = e.id
    WHERE a.publisher_id = ?
    GROUP BY e.id
  `,
    )
    .all(authPublisher.id);
  res.json(endpoints);
});
