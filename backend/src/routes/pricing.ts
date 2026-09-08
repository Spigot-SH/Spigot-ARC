import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb, syncTursoRecord } from '../db/connection';
import { authenticate, AuthRequest } from '../middleware/auth';
import type { Pricing } from '../types';

export const router = Router({ mergeParams: true });

router.post('/', authenticate, (req: AuthRequest, res) => {
  const { model, price_per_request, monthly_price, included_requests, overage_price, currency } =
    req.body;
  const apiId = req.params.id;

  const db = getDb();
  const api = db
    .prepare('SELECT * FROM apis WHERE id = ? AND publisher_id = ?')
    .get(apiId, req.publisher!.id) as Record<string, unknown> | undefined;
  if (!api) return res.status(404).json({ error: 'API not found' });

  db.prepare('DELETE FROM pricing WHERE api_id = ?').run(apiId);
  const id = uuidv4();
  db.prepare(
    `
    INSERT INTO pricing (id, api_id, model, price_per_request, monthly_price, included_requests, overage_price, currency)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    id,
    apiId,
    model || 'PAY_PER_USE',
    price_per_request,
    monthly_price || null,
    included_requests || null,
    overage_price || null,
    currency || 'USDC',
  );

  const pricingObj = db.prepare<unknown[], Pricing>('SELECT * FROM pricing WHERE id = ?').get(id);
  if (pricingObj) syncTursoRecord('pricing', pricingObj);

  res.json({ id });
});

router.get('/', (req, res) => {
  const apiId = (req.params as Record<string, string>).id;
  const pricing = getDb().prepare('SELECT * FROM pricing WHERE api_id = ?').get(apiId);
  res.json(pricing || null);
});
