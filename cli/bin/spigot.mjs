#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
// js-yaml v5 dropped the ESM default export; `load` and `dump` are named exports now.
import { load as yamlLoad, dump as yamlDump } from 'js-yaml';
import { request, ApiError, baseUrl } from '../lib/api.mjs';
import { readConfig, writeConfig, clearConfig, configPath } from '../lib/config.mjs';
import { ask, ok, warn, fail, info, bold, dim, table, withSpinner } from '../lib/ui.mjs';

const MANIFEST = 'spigot.yaml';

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

const login = async args => {
  const apiUrl = flag(args, '--api') || readConfig().apiUrl;
  if (apiUrl) writeConfig({ apiUrl });

  const email = flag(args, '--email') || (await ask('Email: '));
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('That is not a valid email address.');

  await withSpinner(
    'Sending code…',
    request('/api/auth/otp', { method: 'POST', body: { email }, auth: false }),
  );
  console.log(`\nWe emailed a 6-digit code to ${bold(email)}.`);

  const code = await ask('Code: ');
  const session = await request('/api/auth/otp/verify', {
    method: 'POST',
    body: { email, code, mode: 'token' },
    auth: false,
  });

  if (!session.token) return fail('The server did not return a CLI token. Is it up to date?');

  writeConfig({
    token: session.token,
    email: session.user.email,
    publisherId: session.user.publisherId,
  });
  ok(`Signed in as ${session.user.email}`);
  info(`Credentials stored in ${configPath()} (readable only by you)`);
};

const logout = async () => {
  try {
    await request('/api/auth/logout', { method: 'POST' });
  } catch {
    // The local credential is removed regardless of whether the server could be reached.
  }
  clearConfig();
  ok('Signed out.');
};

const whoami = async () => {
  const me = await request('/api/auth/me');
  if (!me.user) return fail('Not signed in. Run: spigot login');

  console.log(`${bold(me.user.email)}`);
  info(`gateway    ${baseUrl()}`);
  info(`publisher  ${me.user.publisherId || 'not registered yet — run: spigot publish'}`);
  info(`credit     ${(me.credits ?? 0).toFixed(2)} USDC`);
};

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

const readManifest = () => {
  const file = path.resolve(process.cwd(), MANIFEST);
  if (!fs.existsSync(file)) {
    throw new Error(`No ${MANIFEST} here. Run: spigot init`);
  }
  return yamlLoad(fs.readFileSync(file, 'utf8')) || {};
};

const writeManifest = manifest => {
  fs.writeFileSync(path.resolve(process.cwd(), MANIFEST), yamlDump(manifest, { lineWidth: 100 }));
};

/**
 * Build the endpoint list from an OpenAPI document.
 *
 * The catalog entry is only as useful as its descriptions, so `summary`/`description` are
 * carried across and the response example is kept — those are what a human or an agent sees
 * when browsing the Bazaar.
 */
const endpointsFromOpenApi = spec => {
  const endpoints = [];
  for (const [route, methods] of Object.entries(spec.paths || {})) {
    for (const [method, details] of Object.entries(methods || {})) {
      if (!['get', 'post', 'put', 'delete', 'patch'].includes(method)) continue;
      const example =
        details?.responses?.['200']?.content?.['application/json']?.example ??
        details?.responses?.['200']?.content?.['application/json']?.schema?.example;

      endpoints.push({
        name: details.summary || details.operationId || `${method.toUpperCase()} ${route}`,
        method: method.toUpperCase(),
        path: route,
        description: details.description || details.summary || '',
        ...(example ? { exampleResponse: example } : {}),
      });
    }
  }
  return endpoints;
};

const init = async args => {
  const target = path.resolve(process.cwd(), MANIFEST);
  if (fs.existsSync(target) && !args.includes('--force')) {
    return fail(`${MANIFEST} already exists. Pass --force to overwrite.`);
  }

  const source = flag(args, '--openapi');
  let endpoints;
  let name = path.basename(process.cwd());
  let baseUrlValue = '';

  if (source) {
    const raw = source.startsWith('http')
      ? await (await fetch(source)).text()
      : fs.readFileSync(path.resolve(source), 'utf8');
    const spec = yamlLoad(raw);

    endpoints = endpointsFromOpenApi(spec);
    name = spec.info?.title || name;
    baseUrlValue = spec.servers?.[0]?.url || '';
    ok(`Read ${endpoints.length} endpoint(s) from ${source}`);
  } else {
    endpoints = [
      {
        name: 'Example endpoint',
        method: 'GET',
        path: '/example',
        description: 'Describe exactly what the caller receives, not just the topic',
      },
    ];
  }

  const manifest = {
    name,
    version: '1.0',
    // Your API's public base URL. The gateway adds nanopayments in front of it — your service
    // itself needs no payment code and must NOT be payment-protected.
    baseUrl: baseUrlValue || 'https://api.example.com',
    pricePerRequest: 0.01,
    chain: 'arc-testnet',
    payoutAddress: '',
    auth: { type: 'NONE' },
    endpoints,
  };

  writeManifest(manifest);
  ok(`Wrote ${MANIFEST}`);
  info('Set baseUrl, pricePerRequest and payoutAddress, then run: spigot publish');
};

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

const publish = async () => {
  const manifest = readManifest();
  const cfg = readConfig();

  for (const field of ['name', 'baseUrl', 'pricePerRequest']) {
    if (!manifest[field]) return fail(`${MANIFEST} is missing "${field}".`);
  }
  if (!manifest.endpoints?.length) return fail(`${MANIFEST} lists no endpoints.`);

  // Register as a publisher on first publish; the email comes from the verified session.
  let publisherId = cfg.publisherId;
  if (!publisherId) {
    const created = await request('/api/publishers', {
      method: 'POST',
      body: { name: manifest.publisher || manifest.name, website: manifest.website },
    });
    publisherId = created.id;
    writeConfig({ publisherId });
    ok(`Registered publisher ${publisherId}`);
  }

  if (manifest.payoutAddress) {
    try {
      await request(`/api/publishers/${publisherId}/wallet`, {
        method: 'POST',
        body: {
          address: manifest.payoutAddress,
          chain: manifest.chain || 'arc-testnet',
          min_payout: manifest.minPayout ?? 1,
        },
      });
      ok('Payout address set');
    } catch (error) {
      // A change to an existing address needs an emailed confirmation code.
      if (error.body?.confirmationRequired) {
        warn('Changing your payout address needs confirmation.');
        const code = await ask('Emailed confirmation code: ');
        await request(`/api/publishers/${publisherId}/wallet`, {
          method: 'POST',
          body: {
            address: manifest.payoutAddress,
            chain: manifest.chain || 'arc-testnet',
            confirmationCode: code,
          },
        });
        ok('Payout address updated');
      } else throw error;
    }
  } else {
    warn('No payoutAddress in the manifest — you cannot be paid until one is set.');
  }

  const api = await request('/api/apis', {
    method: 'POST',
    body: {
      name: manifest.name,
      version: String(manifest.version || '1.0'),
      base_url: manifest.baseUrl,
      auth_type: manifest.auth?.type || 'NONE',
      auth_config: manifest.auth?.config || {},
    },
  });
  ok(`Created API ${api.slug}`);

  await request(`/api/apis/${api.id}/endpoints`, {
    method: 'POST',
    body: {
      endpoints: manifest.endpoints.map(e => ({
        name: e.name,
        description: e.description,
        method: (e.method || 'GET').toUpperCase(),
        path: e.path,
        // Carried through to the Bazaar catalog so callers see a real response sample.
        example_response: e.exampleResponse,
        example_request: e.exampleRequest,
        request_schema: e.requestSchema,
        response_schema: e.responseSchema,
      })),
    },
  });
  ok(`Added ${manifest.endpoints.length} endpoint(s)`);

  await request(`/api/apis/${api.id}/pricing`, {
    method: 'POST',
    body: { model: 'PAY_PER_USE', price_per_request: Number(manifest.pricePerRequest) },
  });
  ok(`Priced at ${manifest.pricePerRequest} USDC per request`);

  try {
    await withSpinner(
      'Checking your endpoint…',
      request(`/api/apis/${api.id}/publish`, { method: 'PUT' }),
    );
  } catch (error) {
    fail(error.message);
    if (error.body?.details) info(error.body.details);
    if (error.body?.probedUrl) info(`probed: ${error.body.probedUrl}`);
    process.exitCode = 1;
    return;
  }

  writeManifest({ ...manifest, apiId: api.id, slug: api.slug });
  console.log();
  ok(`${bold(manifest.name)} is live`);
  info(`gateway url  ${baseUrl()}/nanopay/${api.slug}${manifest.endpoints[0].path}`);
  info(`callers pay  ${manifest.pricePerRequest} USDC per request`);
  info('track it with: spigot status');
};

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const status = async () => {
  const dashboard = await request('/api/dashboard/active');

  console.log(bold(dashboard.publisherName || 'Your APIs'));
  info(`available   ${(dashboard.available ?? 0).toFixed(6)} USDC`);
  info(`settled     ${(dashboard.settled ?? 0).toFixed(6)} USDC`);
  info(`requests    ${dashboard.requests_month ?? 0} this month`);
  info(`avg latency ${dashboard.avg_latency ?? 0} ms`);
  console.log();

  table(dashboard.endpoints || [], [
    { header: 'METHOD', get: r => r.method },
    { header: 'PATH', get: r => r.path },
    { header: 'CALLS', get: r => r.request_count ?? 0 },
    { header: 'REVENUE', get: r => (r.total_revenue ?? 0).toFixed(4) },
  ]);
};

const earnings = async () => {
  const dashboard = await request('/api/dashboard/active');
  console.log(`${bold((dashboard.available ?? 0).toFixed(6))} USDC available`);
  info(`${(dashboard.settled ?? 0).toFixed(6)} USDC already settled`);
  if ((dashboard.available ?? 0) > 0) info('withdraw with: spigot settle');
};

const settle = async () => {
  const cfg = readConfig();
  if (!cfg.publisherId) return fail('Not registered as a publisher yet. Run: spigot publish');

  try {
    const result = await withSpinner(
      'Settling…',
      request(`/api/dashboard/${cfg.publisherId}/settle`, { method: 'POST' }),
    );
    ok(`Paid ${Number(result.settlement?.amount ?? 0).toFixed(6)} USDC to your payout address`);
    if (result.explorerUrl) info(result.explorerUrl);
  } catch (error) {
    fail(error.body?.message || error.message);
  }
};

/** Every call with the on-chain transaction that paid for it, so you can verify us. */
const calls = async args => {
  const limit = flag(args, '--limit') || '20';
  const result = await request(`/api/dashboard/active/calls?limit=${limit}`);

  table(result.calls || [], [
    { header: 'WHEN', get: r => new Date(r.created_at).toLocaleString() },
    { header: 'ENDPOINT', get: r => `${r.method} ${r.path}` },
    { header: 'STATUS', get: r => r.status_code },
    { header: 'EARNED', get: r => (r.publisher_revenue ?? 0).toFixed(6) },
    { header: 'PAID BY TX', get: r => (r.txId ? r.txId.slice(0, 16) + '…' : 'MISSING') },
  ]);

  console.log();
  if (result.unpaidCalls > 0) {
    fail(`${result.unpaidCalls} call(s) have no payment transaction — please report this.`);
  } else {
    ok('Every call is backed by an on-chain payment.');
  }
  info(result.verifyHint || '');
};

// ---------------------------------------------------------------------------

const flag = (args, name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const help = () => {
  console.log(`
${bold('spigot')} — list and monetise your API on Spigot

${bold('Getting started')}
  spigot login [--email you@co.com] [--api URL]   Sign in with an emailed code
  spigot init [--openapi spec.yaml|URL]           Create ${MANIFEST}, optionally from OpenAPI
  spigot publish                                  Register, price and go live

${bold('Running it')}
  spigot status                                   Traffic and revenue per endpoint
  spigot earnings                                 What you can withdraw
  spigot settle                                   Pay your balance to your own wallet
  spigot calls [--limit 20]                       Every call with its on-chain payment

${bold('Account')}
  spigot whoami                                   Who you are signed in as
  spigot logout                                   Remove local credentials

${dim(`Your API needs no payment code — the gateway adds nanopayments in front of it.
Do not point it at an endpoint that is already payment-protected.`)}
`);
};

const COMMANDS = { login, logout, whoami, init, publish, status, earnings, settle, calls, help };

const main = async () => {
  const [command = 'help', ...args] = process.argv.slice(2);
  const run = COMMANDS[command];

  if (!run) {
    fail(`Unknown command: ${command}`);
    help();
    process.exitCode = 1;
    return;
  }

  try {
    await run(args);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      fail(error.message);
      info('Run: spigot login');
    } else {
      fail(error.message || String(error));
    }
    process.exitCode = 1;
  }
};

main();
