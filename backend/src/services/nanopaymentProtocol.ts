import crypto from 'crypto';
import { config } from '../config';
import { Endpoint, Pricing } from '../types';
import { PaymentRequirements, PaymentPayload, getFeePayer } from './facilitator';
import { getSettlementAddress } from './treasury';
import { getEnabledChains, isEvmNetwork, isSolanaNetwork, isStellarNetwork } from './chains';

export const NANOPAYMENT_VERSION = 1;
export const X402_VERSION = 2; // Kept for legacy x402 compatibility

/** USDC is quoted in whole units in the database but transacted in atomic units on chain. */
export const toAtomicUnits = (amount: number): string =>
  Math.round(amount * 10 ** config.USDC_DECIMALS).toString();

export const fromAtomicUnits = (atomic: string | number, decimals = config.USDC_DECIMALS): number =>
  Number(atomic) / 10 ** decimals;

/**
 * Build payment requirements for an endpoint. Default primary is Arc Testnet.
 */
export const buildPaymentRequirements = async (
  _endpoint: Endpoint,
  pricing: Pricing,
): Promise<PaymentRequirements> => {
  return {
    scheme: 'exact',
    network: config.ARC_NETWORK,
    asset: config.ARC_USDC_ADDRESS,
    amount: toAtomicUnits(pricing.price_per_request),
    payTo: getSettlementAddress(),
    maxTimeoutSeconds: config.PAYMENT_TIMEOUT_SECONDS,
    extra: {
      decimals: config.ARC_USDC_DECIMALS,
      tag: config.X402_CHALLENGE_TAG,
      bazaar: {
        name: config.MERCHANT_NAME,
        description: 'Spigot — sell an HTTP API by the call, metered per request on Arc Testnet',
        category: 'hackathon',
        tags: ['hackathon', 'arc', 'nanopayments', 'gateway'],
        website: config.MERCHANT_WEBSITE || 'https://spigot.network',
      },
      name: config.MERCHANT_NAME,
      merchantName: config.MERCHANT_NAME,
      tags: ['hackathon', 'arc', 'nanopayments', 'gateway'],
      category: 'hackathon',
      website: config.MERCHANT_WEBSITE || 'https://spigot.network',
    },
  };
};

/**
 * Build payment requirements for every enabled chain, so the 402 challenge can offer
 * the consumer a choice of networks.
 */
export const buildPaymentRequirementsList = async (
  _endpoint: Endpoint,
  pricing: Pricing,
): Promise<PaymentRequirements[]> => {
  const chains = getEnabledChains();
  const feePayer = await getFeePayer();

  return chains.map((chain): PaymentRequirements => {
    let payTo: string;
    if (chain.family === 'evm') {
      payTo =
        config.ARC_SETTLEMENT_ADDRESS || config.EVM_SETTLEMENT_ADDRESS || getSettlementAddress();
    } else if (chain.family === 'solana') {
      payTo = config.SOLANA_SETTLEMENT_ADDRESS || 'GQoW27n442dBLb5FcMJuYmEbSEYQH5ueqF1tgSdNAUoN';
    } else if (chain.family === 'stellar') {
      payTo =
        config.STELLAR_SETTLEMENT_ADDRESS ||
        'GBE4VSYEGQZWNRRON4G4X44MTUFQKWG2EZKVFRU6HOINIMREL6YU7CAI';
    } else {
      payTo = getSettlementAddress();
    }

    const atomicAmount = Math.round(
      pricing.price_per_request * 10 ** chain.usdcDecimals,
    ).toString();

    return {
      scheme: 'exact',
      network: chain.caip2,
      asset: chain.usdcAddress,
      amount: atomicAmount,
      payTo,
      maxTimeoutSeconds: config.PAYMENT_TIMEOUT_SECONDS,
      extra: {
        decimals: chain.usdcDecimals,
        tag: config.X402_CHALLENGE_TAG,
        bazaar: {
          name: config.MERCHANT_NAME,
          description:
            'Nanopayments Multi-Chain API Gateway — Monetized APIs on Arc Testnet, EVM, Solana & Stellar',
          category: 'hackathon',
          tags: ['hackathon', 'nanopayments', chain.name, 'gateway'],
          website: config.MERCHANT_WEBSITE || 'https://spigot.network',
        },
        name: chain.family !== 'algorand' ? chain.tokenName || 'USDC' : config.MERCHANT_NAME,
        ...(chain.family === 'evm' ? { version: chain.tokenVersion || '2' } : {}),
        merchantName: config.MERCHANT_NAME,
        tags: ['hackathon', 'nanopayments', chain.name, 'gateway'],
        category: 'hackathon',
        website: config.MERCHANT_WEBSITE || 'https://spigot.network',
        ...(chain.family === 'algorand' && feePayer ? { feePayer } : {}),
        ...(chain.family === 'solana'
          ? {
              feePayer:
                config.SOLANA_SETTLEMENT_ADDRESS || 'GQoW27n442dBLb5FcMJuYmEbSEYQH5ueqF1tgSdNAUoN',
            }
          : {}),
        ...(chain.family === 'stellar' ? { areFeesSponsored: true } : {}),
      },
    };
  });
};

const parseJson = (value: unknown): Record<string, unknown> | undefined => {
  if (!value || typeof value !== 'string') return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Discovery metadata so catalogs can index this endpoint.
 */
export const buildExtensions = (endpoint: Endpoint): Record<string, unknown> => {
  const isBodyMethod = !['GET', 'HEAD', 'DELETE'].includes(endpoint.method.toUpperCase());
  const exampleRequest = parseJson(endpoint.example_request);
  const exampleResponse = parseJson(endpoint.example_response);
  const requestSchema = parseJson(endpoint.request_schema);
  const responseSchema = parseJson(endpoint.response_schema);

  const discovery = {
    discovery: {
      ...(isBodyMethod ? { bodyType: 'json' } : {}),
      ...(exampleRequest ? { input: exampleRequest } : {}),
      ...(requestSchema ? { inputSchema: requestSchema } : {}),
      output: {
        ...(exampleResponse ? { example: exampleResponse } : {}),
        ...(responseSchema ? { schema: responseSchema } : {}),
      },
    },
  };

  return {
    ...discovery,
    'spigot-merchant': {
      info: {
        name: config.MERCHANT_NAME,
        ...(config.MERCHANT_WEBSITE ? { website: config.MERCHANT_WEBSITE } : {}),
        ...(config.MERCHANT_LOGO ? { logo: config.MERCHANT_LOGO } : {}),
        categories: config.MERCHANT_CATEGORIES,
      },
    },
  };
};

export interface PaymentChallenge {
  nanopaymentVersion: number;
  x402Version: number;
  error: string;
  resource: { url: string; description: string; mimeType: string };
  accepts: PaymentRequirements[];
  extensions?: Record<string, unknown>;
}

export const buildChallenge = (
  resourceUrl: string,
  description: string,
  requirements: PaymentRequirements,
  extensions?: Record<string, unknown>,
): PaymentChallenge => ({
  nanopaymentVersion: NANOPAYMENT_VERSION,
  x402Version: X402_VERSION,
  error: 'Payment required',
  resource: { url: resourceUrl, description, mimeType: 'application/json' },
  accepts: [requirements],
  ...(extensions ? { extensions } : {}),
});

/**
 * Catalog description of the endpoint.
 */
export const describeEndpoint = (endpoint: Endpoint, apiName: string): string => {
  const detail = (endpoint.description || '').trim();
  if (detail) return detail;
  return `${endpoint.name || `${endpoint.method} ${endpoint.path}`} — ${apiName}`;
};

export const encodeHeader = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString('base64');

/** Decode and structurally validate the client's payment payload. */
export const decodePaymentPayload = (header: string): PaymentPayload | null => {
  try {
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));

    // Accept nanopaymentVersion, x402Version, or exact scheme
    if (
      decoded?.nanopaymentVersion !== NANOPAYMENT_VERSION &&
      decoded?.x402Version !== X402_VERSION &&
      decoded?.version !== 1 &&
      decoded?.version !== 2 &&
      decoded?.scheme !== 'exact'
    ) {
      return null;
    }
    if (decoded?.scheme !== 'exact' || typeof decoded?.network !== 'string') return null;

    // EVM payloads use { signature, authorization }
    if (isEvmNetwork(decoded.network)) {
      if (!decoded?.payload || typeof decoded.payload !== 'object') return null;
      return decoded as PaymentPayload;
    }

    // Solana payloads use { transaction }
    if (isSolanaNetwork(decoded.network)) {
      if (!decoded?.payload || typeof decoded.payload !== 'object') return null;
      const tx = (decoded.payload as Record<string, unknown>)?.transaction;
      if (!tx || typeof tx !== 'string') return null;
      return decoded as PaymentPayload;
    }

    // Stellar payloads use { authEntry } or { transaction }
    if (isStellarNetwork(decoded.network)) {
      if (!decoded?.payload || typeof decoded.payload !== 'object') return null;
      return decoded as PaymentPayload;
    }

    // AVM (Algorand) payloads use { paymentGroup, paymentIndex }
    const group = decoded?.payload?.paymentGroup;
    const index = decoded?.payload?.paymentIndex;

    if (!Array.isArray(group) || group.length === 0 || group.length > 16) return null;
    if (!group.every((t: unknown) => typeof t === 'string')) return null;
    if (!Number.isInteger(index) || index < 0 || index >= group.length) return null;

    return decoded as PaymentPayload;
  } catch {
    return null;
  }
};

/**
 * Stable fingerprint of a payment, used to reject replays of the same signed
 * payment before it is settled a second time.
 */
export const paymentFingerprint = (payload: PaymentPayload): string => {
  const p = payload.payload as Record<string, unknown>;

  // EVM: hash the signature and nonce
  if (isEvmNetwork(payload.network)) {
    const sig = (p.signature as string) || '';
    const auth = p.authorization as Record<string, unknown> | undefined;
    const nonce = (auth?.nonce as string) || '';
    return crypto.createHash('sha256').update(`${sig}|${nonce}`).digest('hex');
  }

  // Solana: hash the wire transaction
  if (isSolanaNetwork(payload.network)) {
    const tx = (p.transaction as string) || '';
    return crypto.createHash('sha256').update(tx).digest('hex');
  }

  // Stellar: hash the authEntry / signed authorization
  if (isStellarNetwork(payload.network)) {
    const authEntry = p.authEntry as Record<string, unknown> | undefined;
    const signature = (authEntry?.signature || p.transaction || JSON.stringify(p)) as string;
    return crypto
      .createHash('sha256')
      .update(typeof signature === 'string' ? signature : JSON.stringify(signature))
      .digest('hex');
  }

  // AVM: hash the payment group
  const group = p.paymentGroup as string[];
  return crypto.createHash('sha256').update(group.join('|')).digest('hex');
};
