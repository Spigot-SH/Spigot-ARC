import { Router } from 'express';
import yaml from 'js-yaml';
import { v4 as uuidv4 } from 'uuid';
import { getDb, syncTursoRecord } from '../db/connection';
import { authenticate, AuthRequest } from '../middleware/auth';
import { probeUpstream } from '../services/health';
import { encryptSecret } from '../services/vault';
import { Api, Endpoint } from '../types';

/**
 * An endpoint as posted by the onboarding wizard or the CLI. Every field is optional because
 * this is untrusted request body, and both snake_case and camelCase spellings are accepted.
 */
interface EndpointPayload {
  name?: string;
  description?: string;
  method?: string;
  path?: string;
  auth_required?: boolean;
  request_schema?: unknown;
  requestSchema?: unknown;
  response_schema?: unknown;
  responseSchema?: unknown;
  example_request?: unknown;
  exampleRequest?: unknown;
  example_response?: unknown;
  exampleResponse?: unknown;
}

export const router = Router();

/** One row of the public marketplace listing. `skills` arrives as a GROUP_CONCAT string. */
interface MarketplaceRow {
  id: string;
  name: string;
  slug: string;
  publisherName: string;
  description: string;
  pricePerRequest: number | null;
  skills: string | null;
  avgLatency: number | null;
  uptime: number | null;
}

/** The subset of an OpenAPI operation object this importer reads. */
interface OpenApiOperation {
  summary?: string;
  operationId?: string;
  description?: string;
  security?: unknown[];
  requestBody?: unknown;
  responses?: Record<string, unknown>;
}

/** The subset of an OpenAPI document this importer walks. */
interface OpenApiSpec {
  paths?: Record<string, Record<string, unknown>>;
}

/** An endpoint extracted from a spec, before it is written to the database. */
interface ExtractedEndpoint {
  id: string;
  api_id: string;
  name: string;
  description: string;
  method: string;
  path: string;
  auth_required: boolean;
}

router.get('/', (req, res) => {
  const apis = getDb()
    .prepare(
      `
    SELECT a.id, a.name, a.slug, p.name as publisherName, a.name as description, pr.price_per_request as pricePerRequest,
           GROUP_CONCAT(s.name) as skills,
           (SELECT AVG(latency_ms) FROM health_checks WHERE api_id = a.id) as avgLatency,
           (SELECT (SUM(CASE WHEN status = 'ONLINE' THEN 1 ELSE 0 END) * 100.0 / COUNT(*)) FROM health_checks WHERE api_id = a.id) as uptime
    FROM apis a
    JOIN publishers p ON a.publisher_id = p.id
    LEFT JOIN pricing pr ON a.id = pr.api_id
    LEFT JOIN skills s ON a.id = s.api_id
    WHERE a.status = 'PUBLISHED'
    GROUP BY a.id
  `,
    )
    .all();

  res.json(
    (apis as MarketplaceRow[]).map(api => ({
      ...api,
      skills: api.skills ? api.skills.split(',') : [],
    })),
  );
});

router.post('/', authenticate, (req: AuthRequest, res) => {
  const db = getDb();
  const name = req.body.name;
  const version = req.body.version;
  const base_url = req.body.base_url || req.body.baseUrl;
  const auth_type = req.body.auth_type || req.body.authType || 'NONE';
  const auth_config = req.body.auth_config || req.body.authConfig || {};
  const id = uuidv4();
  const slug =
    name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + Math.random().toString(36).substr(2, 5);

  db.prepare(
    `
    INSERT INTO apis (id, publisher_id, name, version, base_url, auth_type, auth_config, slug)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    id,
    req.publisher!.id,
    name,
    version,
    base_url,
    auth_type,
    // Encrypted at rest: these are the publisher's upstream credentials, and a database
    // leak that exposed them would let anyone call their API for free.
    encryptSecret(JSON.stringify(auth_config || {})),
    slug,
  );

  const apiObj = db.prepare('SELECT * FROM apis WHERE id = ?').get(id) as Api | undefined;
  if (apiObj) syncTursoRecord('apis', apiObj);

  res.json({ id, slug });
});

/**
 * Public view of an API.
 *
 * `base_url` and `auth_config` are deliberately withheld. They are the publisher's upstream
 * address and credentials — publishing them would let anyone bypass the gateway and call the
 * publisher's API directly, for free, forever. Only the owner sees them.
 */
router.get('/:id', (req: AuthRequest, res) => {
  const db = getDb();
  const api = db.prepare('SELECT * FROM apis WHERE id = ?').get(req.params.id) as Api | undefined;
  if (!api) return res.status(404).json({ error: 'API not found' });

  const endpoints = db
    .prepare(
      `
      SELECT id, api_id, name, description, method, path, auth_required,
             request_schema, response_schema, example_request, example_response, created_at
      FROM endpoints WHERE api_id = ?
    `,
    )
    .all(req.params.id);

  // Owner check runs off whichever credential is present; anonymous callers get the safe view.
  const viewerPublisherId =
    req.publisher?.id ||
    (req.user?.id
      ? (
          db.prepare('SELECT publisher_id FROM users WHERE id = ?').get(req.user.id) as
            { publisher_id: string | null } | undefined
        )?.publisher_id
      : undefined);

  if (viewerPublisherId && viewerPublisherId === api.publisher_id) {
    return res.json({ api, endpoints, isOwner: true });
  }

  const { base_url, auth_config, auth_type, ...publicApi } = api;
  res.json({ api: publicApi, endpoints, isOwner: false });
});

router.post('/:id/endpoints', authenticate, (req: AuthRequest, res) => {
  const api = getDb()
    .prepare('SELECT * FROM apis WHERE id = ? AND publisher_id = ?')
    .get(req.params.id, req.publisher!.id);
  if (!api) return res.status(404).json({ error: 'API not found' });

  const db = getDb();
  // Schemas and examples feed the Bazaar discovery extension, so a catalog entry can show
  // what the caller actually receives rather than just the endpoint name.
  const insertStmt = db.prepare(`
    INSERT INTO endpoints (id, api_id, name, description, method, path, auth_required,
                           request_schema, response_schema, example_request, example_response)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const asJson = (value: unknown) =>
    value === undefined || value === null ? null : JSON.stringify(value);

  const cleanPath = (p?: string) => {
    if (!p) return '/';
    let formatted = p.trim().replace(/,/g, '/');
    if (!formatted.startsWith('/')) formatted = '/' + formatted;
    return formatted;
  };

  if (Array.isArray(req.body.endpoints)) {
    let count = 0;
    const insertMany = db.transaction((endpoints: EndpointPayload[]) => {
      for (const ep of endpoints) {
        insertStmt.run(
          uuidv4(),
          req.params.id,
          ep.name,
          ep.description,
          ep.method,
          cleanPath(ep.path),
          ep.auth_required ? 1 : 0,
          asJson(ep.request_schema ?? ep.requestSchema),
          asJson(ep.response_schema ?? ep.responseSchema),
          asJson(ep.example_request ?? ep.exampleRequest),
          asJson(ep.example_response ?? ep.exampleResponse),
        );
        count++;
      }
    });
    insertMany(req.body.endpoints);
    return res.json({ count });
  }

  const { name, description, method, path, auth_required } = req.body;
  const id = uuidv4();
  insertStmt.run(
    id,
    req.params.id,
    name,
    description,
    method,
    cleanPath(path),
    auth_required ? 1 : 0,
    asJson(req.body.request_schema),
    asJson(req.body.response_schema),
    asJson(req.body.example_request),
    asJson(req.body.example_response),
  );

  res.json({ id });
});

router.post('/:id/import', authenticate, async (req: AuthRequest, res) => {
  const { spec } = req.body;
  if (!spec) return res.status(400).json({ error: 'spec is required' });

  const db = getDb();
  const api = db
    .prepare('SELECT * FROM apis WHERE id = ? AND publisher_id = ?')
    .get(req.params.id, req.publisher!.id);
  if (!api) return res.status(404).json({ error: 'API not found' });

  let content = spec;
  if (typeof spec === 'string' && spec.startsWith('http')) {
    try {
      const response = await fetch(spec);
      content = await response.text();
    } catch (err) {
      return res.status(400).json({ error: 'Failed to fetch spec URL' });
    }
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(content);
  } catch (err) {
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      return res.status(400).json({ error: 'Failed to parse spec as YAML or JSON' });
    }
  }

  if (!parsed || typeof parsed !== 'object' || !('paths' in parsed)) {
    return res.status(400).json({ error: 'Invalid OpenAPI spec: missing paths' });
  }
  const openApiSpec = parsed as OpenApiSpec;
  const specPaths = openApiSpec.paths;
  if (!specPaths || typeof specPaths !== 'object') {
    return res.status(400).json({ error: 'Invalid OpenAPI spec: missing paths' });
  }

  // Eleven columns, matching the eleven values bound below and the manual endpoint route.
  // This statement previously declared only seven, so every import threw "too many parameter
  // values" and the route returned "Failed to insert endpoints" for every spec ever submitted.
  const insertStmt = db.prepare(`
    INSERT INTO endpoints (id, api_id, name, description, method, path, auth_required,
                           request_schema, response_schema, example_request, example_response)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const asJson = (value: unknown) =>
    value === undefined || value === null ? null : JSON.stringify(value);
  const extractedEndpoints: ExtractedEndpoint[] = [];

  const insertMany = db.transaction(() => {
    for (const [pathPattern, methods] of Object.entries(specPaths)) {
      if (!methods || typeof methods !== 'object') continue;
      for (const [method, details] of Object.entries(methods)) {
        if (!['get', 'post', 'put', 'delete', 'patch'].includes(method.toLowerCase())) continue;

        const endpointDetails = details as OpenApiOperation;
        const name =
          endpointDetails.summary ||
          endpointDetails.operationId ||
          `${method.toUpperCase()} ${pathPattern}`;
        const description = endpointDetails.description || '';
        const id = uuidv4();

        const okResponse = endpointDetails.responses?.['200'] as
          { content?: Record<string, { example?: unknown }> } | undefined;
        const example = okResponse?.content?.['application/json']?.example ?? null;
        insertStmt.run(
          id,
          req.params.id,
          name,
          description,
          method.toUpperCase(),
          pathPattern,
          0,
          null,
          null,
          null,
          asJson(example),
        );
        extractedEndpoints.push({
          id,
          api_id: String(req.params.id),
          name,
          description,
          method: method.toUpperCase(),
          path: pathPattern,
          auth_required: false,
        });
      }
    }
  });

  try {
    insertMany();
    res.json({ endpoints: extractedEndpoints });
  } catch (err) {
    res.status(500).json({ error: 'Failed to insert endpoints' });
  }
});

router.put('/:id/publish', authenticate, async (req: AuthRequest, res) => {
  const db = getDb();
  const api = db
    .prepare<unknown[], Api>('SELECT * FROM apis WHERE id = ? AND publisher_id = ?')
    .get(req.params.id, req.publisher!.id);
  if (!api) return res.status(404).json({ error: 'API not found' });

  const endpoints = db
    .prepare<unknown[], { c: number }>('SELECT COUNT(*) as c FROM endpoints WHERE api_id = ?')
    .get(api.id);
  const pricing = db.prepare('SELECT * FROM pricing WHERE api_id = ?').get(api.id);
  const wallet = db.prepare('SELECT * FROM wallets WHERE publisher_id = ?').get(api.publisher_id);

  if (!endpoints || endpoints.c === 0 || !pricing || !wallet) {
    return res.status(400).json({ error: 'Must have endpoints, pricing, and wallet to publish' });
  }

  // The gateway is the only monetization layer. An upstream that demands its own payment cannot be
  // monetised in one transaction, and would charge the consumer then return a 402.
  const firstEndpoint = db
    .prepare('SELECT path, method FROM endpoints WHERE api_id = ? LIMIT 1')
    .get(api.id) as { path: string; method: string } | undefined;
  const probeUrl = `${String(api.base_url).replace(/\/$/, '')}${firstEndpoint?.path || ''}`;
  const probe = await probeUpstream(probeUrl, firstEndpoint?.method || 'GET');

  if (probe.paymentProtected) {
    return res.status(400).json({
      error: 'That endpoint is already payment-protected',
      details:
        'Register a plain endpoint and set your price here — the gateway adds nanopayments, collects ' +
        'payment and credits your balance. Fronting an already-paid endpoint would charge the ' +
        'caller twice and return them a payment demand instead of your data.',
      probedUrl: probeUrl,
    });
  }

  /**
   * Only these three upstream auth schemes are actually applied by `services/proxy.ts`.
   *
   * The onboarding UI also offers OAUTH and CUSTOM, promising they are "configured in the
   * developer portal post-publishing" — there is no such portal. An API published with one of
   * them proxies upstream with no credentials at all, and because the gateway settles payment
   * *before* the upstream call, the consumer pays real USDC and then receives the upstream's
   * 401. Refusing to publish is the same protection the x402 check above provides: do not let
   * a publisher go live with a configuration that takes money and cannot deliver.
   */
  const SUPPORTED_AUTH_TYPES = ['NONE', 'API_KEY', 'BEARER', 'BASIC'];
  const declaredAuthType = String(api.auth_type || 'NONE').toUpperCase();

  if (!SUPPORTED_AUTH_TYPES.includes(declaredAuthType)) {
    return res.status(400).json({
      error: `Upstream authentication type "${api.auth_type}" is not supported`,
      details:
        'The gateway can attach an API key, a bearer token or basic credentials to your ' +
        'upstream request. It cannot perform an OAuth exchange. Publishing this way would ' +
        'charge the caller and then return your upstream’s 401, because payment settles ' +
        'before the request is proxied. Choose API_KEY, BEARER, BASIC, or NONE.',
      supported: SUPPORTED_AUTH_TYPES,
    });
  }

  db.prepare(
    "UPDATE apis SET status = 'PUBLISHED', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
  ).run(api.id);

  const updatedApi = db.prepare('SELECT * FROM apis WHERE id = ?').get(api.id) as Api | undefined;
  if (updatedApi) syncTursoRecord('apis', updatedApi);
  if (pricing) syncTursoRecord('pricing', pricing as unknown as Record<string, unknown>);
  if (wallet) syncTursoRecord('wallets', wallet as unknown as Record<string, unknown>);

  const allEndpoints = db
    .prepare('SELECT * FROM endpoints WHERE api_id = ?')
    .all(api.id) as Endpoint[];
  for (const ep of allEndpoints) {
    syncTursoRecord('endpoints', ep);
  }

  res.json({ success: true });
});

router.post('/:id/skills', authenticate, (req: AuthRequest, res) => {
  const { name } = req.body;
  const id = uuidv4();
  getDb()
    .prepare('INSERT INTO skills (id, api_id, name) VALUES (?, ?, ?)')
    .run(id, req.params.id, name);
  res.json({ id });
});
