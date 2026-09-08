import { Router } from 'express';
import { getDb } from '../db/connection';
import { authenticate, AuthRequest } from '../middleware/auth';
import { checkApiHealth } from '../services/health';
import { Api } from '../types';

export const router = Router({ mergeParams: true });

router.post('/', authenticate, async (req: AuthRequest, res) => {
  const apiId = req.params.id;
  const api = getDb()
    .prepare('SELECT * FROM apis WHERE id = ? AND publisher_id = ?')
    .get(apiId, req.publisher!.id) as Api;
  if (!api) return res.status(404).json({ error: 'API not found' });

  const health = await checkApiHealth(api);
  res.json(health);
});
