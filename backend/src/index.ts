import { errorMessage } from './services/errors';
import 'dotenv/config';
import crypto from 'crypto';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { config } from './config';
import { runMigrations } from './db/migrations';
import { getSyncStatus } from './db/connection';
import { errorHandler } from './middleware/errorHandler';
import { withSession } from './middleware/session';
import { startReconciliation } from './services/reconciliation';
import { isNetworkSupported, facilitatorHealth } from './services/facilitator';
import {
  isTreasuryConfigured,
  getSettlementAddress,
  getOperationsAddress,
  getCustodyAddress,
  ensureTreasuryReady,
  getSolvency,
} from './services/treasury';

import { router as publishersRouter } from './routes/publishers';
import { router as verificationRouter } from './routes/verification';
import { router as apisRouter } from './routes/apis';
import { router as pricingRouter } from './routes/pricing';
import { router as testingRouter } from './routes/testing';
import { router as dashboardRouter } from './routes/dashboard';
import { router as gatewayRouter } from './routes/gateway';
import { router as authRouter } from './routes/auth';
import { router as consumeRouter } from './routes/consume';
import { router as creditsRouter } from './routes/credits';

const app = express();

app.use(
  cors({
    origin: config.IS_PRODUCTION ? [config.APP_BASE_URL] : true,
    credentials: true,
    exposedHeaders: [
      'PAYMENT-REQUIRED',
      'PAYMENT-RESPONSE',
      'NANOPAYMENT-REQUIRED',
      'NANOPAYMENT-RESPONSE',
      'NANOPAYMENT-SIGNATURE',
    ],
  }),
);

app.use(cookieParser());

app.use((req, res, next) => {
  // Gateway traffic is proxied verbatim, so its body must stay raw.
  if (
    req.path.startsWith('/nanopay/') ||
    req.path.startsWith('/api/nanopay/') ||
    req.path.startsWith('/pay/') ||
    req.path.startsWith('/api/pay/') ||
    req.path.startsWith('/x402/') ||
    req.path.startsWith('/api/x402/')
  ) {
    express.raw({ type: '*/*', limit: '10mb' })(req, res, next);
  } else {
    express.json()(req, res, next);
  }
});

app.use(withSession);

runMigrations();

// Refund any credit reserved for a call that never settled (e.g. a crash mid-payment).
startReconciliation();

/**
 * Public health check. Deliberately minimal.
 *
 * Account addresses and solvency figures are operational intelligence — they map the
 * platform's treasury layout and reveal how much it holds and owes — so they live behind
 * ADMIN_TOKEN rather than being served to anonymous callers.
 */
app.get(['/api/health', '/health'], async (_req, res) => {
  let facilitatorUp: boolean;
  try {
    await facilitatorHealth();
    facilitatorUp = true;
  } catch {
    facilitatorUp = false;
  }

  res.json({
    status: 'ok',
    network: config.NETWORK_PROFILE,
    primaryNetwork: config.ARC_NETWORK,
    usdcAddress: config.ARC_USDC_ADDRESS,
    usdcAssetId: config.USDC_ASA_ID,
    facilitator: facilitatorUp ? 'up' : 'unreachable',
  });
});

/** Full operational view — treasury addresses, balances and liabilities. */
app.get(['/api/admin/status', '/admin/status'], async (req, res) => {
  if (!config.ADMIN_TOKEN) {
    return res.status(503).json({ error: 'ADMIN_TOKEN is not configured' });
  }
  const provided = String(req.header('x-admin-token') || '');
  const expected = config.ADMIN_TOKEN;
  if (
    provided.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
  ) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let facilitator: unknown;
  try {
    facilitator = await facilitatorHealth();
  } catch (error) {
    facilitator = { status: 'unreachable', error: errorMessage(error) };
  }
  let solvency: unknown;
  try {
    solvency = await getSolvency();
  } catch (error) {
    solvency = { error: errorMessage(error) };
  }

  res.json({
    status: 'ok',
    networkProfile: config.NETWORK_PROFILE,
    network: config.ARC_NETWORK,
    primaryNetwork: config.ARC_NETWORK,
    arcChainId: config.ARC_CHAIN_ID,
    usdcAddress: config.ARC_USDC_ADDRESS,
    usdcAssetId: config.USDC_ASA_ID,
    treasuryConfigured: isTreasuryConfigured(),
    // Three pots: operations pays fees, custody holds user credits, settlement holds revenue.
    accounts: isTreasuryConfigured()
      ? {
          operations: getOperationsAddress(),
          settlement: getSettlementAddress(),
          custody: getCustodyAddress(),
        }
      : null,
    solvency,
    replication: getSyncStatus(),
    facilitator,
  });
});

app.use(['/api/auth', '/auth'], authRouter);
app.use(['/api/consume', '/consume'], consumeRouter);
app.use(['/api/credits', '/credits'], creditsRouter);
app.use(['/api/publishers', '/publishers'], publishersRouter);
app.use(['/api/verify', '/verify'], verificationRouter);
app.use(['/api/apis', '/apis'], apisRouter);
app.use(['/api/apis/:id/pricing', '/apis/:id/pricing'], pricingRouter);
app.use(['/api/apis/:id/test', '/apis/:id/test'], testingRouter);
app.use(['/api/dashboard/:publisherId', '/dashboard/:publisherId'], dashboardRouter);
app.use(['/nanopay', '/api/nanopay', '/pay', '/api/pay', '/x402', '/api/x402'], gatewayRouter);

const discoveryPayload = {
  nanopaymentVersion: 1,
  x402Version: 2,
  merchant: {
    name: config.MERCHANT_NAME,
    address: getSettlementAddress(),
    network: config.ARC_NETWORK,
    tag: config.X402_CHALLENGE_TAG,
    tags: ['hackathon', 'arc', 'nanopayments', 'api-gateway'],
    category: 'hackathon',
    description: 'Spigot — sell an HTTP API by the call, metered per request',
    website: config.MERCHANT_WEBSITE || 'https://x402-algorand.onrender.com',
  },
};

app.get(
  [
    '/.well-known/nanopayments.json',
    '/api/.well-known/nanopayments.json',
    '/.well-known/x402.json',
    '/api/.well-known/x402.json',
  ],
  (_req, res) => {
    res.json(discoveryPayload);
  },
);

app.use(errorHandler);

/** Surface configuration problems at boot rather than on the first payment. */
const reportReadiness = async () => {
  try {
    const supported = await isNetworkSupported();
    if (supported) {
      console.log(`Facilitator ready: ${config.FACILITATOR_URL} covers ${config.ARC_NETWORK}`);
    } else {
      console.warn(
        `Warning: facilitator ${config.FACILITATOR_URL} does not list ${config.ARC_NETWORK}`,
      );
    }
  } catch (error) {
    console.warn(`Warning: could not reach the facilitator — ${errorMessage(error)}`);
  }

  if (!isTreasuryConfigured()) {
    console.warn('Warning: Treasury is not set up. New wallets cannot be funded.');
    return;
  }

  // Opts both accounts into USDC if needed, so incoming payments are not rejected.
  const treasury = await ensureTreasuryReady();
  console[treasury.operations.ready ? 'log' : 'warn'](
    `Operations (funds wallets): ${getOperationsAddress()} — ${treasury.operations.message}`,
  );
  if (!treasury.shared) {
    console[treasury.settlement.ready ? 'log' : 'warn'](
      `Settlement (receives payments): ${getSettlementAddress()} — ${treasury.settlement.message}`,
    );
  }
  console[treasury.custody.ready ? 'log' : 'warn'](
    `Custody (holds user credits): ${getCustodyAddress()} — ${treasury.custody.message}`,
  );
  treasury.warnings.forEach(warning => console.warn(`Warning: ${warning}`));

  try {
    const s = await getSolvency();
    const vendors = `Vendor liability ${s.owedToVendors.toFixed(6)} USDC against ${s.settlementBalance.toFixed(6)} held`;
    console[s.solvent ? 'log' : 'warn'](
      s.solvent ? vendors : `Warning: settlement account is short — ${vendors}`,
    );

    const users = `User credits outstanding ${s.owedToUsers.toFixed(6)} USDC against ${s.custodyBalance.toFixed(6)} held`;
    console[s.custodySolvent ? 'log' : 'warn'](
      s.custodySolvent ? users : `Warning: custody account is short — ${users}`,
    );
  } catch (error) {
    console.warn(`Warning: could not compute solvency — ${errorMessage(error)}`);
  }
};

app.listen(config.PORT, '0.0.0.0', () => {
  console.log(`Spigot running on port ${config.PORT}`);
  console.log(
    `Network: ${config.ARC_NETWORK} | USDC ${config.ARC_USDC_ADDRESS} | Nanopayments enabled`,
  );
  void reportReadiness();
});

export default app;
