import dotenv from 'dotenv';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

dotenv.config();
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config({ path: path.resolve(process.cwd(), 'backend/.env') });

const isProduction = process.env.NODE_ENV === 'production';

/**
 * Secrets must never be committed. In production a missing secret is fatal.
 * In local development we persist a generated value under data/ so that
 * restarts don't invalidate existing sessions or encrypted wallet keys.
 */
const devSecret = (name: string, bytes: number): string => {
  if (isProduction) {
    throw new Error(
      `${name} is required in production. Generate one with: openssl rand -hex ${bytes}`,
    );
  }
  const dir = path.resolve(process.cwd(), 'data');
  const file = path.join(dir, `.dev-${name.toLowerCase()}`);
  try {
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
    fs.mkdirSync(dir, { recursive: true });
    const generated = crypto.randomBytes(bytes).toString('hex');
    fs.writeFileSync(file, generated, { mode: 0o600 });
    console.warn(`[config] ${name} not set — generated a development-only secret at ${file}`);
    return generated;
  } catch {
    console.warn(`[config] ${name} not set and could not be persisted — using an ephemeral secret`);
    return crypto.randomBytes(bytes).toString('hex');
  }
};

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    if (isProduction) throw new Error(`${name} is required in production`);
    return '';
  }
  return value;
};

/**
 * Everything that differs between Arc network environments, in one place.
 *
 * Switching the whole platform to mainnet is a single env change —
 * ARC_NETWORK_PROFILE=mainnet — and every derived value follows.
 */
const NETWORK_PROFILES = {
  testnet: {
    caip2: 'eip155:5042002',
    chainId: 5042002,
    arcRpc: 'https://rpc.testnet.arc.network',
    arcExplorer: 'https://testnet.arcscan.app',
    arcUsdc: '0x3600000000000000000000000000000000000000',
    solanaRpc: 'https://api.devnet.solana.com',
    stellarRpc: 'https://soroban-testnet.stellar.org',
    stellarHorizon: 'https://horizon-testnet.stellar.org',
    evmChains: 'arc-testnet,ethereum,base,arbitrum,optimism,avalanche,robinhood',
    stellarChains: 'stellar',
  },
  mainnet: {
    caip2: 'eip155:5042001',
    chainId: 5042001,
    arcRpc: 'https://rpc.arc.network',
    arcExplorer: 'https://arcscan.app',
    arcUsdc: '0x3600000000000000000000000000000000000000',
    solanaRpc: 'https://api.mainnet-beta.solana.com',
    stellarRpc: 'https://mainnet.stellar.org',
    stellarHorizon: 'https://horizon.stellar.org',
    evmChains: 'arc,ethereum,base,arbitrum,optimism,avalanche',
    stellarChains: 'stellar',
  },
} as const;

export type NetworkProfileName = keyof typeof NETWORK_PROFILES;

const profileName = (
  process.env.ARC_NETWORK_PROFILE ||
  process.env.ALGORAND_NETWORK_PROFILE ||
  'testnet'
).toLowerCase() as NetworkProfileName;

if (!NETWORK_PROFILES[profileName]) {
  throw new Error(
    `ARC_NETWORK_PROFILE must be one of: ${Object.keys(NETWORK_PROFILES).join(', ')}`,
  );
}

const profile = NETWORK_PROFILES[profileName];

const parseChainOverrides = (raw?: string): Record<string, Record<string, unknown>> => {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('must be a JSON object keyed by chain name');
    }
    return parsed as Record<string, Record<string, unknown>>;
  } catch (error) {
    // Failing closed matters here: a malformed override silently ignored would leave the
    // built-in constants in place, which on mainnet is the wrong token address.
    throw new Error(
      `EVM_CHAIN_OVERRIDES_JSON is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
};

export const config = {
  /** 'testnet' or 'mainnet'. Real funds move on mainnet. */
  NETWORK_PROFILE: profileName,
  IS_MAINNET: profileName === 'mainnet',
  PORT: parseInt(process.env.PORT || '4402', 10),
  NODE_ENV: process.env.NODE_ENV || 'development',
  IS_PRODUCTION: isProduction,
  DATABASE_PATH:
    process.env.DATABASE_PATH && path.isAbsolute(process.env.DATABASE_PATH)
      ? process.env.DATABASE_PATH
      : path.resolve(__dirname, '../data', path.basename(process.env.DATABASE_PATH || 'x402.db')),

  // ---- Arc Testnet (Circle L1 with native USDC gas) ----
  ARC_RPC_URL: process.env.ARC_RPC_URL || profile.arcRpc,
  ARC_CHAIN_ID: parseInt(process.env.ARC_CHAIN_ID || String(profile.chainId), 10),
  /** CAIP-2 network identifier required by x402 v2 (e.g. eip155:5042002) */
  ARC_NETWORK: process.env.ARC_NETWORK || profile.caip2,
  ARC_USDC_ADDRESS: process.env.ARC_USDC_ADDRESS || profile.arcUsdc,
  ARC_EXPLORER_URL: (process.env.ARC_EXPLORER_URL || profile.arcExplorer).replace(/\/$/, ''),
  ARC_USDC_DECIMALS: 6,

  // Compatibility aliases for legacy references & Algorand multi-chain
  ALGORAND_NETWORK:
    process.env.ALGORAND_NETWORK ||
    (profileName === 'mainnet'
      ? 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8='
      : 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI='),
  USDC_ASA_ID: parseInt(
    process.env.USDC_ASA_ID || (profileName === 'mainnet' ? '31566704' : '10458941'),
    10,
  ),
  USDC_DECIMALS: 6,
  ALGORAND_NODE_URL:
    process.env.ALGORAND_NODE_URL ||
    (profileName === 'mainnet'
      ? 'https://mainnet-api.algonode.cloud'
      : 'https://testnet-api.algonode.cloud'),
  ALGORAND_NODE_TOKEN: process.env.ALGORAND_NODE_TOKEN || '',
  ALGORAND_INDEXER_URL:
    process.env.ALGORAND_INDEXER_URL ||
    (profileName === 'mainnet'
      ? 'https://mainnet-idx.algonode.cloud'
      : 'https://testnet-idx.algonode.cloud'),

  // ---- Nanopayments (EIP-3009 Authorizations & Batched Settlement) ----
  NANOPAYMENT_MAX_BATCH_SIZE: parseInt(process.env.NANOPAYMENT_MAX_BATCH_SIZE || '50', 10),
  NANOPAYMENT_BATCH_TIMEOUT_MS: parseInt(process.env.NANOPAYMENT_BATCH_TIMEOUT_MS || '10000', 10),
  NANOPAYMENT_GATEWAY_URL: (
    process.env.NANOPAYMENT_GATEWAY_URL || 'https://gateway.circle.com'
  ).replace(/\/$/, ''),

  // ---- Arc 3-Account Model (Treasury / Settlement / Custody) ----
  ARC_TREASURY_PRIVATE_KEY:
    process.env.ARC_TREASURY_PRIVATE_KEY ||
    process.env.TREASURY_MNEMONIC_EVM ||
    (isProduction ? '' : `0x${devSecret('ARC_TREASURY_PRIVATE_KEY', 32)}`),
  ARC_SETTLEMENT_PRIVATE_KEY:
    process.env.ARC_SETTLEMENT_PRIVATE_KEY ||
    process.env.EVM_SETTLEMENT_PRIVATE_KEY ||
    (isProduction ? '' : `0x${devSecret('ARC_SETTLEMENT_PRIVATE_KEY', 32)}`),
  ARC_CUSTODY_PRIVATE_KEY:
    process.env.ARC_CUSTODY_PRIVATE_KEY ||
    (isProduction ? '' : `0x${devSecret('ARC_CUSTODY_PRIVATE_KEY', 32)}`),
  ARC_SETTLEMENT_ADDRESS:
    process.env.ARC_SETTLEMENT_ADDRESS || process.env.EVM_SETTLEMENT_ADDRESS || '',
  ARC_CUSTODY_ADDRESS: process.env.ARC_CUSTODY_ADDRESS || '',
  ARC_TREASURY_ADDRESS: process.env.ARC_TREASURY_ADDRESS || '',

  // ---- EVM chains ----
  EVM_FACILITATOR_URL: (process.env.EVM_FACILITATOR_URL || 'https://facilitator.x402.rs').replace(
    /\/$/,
    '',
  ),
  EVM_ENABLED_CHAINS: (process.env.EVM_ENABLED_CHAINS || profile.evmChains)
    .split(',')
    .map(c => c.trim().toLowerCase())
    .filter(Boolean),
  EVM_SETTLEMENT_ADDRESS:
    process.env.EVM_SETTLEMENT_ADDRESS || '0x1ad87A1B6bae98d2Ef1f93f5fA4B4105E34f3477',
  EVM_SETTLEMENT_PRIVATE_KEY: process.env.EVM_SETTLEMENT_PRIVATE_KEY || '',

  // ---- Solana chains ----
  SOLANA_FACILITATOR_URL: (
    process.env.SOLANA_FACILITATOR_URL || 'https://facilitator.x402.rs'
  ).replace(/\/$/, ''),
  SOLANA_ENABLED_CHAINS: (process.env.SOLANA_ENABLED_CHAINS || 'solana')
    .split(',')
    .map(c => c.trim().toLowerCase())
    .filter(Boolean),
  SOLANA_SETTLEMENT_ADDRESS:
    process.env.SOLANA_SETTLEMENT_ADDRESS || 'GQoW27n442dBLb5FcMJuYmEbSEYQH5ueqF1tgSdNAUoN',
  SOLANA_SETTLEMENT_PRIVATE_KEY: process.env.SOLANA_SETTLEMENT_PRIVATE_KEY || '',
  TREASURY_MNEMONIC_SOLANA: process.env.TREASURY_MNEMONIC_SOLANA || '',
  SOLANA_RPC_URL: process.env.SOLANA_RPC_URL || profile.solanaRpc,

  // ---- Stellar chains ----
  STELLAR_FACILITATOR_URL: (
    process.env.STELLAR_FACILITATOR_URL || 'https://facilitator.x402.rs'
  ).replace(/\/$/, ''),
  STELLAR_ENABLED_CHAINS: (process.env.STELLAR_ENABLED_CHAINS || profile.stellarChains)
    .split(',')
    .map(c => c.trim().toLowerCase())
    .filter(Boolean),
  STELLAR_SETTLEMENT_ADDRESS:
    process.env.STELLAR_SETTLEMENT_ADDRESS ||
    'GBE4VSYEGQZWNRRON4G4X44MTUFQKWG2EZKVFRU6HOINIMREL6YU7CAI',
  STELLAR_SETTLEMENT_SECRET: process.env.STELLAR_SETTLEMENT_SECRET || '',
  TREASURY_SECRET_STELLAR: process.env.TREASURY_SECRET_STELLAR || '',
  TREASURY_MNEMONIC_STELLAR: process.env.TREASURY_MNEMONIC_STELLAR || '',
  STELLAR_RPC_URL: process.env.STELLAR_RPC_URL || profile.stellarRpc,
  STELLAR_HORIZON_URL: process.env.STELLAR_HORIZON_URL || profile.stellarHorizon,

  /**
   * Per-chain constant overrides, keyed by chain name:
   *   EVM_CHAIN_OVERRIDES_JSON={"base":{"rpcUrl":"https://my-node"},"robinhood":{...}}
   * The escape hatch for a private RPC, or for a chain whose mainnet constants are not in
   * the built-in table.
   */
  CHAIN_OVERRIDES: parseChainOverrides(process.env.EVM_CHAIN_OVERRIDES_JSON),

  // ---- x402 facilitator (pays network fees on our behalf) ----
  // Same URL for testnet and mainnet — only the network and asset change.
  FACILITATOR_URL: (process.env.FACILITATOR_URL || 'https://facilitator.goplausible.xyz').replace(
    /\/$/,
    '',
  ),

  // ---- Bazaar discovery & competition tracking ----
  /**
   * Tag attached to every payment requirement's `extra`. The Global x402 Challenge uses it
   * to attribute this endpoint's activity, so it must survive the move to mainnet.
   */
  X402_CHALLENGE_TAG: process.env.X402_CHALLENGE_TAG || 'x402-global-challenge',
  /** Merchant identity shown in the Bazaar catalog, keyed by the payTo address. */
  MERCHANT_NAME: process.env.MERCHANT_NAME || 'Spigot',
  MERCHANT_WEBSITE: process.env.MERCHANT_WEBSITE || '',
  MERCHANT_LOGO: process.env.MERCHANT_LOGO || '',
  MERCHANT_CATEGORIES: (process.env.MERCHANT_CATEGORIES || 'api,gateway,algorand,x402')
    .split(',')
    .map(c => c.trim())
    .filter(Boolean),

  // ---- Platform revenue + treasury ----
  /** Receives x402 payments. Derived from the treasury mnemonic when not set explicitly. */
  PLATFORM_WALLET_ADDRESS: process.env.PLATFORM_WALLET_ADDRESS || '',
  PLATFORM_FEE_PERCENT: parseFloat(process.env.PLATFORM_FEE_PERCENT || '5'),
  /**
   * OPERATIONS account. Holds ALGO and pays to activate user wallets. Receives reclaimed
   * ALGO from closed wallets and withdrawal fees. Never holds vendor revenue.
   */
  TREASURY_MNEMONIC: process.env.TREASURY_MNEMONIC || '',
  /**
   * EVM TREASURY mnemonic. Holds testnet ETH and USDC to fund user EVM custodial wallets
   * and operations on EVM chains.
   */
  TREASURY_MNEMONIC_EVM: process.env.TREASURY_MNEMONIC_EVM || '',
  /**
   * REVENUE account — the x402 `payTo`. Holds USDC owed to vendors plus platform fees, and
   * is the only account vendor settlements are paid from.
   *
   * Kept separate from the operations account on purpose: onboarding costs must never be
   * paid out of money that belongs to vendors. Falling back to TREASURY_MNEMONIC keeps a
   * single-account setup working, but commingles the two and is warned about at boot.
   */
  SETTLEMENT_MNEMONIC: process.env.SETTLEMENT_MNEMONIC || '',
  /**
   * CUSTODY account. Holds USDC deposited by users — their unspent credits — and is the
   * payer for every on-chain API payment. Kept apart from settlement so user float is never
   * confused with earned revenue. Falls back to the settlement account with a boot warning.
   */
  CUSTODY_MNEMONIC: process.env.CUSTODY_MNEMONIC || '',

  // ---- Credits ----
  /** Smallest and largest custom recharge, in USDC. */
  MIN_RECHARGE_USDC: parseFloat(process.env.MIN_RECHARGE_USDC || '1'),
  MAX_RECHARGE_USDC: parseFloat(process.env.MAX_RECHARGE_USDC || '1000'),
  /**
   * How much less than the tier we still accept as full payment. Network and facilitator
   * costs can shave a little off; the user is credited the full tier regardless.
   */
  RECHARGE_TOLERANCE_USDC: parseFloat(process.env.RECHARGE_TOLERANCE_USDC || '0.25'),
  // ---- Razorpay Gateway (India & Global UPI / Cards) ----
  RAZORPAY_KEY_ID: process.env.RAZORPAY_KEY_ID || '',
  RAZORPAY_KEY_SECRET: process.env.RAZORPAY_KEY_SECRET || '',
  USD_TO_INR_RATE: parseFloat(process.env.USD_TO_INR_RATE || '87.5'),

  /** Shared secret for the fiat onramp webhook signature. Required before going live. */
  ONRAMP_WEBHOOK_SECRET: process.env.ONRAMP_WEBHOOK_SECRET || '',
  /** microAlgos sent to each ACTIVATED wallet: 0.1 ALGO min-balance for one ASA + opt-in fee. */
  WALLET_FUNDING_MICROALGOS: parseInt(process.env.WALLET_FUNDING_MICROALGOS || '201000', 10),
  /**
   * Free USDC granted on activation. Zero in any real deployment — users fund themselves.
   * Only raise it on a throwaway testnet where handing out balance is the point.
   */
  SIGNUP_USDC_GRANT: parseFloat(process.env.SIGNUP_USDC_GRANT || '0'),
  /**
   * Deducted from a withdrawal to recover the ALGO spent activating the wallet. Waived on
   * a full withdrawal, because closing the account returns the ALGO to the treasury anyway.
   */
  WITHDRAWAL_FEE_USDC: parseFloat(process.env.WITHDRAWAL_FEE_USDC || '0.1'),
  /** Smallest withdrawal accepted, so a payout never costs more than it moves. */
  MIN_WITHDRAWAL_USDC: parseFloat(process.env.MIN_WITHDRAWAL_USDC || '0.2'),

  // ---- Sessions & custodial key encryption ----
  SESSION_SECRET: process.env.SESSION_SECRET || devSecret('SESSION_SECRET', 32),
  /** AES-256-GCM key (hex) protecting custodial wallet keys at rest. Rotating it orphans existing wallets. */
  MASTER_ENCRYPTION_KEY:
    process.env.MASTER_ENCRYPTION_KEY || devSecret('MASTER_ENCRYPTION_KEY', 32),
  /** Guards the operational status endpoint. Without it, /admin/status is disabled. */
  ADMIN_TOKEN: process.env.ADMIN_TOKEN || '',
  SESSION_TTL_DAYS: parseInt(process.env.SESSION_TTL_DAYS || '30', 10),

  // ---- Auth providers ----
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',
  MAGIC_LINK_TTL_MINUTES: parseInt(process.env.MAGIC_LINK_TTL_MINUTES || '15', 10),
  OTP_TTL_MINUTES: parseInt(process.env.OTP_TTL_MINUTES || '10', 10),
  OTP_MAX_ATTEMPTS: parseInt(process.env.OTP_MAX_ATTEMPTS || '5', 10),

  // ---- Email delivery ----
  RESEND_API_KEY: process.env.RESEND_API_KEY || '',
  EMAIL_FROM: process.env.EMAIL_FROM || 'Spigot <onboarding@resend.dev>',

  // ---- URLs ----
  GATEWAY_BASE_URL: (process.env.GATEWAY_BASE_URL || 'http://localhost:4402').replace(/\/$/, ''),
  APP_BASE_URL: (process.env.APP_BASE_URL || 'http://localhost:5173').replace(/\/$/, ''),
  EXPLORER_BASE_URL: (process.env.EXPLORER_BASE_URL || profile.arcExplorer).replace(/\/$/, ''),
  /** How long a 402 challenge stays valid, in seconds. */
  PAYMENT_TIMEOUT_SECONDS: parseInt(process.env.PAYMENT_TIMEOUT_SECONDS || '60', 10),

  /**
   * Skips DNS proof of domain ownership. Opt-in only, and never honoured in production —
   * defaulting this to on let any publisher claim a domain they do not control.
   */
  DOMAIN_VERIFY_BYPASS: process.env.DOMAIN_VERIFY_BYPASS === 'true' && !isProduction,

  // ---- Optional Turso replication ----
  TURSO_DATABASE_URL: required('TURSO_DATABASE_URL'),
  TURSO_AUTH_TOKEN: required('TURSO_AUTH_TOKEN'),
};

/**
 * Mainnet moves real money, so the settings that are merely inconvenient on testnet become
 * dangerous. These are checked once at import rather than at first use, so a misconfigured
 * deploy fails at boot instead of halfway through someone's first payment.
 */
if (config.IS_MAINNET) {
  const problems: string[] = [];

  if (!config.ARC_TREASURY_PRIVATE_KEY) {
    problems.push(
      'ARC_TREASURY_PRIVATE_KEY is unset, so the operations account would be generated',
    );
  }
  if (!config.ARC_SETTLEMENT_PRIVATE_KEY) {
    problems.push(
      'ARC_SETTLEMENT_PRIVATE_KEY is unset, so vendor revenue would share the ops account',
    );
  }
  if (config.DOMAIN_VERIFY_BYPASS) {
    problems.push('DOMAIN_VERIFY_BYPASS is on');
  }
  if (config.ARC_EXPLORER_URL.includes('testnet')) {
    problems.push(`ARC_EXPLORER_URL still points at testnet (${config.ARC_EXPLORER_URL})`);
  }
  if (config.ARC_RPC_URL.includes('testnet')) {
    problems.push(`ARC_RPC_URL still points at testnet (${config.ARC_RPC_URL})`);
  }
  if (config.ARC_NETWORK !== NETWORK_PROFILES.mainnet.caip2) {
    problems.push('ARC_NETWORK is overridden to a non-mainnet CAIP-2 identifier');
  }

  if (problems.length) {
    throw new Error(
      `Refusing to start on mainnet:\n  - ${problems.join('\n  - ')}\n` +
        'Fix these, or set ARC_NETWORK_PROFILE=testnet.',
    );
  }
}
