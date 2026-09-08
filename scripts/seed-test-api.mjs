#!/usr/bin/env node
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.resolve(__dirname, '../backend/data/x402.db');

const db = new Database(dbPath);

console.log(`Seeding test API into ${dbPath}...`);

// 1. Publisher
db.prepare(
  `
  INSERT INTO publishers (id, name, email, company, website, api_key, status)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    email = excluded.email,
    company = excluded.company,
    website = excluded.website,
    status = excluded.status
`,
).run(
  'pub_arc_weather',
  'Arc Weather Intelligence',
  'publisher@arc.network',
  'Arc Network Labs',
  'https://arc.network',
  'pk_live_arc_weather_demo',
  'ACTIVE',
);

// 2. Publisher Payout Wallet
db.prepare(
  `
  INSERT INTO wallets (id, publisher_id, chain, address, settlement_frequency, min_payout)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    address = excluded.address,
    chain = excluded.chain
`,
).run(
  'wal_arc_weather',
  'pub_arc_weather',
  'arc-testnet',
  '0x1ad87A1B6bae98d2Ef1f93f5fA4B4105E34f3477',
  'daily',
  1.0,
);

// 3. API
db.prepare(
  `
  INSERT INTO apis (id, publisher_id, name, version, base_url, auth_type, auth_config, status, slug)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    version = excluded.version,
    base_url = excluded.base_url,
    auth_type = excluded.auth_type,
    status = excluded.status,
    slug = excluded.slug
`,
).run(
  'api_arc_weather',
  'pub_arc_weather',
  'Arc Weather API',
  '1.0',
  'https://httpbin.org',
  'NONE',
  '{}',
  'PUBLISHED',
  'arc-weather',
);

// 4. Endpoint
db.prepare(
  `
  INSERT INTO endpoints (id, api_id, name, description, method, path, auth_required, example_response)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    description = excluded.description,
    method = excluded.method,
    path = excluded.path,
    example_response = excluded.example_response
`,
).run(
  'ep_arc_weather',
  'api_arc_weather',
  'Current Conditions & Telemetry',
  'Real-time atmospheric telemetry and client diagnostics settled via Arc Testnet nanopayments (0.01 USDC).',
  'GET',
  '/get',
  0,
  JSON.stringify({ status: 'active', network: 'arc-testnet', temp: '22C', conditions: 'Clear' }),
);

// 5. Pricing (0.01 USDC)
db.prepare(
  `
  INSERT INTO pricing (id, api_id, model, price_per_request, currency)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    price_per_request = excluded.price_per_request,
    currency = excluded.currency
`,
).run('pr_arc_weather', 'api_arc_weather', 'PAY_PER_USE', 0.01, 'USDC');

// 6. Skill tags
db.prepare(`DELETE FROM skills WHERE api_id = ?`).run('api_arc_weather');
db.prepare(`INSERT INTO skills (id, api_id, name) VALUES (?, ?, ?)`).run(
  'sk_arc_weather_1',
  'api_arc_weather',
  'Weather',
);
db.prepare(`INSERT INTO skills (id, api_id, name) VALUES (?, ?, ?)`).run(
  'sk_arc_weather_2',
  'api_arc_weather',
  'Telemetry',
);

// 7. Health check so uptime & latency display on marketplace
db.prepare(
  `
  INSERT INTO health_checks (id, api_id, dns_ok, https_ok, endpoint_ok, latency_ms, auth_ok, schema_ok, status)
  VALUES (?, ?, 1, 1, 1, ?, 1, 1, 'ONLINE')
  ON CONFLICT(id) DO UPDATE SET
    latency_ms = excluded.latency_ms,
    status = excluded.status
`,
).run('hc_arc_weather', 'api_arc_weather', 45);

console.log('Successfully seeded Arc Weather API (slug: arc-weather, price: 0.01 USDC)!');
