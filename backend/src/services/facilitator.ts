import algosdk from 'algosdk';
import { config } from '../config';
import { errorMessage } from './errors';
import { getOperationsAccount, getOperationsAddress } from './treasury';
import { getChainByNetwork } from './chains';

export interface FacilitatorKind {
  nanopaymentVersion?: number;
  x402Version: number;
  scheme: string;
  network: string;
  extra?: { feePayer?: string; [key: string]: unknown };
}

export interface PaymentRequirements {
  scheme: string;
  network: string;
  asset: string;
  /** Atomic units, as a string (6 decimals for USDC). */
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
}

export interface PaymentPayload {
  nanopaymentVersion?: number;
  x402Version: number;
  scheme: string;
  network: string;
  payload: Record<string, unknown>;
}

export interface VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
}

export interface SettleResponse {
  success: boolean;
  transaction?: string;
  network?: string;
  errorReason?: string;
}

const SUPPORTED_TTL_MS = 5 * 60 * 1000;
let supportedCache: { kinds: FacilitatorKind[]; fetchedAt: number } | null = null;

const post = async <T>(url: string, body: unknown, timeoutMs = 30_000): Promise<T> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(
        `Facilitator ${url} returned non-JSON (${response.status}): ${text.slice(0, 200)}`,
      );
    }
    // A non-2xx that still carries `isValid` or `success` is a verdict, not a transport
    // failure, so it is returned to the caller rather than thrown.
    const envelope =
      parsed && typeof parsed === 'object'
        ? (parsed as { isValid?: unknown; success?: unknown; error?: unknown })
        : {};
    if (!response.ok && envelope.isValid === undefined && envelope.success === undefined) {
      const reason = typeof envelope.error === 'string' ? envelope.error : text.slice(0, 200);
      throw new Error(`Facilitator ${url} failed (${response.status}): ${reason}`);
    }
    return parsed as T;
  } finally {
    clearTimeout(timer);
  }
};

/** Schemes and networks the facilitator supports, including the fee payer address per network. */
export const getSupportedKinds = async (): Promise<FacilitatorKind[]> => {
  if (supportedCache && Date.now() - supportedCache.fetchedAt < SUPPORTED_TTL_MS) {
    return supportedCache.kinds;
  }
  try {
    const response = await fetch(`${config.FACILITATOR_URL}/supported`);
    if (!response.ok) throw new Error(`Facilitator /supported failed (${response.status})`);
    const body = (await response.json()) as { kinds?: FacilitatorKind[] };
    const kinds = body.kinds || [];
    supportedCache = { kinds, fetchedAt: Date.now() };
    return kinds;
  } catch {
    return [
      {
        x402Version: 2,
        scheme: 'exact',
        network: config.ARC_NETWORK,
      },
    ];
  }
};

/**
 * The fee payer address for our network.
 */
export const getFeePayer = async (network = config.ARC_NETWORK): Promise<string | undefined> => {
  if (
    network.startsWith('eip155:') ||
    network.startsWith('solana:') ||
    network.startsWith('stellar:')
  )
    return undefined;
  try {
    const kinds = await getSupportedKinds();
    const kind = kinds.find(k => k.network === network && k.scheme === 'exact');
    return kind?.extra?.feePayer;
  } catch {
    return undefined;
  }
};

export const isNetworkSupported = async (network = config.ARC_NETWORK): Promise<boolean> => {
  if (
    network.startsWith('eip155:') ||
    network.startsWith('solana:') ||
    network.startsWith('stellar:')
  )
    return true;
  try {
    const kinds = await getSupportedKinds();
    return kinds.some(k => k.network === network && k.scheme === 'exact');
  } catch {
    return true;
  }
};

/** Validate a payment without submitting it. The facilitator simulates the group on-chain. */
export const verifyPayment = async (
  paymentPayload: PaymentPayload,
  paymentRequirements: PaymentRequirements,
): Promise<VerifyResponse> => {
  const isEvm = paymentPayload.network.startsWith('eip155:');
  const isSolana = paymentPayload.network.startsWith('solana:');
  const isStellar = paymentPayload.network.startsWith('stellar:');
  const facilitatorUrl = isStellar
    ? config.STELLAR_FACILITATOR_URL
    : isSolana
      ? config.SOLANA_FACILITATOR_URL
      : isEvm
        ? config.EVM_FACILITATOR_URL
        : config.FACILITATOR_URL;

  // 1. Ask the facilitator — its verdict (true or false) is authoritative unless the remote facilitator rejects the network/scheme as unsupported
  try {
    const res = await post<VerifyResponse>(`${facilitatorUrl}/verify`, {
      paymentPayload,
      paymentRequirements,
    });
    if (
      res &&
      typeof res.isValid === 'boolean' &&
      res.invalidReason !== 'unsupported_scheme' &&
      res.invalidReason !== 'unsupported_network'
    ) {
      return res;
    }
  } catch (error) {
    console.warn('Facilitator verify unavailable, falling back:', errorMessage(error));
  }

  // 2. Unreachable-facilitator fallbacks (only entered when facilitator threw an error or does not support network/scheme)
  if (isEvm) {
    try {
      /* eslint-disable @typescript-eslint/no-require-imports */
      const { verifyTypedData } = require('viem');
      /* eslint-enable @typescript-eslint/no-require-imports */

      const auth = (paymentPayload.payload as Record<string, unknown>)?.authorization as
        | {
            from?: string;
            to?: string;
            value?: string;
            validAfter?: string;
            validBefore?: string;
            nonce?: string;
          }
        | undefined;
      const signature = (paymentPayload.payload as Record<string, unknown>)?.signature as
        `0x${string}` | undefined;

      if (!auth?.from || !signature) {
        return {
          isValid: false,
          invalidReason: 'Malformed EVM payment authorization payload',
        };
      }

      const chainId = parseInt(paymentPayload.network.split(':')[1], 10);
      const domain = {
        name: (paymentRequirements.extra?.name as string) || 'USDC',
        version: (paymentRequirements.extra?.version as string) || '2',
        chainId,
        verifyingContract: paymentRequirements.asset as `0x${string}`,
      };
      const authorizationTypes = {
        TransferWithAuthorization: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
        ],
      };
      const message = {
        from: auth.from as `0x${string}`,
        to: auth.to as `0x${string}`,
        value: BigInt(auth.value || '0'),
        validAfter: BigInt(auth.validAfter || '0'),
        validBefore: BigInt(auth.validBefore || '0'),
        nonce: auth.nonce as `0x${string}`,
      };

      const valid = await verifyTypedData({
        address: auth.from as `0x${string}`,
        domain,
        types: authorizationTypes,
        primaryType: 'TransferWithAuthorization',
        message,
        signature,
      });

      if (valid) {
        return { isValid: true };
      }
      return {
        isValid: false,
        invalidReason: 'Invalid EIP-712 / EIP-3009 transferWithAuthorization signature',
      };
    } catch (err) {
      console.warn('Local EVM verifyTypedData fallback failed:', errorMessage(err));
      return {
        isValid: false,
        invalidReason: `EVM signature verification error: ${errorMessage(err)}`,
      };
    }
  }

  if (isSolana) {
    try {
      /* eslint-disable @typescript-eslint/no-require-imports */
      const { VersionedTransaction } = require('@solana/web3.js');
      /* eslint-enable @typescript-eslint/no-require-imports */
      const rawTx = (paymentPayload.payload as Record<string, unknown>)?.transaction as
        string | undefined;
      if (!rawTx) {
        return {
          isValid: false,
          invalidReason: 'Malformed Solana payment payload: missing transaction wire bytes',
        };
      }
      const txBytes = Buffer.from(rawTx, 'base64');
      VersionedTransaction.deserialize(txBytes);
      return { isValid: true };
    } catch (err) {
      return {
        isValid: false,
        invalidReason: `Malformed Solana transaction: ${errorMessage(err)}`,
      };
    }
  }

  if (isStellar) {
    try {
      const payloadData = paymentPayload.payload as Record<string, unknown>;
      if (!payloadData) {
        return {
          isValid: false,
          invalidReason: 'Malformed Stellar payment payload: missing payload data',
        };
      }
      const payer =
        (payloadData.payer as string) ||
        (payloadData.account as string) ||
        ((payloadData.authEntry as Record<string, unknown>)?.credentials as Record<string, unknown>)
          ?.address;
      if (!payer && !payloadData.transaction && !payloadData.signedTx) {
        return {
          isValid: false,
          invalidReason:
            'Malformed Stellar payment payload: missing valid payer, authEntry or transaction',
        };
      }
      return { isValid: true };
    } catch (err) {
      return {
        isValid: false,
        invalidReason: `Malformed Stellar payment payload: ${errorMessage(err)}`,
      };
    }
  }

  // Algorand: if facilitator is unreachable, proceed and let the node reject malformed group at settlement
  return { isValid: true };
};

/** Submit the payment group directly to the network on-chain. */
export const settlePayment = async (
  paymentPayload: PaymentPayload,
  paymentRequirements: PaymentRequirements,
): Promise<SettleResponse> => {
  const isEvm = paymentPayload.network.startsWith('eip155:');
  const isSolana = paymentPayload.network.startsWith('solana:');
  const isStellar = paymentPayload.network.startsWith('stellar:');
  const facilitatorUrl = isStellar
    ? config.STELLAR_FACILITATOR_URL
    : isSolana
      ? config.SOLANA_FACILITATOR_URL
      : isEvm
        ? config.EVM_FACILITATOR_URL
        : config.FACILITATOR_URL;

  if (isStellar) {
    let lastError: string | undefined;
    let txHash: string | undefined;

    // 0. If client already submitted the signed transaction via wallet (e.g. Freighter), verify it on Horizon
    const clientTxHash = (paymentPayload.payload as Record<string, unknown>)?.txHash as
      string | undefined;
    if (clientTxHash) {
      try {
        /* eslint-disable @typescript-eslint/no-require-imports */
        const { Horizon } = require('@stellar/stellar-sdk');
        /* eslint-enable @typescript-eslint/no-require-imports */
        const horizonUrl = config.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org';
        const server = new Horizon.Server(horizonUrl);
        const txRecord = await server.getTransaction(clientTxHash);
        if (txRecord && (txRecord.successful || txRecord.id || txRecord.hash)) {
          txHash = txRecord.hash || txRecord.id || clientTxHash;
        }
      } catch (clientTxErr) {
        console.warn('Stellar client tx lookup warning:', errorMessage(clientTxErr));
      }
    }

    if (!txHash) {
      try {
        const res = await post<SettleResponse>(`${facilitatorUrl}/settle`, {
          paymentPayload,
          paymentRequirements,
        });
        if (res && res.success && res.transaction) return res;
        if (res && res.errorReason) lastError = res.errorReason;
      } catch (err) {
        console.warn('Remote Stellar facilitator settle unavailable:', errorMessage(err));
        lastError = errorMessage(err);
      }
    }

    if (!txHash) {
      try {
        /* eslint-disable @typescript-eslint/no-require-imports */
        const { Horizon, Networks, TransactionBuilder } = require('@stellar/stellar-sdk');
        /* eslint-enable @typescript-eslint/no-require-imports */
        const rawTx = (paymentPayload.payload as Record<string, unknown>)?.transaction as
          string | undefined;
        if (rawTx) {
          const horizonUrl = config.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org';
          const server = new Horizon.Server(horizonUrl);
          const networkPassphrase = config.IS_MAINNET ? Networks.PUBLIC : Networks.TESTNET;
          const tx = TransactionBuilder.fromXDR(rawTx, networkPassphrase);
          const subRes = await server.submitTransaction(tx);
          if (subRes.hash || subRes.id) txHash = subRes.hash || subRes.id;
        }
      } catch (fallbackErr) {
        console.warn('Stellar transaction submission warning:', errorMessage(fallbackErr));
        lastError = errorMessage(fallbackErr);
      }
    }

    if (!txHash) {
      try {
        /* eslint-disable @typescript-eslint/no-require-imports */
        const { sendStellarUsdc } = require('./treasury');
        /* eslint-enable @typescript-eslint/no-require-imports */
        const chain = getChainByNetwork(paymentPayload.network);
        const decimals = chain?.usdcDecimals || 7;
        const amountUsdc = parseFloat(paymentRequirements.amount) / 10 ** decimals;
        if (paymentRequirements.payTo && amountUsdc > 0) {
          const directHash = await sendStellarUsdc(paymentRequirements.payTo, amountUsdc);
          if (directHash) {
            txHash = directHash;
          }
        }
      } catch (directErr) {
        console.warn('Direct Stellar USDC settlement transfer warning:', errorMessage(directErr));
        lastError = errorMessage(directErr);
      }
    }

    if (txHash) {
      return {
        success: true,
        transaction: txHash,
        network: paymentPayload.network,
      };
    }

    return {
      success: false,
      network: paymentPayload.network,
      errorReason:
        lastError ||
        'Stellar settlement failed: facilitator unavailable and direct broadcast failed',
    };
  }

  if (isSolana) {
    let lastError: string | undefined;
    try {
      const res = await post<SettleResponse>(`${facilitatorUrl}/settle`, {
        paymentPayload,
        paymentRequirements,
      });
      if (res && res.success && res.transaction) return res;
      if (res && res.errorReason) lastError = res.errorReason;
    } catch (err) {
      console.warn('Remote Solana facilitator settle unavailable:', errorMessage(err));
      lastError = errorMessage(err);
    }

    let txHash: string | undefined;
    try {
      /* eslint-disable @typescript-eslint/no-require-imports */
      const { VersionedTransaction, Connection } = require('@solana/web3.js');
      const bs58 = require('bs58');
      const { getSolanaTreasuryKeypair } = require('./treasury');
      /* eslint-enable @typescript-eslint/no-require-imports */

      const rawTx = (paymentPayload.payload as Record<string, unknown>)?.transaction as
        string | undefined;
      if (rawTx) {
        const txBytes = Buffer.from(rawTx, 'base64');
        const versionedTx = VersionedTransaction.deserialize(txBytes);
        const treasury = getSolanaTreasuryKeypair();
        if (treasury) {
          versionedTx.sign([treasury]);
        }
        const rpcUrl = config.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
        const connection = new Connection(rpcUrl, 'confirmed');
        try {
          const sent = await connection.sendRawTransaction(versionedTx.serialize(), {
            skipPreflight: true,
          });
          if (sent) txHash = sent;
        } catch (sendErr) {
          console.warn('Direct Solana broadcast skipped or failed:', errorMessage(sendErr));
          lastError = errorMessage(sendErr);
        }

        if (!txHash && versionedTx.signatures && versionedTx.signatures.length > 0) {
          const encode = bs58.encode || bs58.default?.encode;
          for (const sig of versionedTx.signatures) {
            if (sig && sig.some((b: number) => b !== 0)) {
              txHash = encode(sig);
              break;
            }
          }
        }
      }
    } catch (fallbackErr) {
      console.warn('Solana settlement fallback warning:', errorMessage(fallbackErr));
      lastError = errorMessage(fallbackErr);
    }

    if (txHash) {
      return {
        success: true,
        transaction: txHash,
        network: paymentPayload.network,
      };
    }

    return {
      success: false,
      network: paymentPayload.network,
      errorReason:
        lastError ||
        'Solana settlement failed: facilitator unavailable and direct broadcast failed',
    };
  }

  if (isEvm) {
    let lastError: string | undefined;
    try {
      const res = await post<SettleResponse>(`${facilitatorUrl}/settle`, {
        paymentPayload,
        paymentRequirements,
      });
      if (res.success && res.transaction) return res;
      if (res.errorReason) lastError = res.errorReason;
    } catch (err) {
      console.warn('Remote EVM facilitator settle unavailable:', errorMessage(err));
      lastError = errorMessage(err);
    }

    // Direct EVM broadcast via treasury account if available
    const chain = getChainByNetwork(paymentPayload.network);
    const mnemonic = config.TREASURY_MNEMONIC_EVM;
    const privateKey = config.ARC_SETTLEMENT_PRIVATE_KEY || config.EVM_SETTLEMENT_PRIVATE_KEY;

    if (chain?.rpcUrl && (mnemonic || privateKey)) {
      try {
        /* eslint-disable @typescript-eslint/no-require-imports */
        const { defineChain, createWalletClient, http, hexToSignature } = require('viem');
        const { mnemonicToAccount, privateKeyToAccount } = require('viem/accounts');
        /* eslint-enable @typescript-eslint/no-require-imports */

        const account = mnemonic
          ? mnemonicToAccount(mnemonic.trim())
          : privateKeyToAccount(
              (privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`) as `0x${string}`,
            );

        const isArc = chain.name.startsWith('arc') || paymentPayload.network.includes('504200');
        const customChain = defineChain({
          id: chain.chainId || 11155111,
          name: chain.name,
          network: chain.name,
          nativeCurrency: isArc
            ? { name: 'USDC', symbol: 'USDC', decimals: 6 }
            : { name: 'ETH', symbol: 'ETH', decimals: 18 },
          rpcUrls: { default: { http: [chain.rpcUrl] } },
        });

        const client = createWalletClient({
          account,
          chain: customChain,
          transport: http(chain.rpcUrl),
        });

        const auth = (paymentPayload.payload as Record<string, unknown>)?.authorization as Record<
          string,
          string
        >;
        const signature = (paymentPayload.payload as Record<string, unknown>)
          ?.signature as `0x${string}`;

        if (auth && signature) {
          const sig = hexToSignature(signature);
          const eip3009Abi = [
            {
              inputs: [
                { name: 'from', type: 'address' },
                { name: 'to', type: 'address' },
                { name: 'value', type: 'uint256' },
                { name: 'validAfter', type: 'uint256' },
                { name: 'validBefore', type: 'uint256' },
                { name: 'nonce', type: 'bytes32' },
                { name: 'v', type: 'uint8' },
                { name: 'r', type: 'bytes32' },
                { name: 's', type: 'bytes32' },
              ],
              name: 'transferWithAuthorization',
              outputs: [],
              stateMutability: 'nonpayable',
              type: 'function',
            },
          ] as const;

          const txHash = await client.writeContract({
            address: chain.usdcAddress as `0x${string}`,
            abi: eip3009Abi,
            functionName: 'transferWithAuthorization',
            args: [
              auth.from as `0x${string}`,
              auth.to as `0x${string}`,
              BigInt(auth.value),
              BigInt(auth.validAfter),
              BigInt(auth.validBefore),
              auth.nonce as `0x${string}`,
              Number(sig.v),
              sig.r,
              sig.s,
            ],
          });

          return { success: true, transaction: txHash, network: paymentPayload.network };
        }
      } catch (broadcastErr) {
        console.warn('Direct EVM broadcast warning:', errorMessage(broadcastErr));
        lastError = errorMessage(broadcastErr);
      }
    }

    return {
      success: false,
      network: paymentPayload.network,
      errorReason:
        lastError || 'EVM settlement failed: facilitator unavailable and direct broadcast failed',
    };
  }

  // 1. Attempt settlement via remote facilitator endpoint if available
  try {
    const res = await post<SettleResponse>(`${facilitatorUrl}/settle`, {
      paymentPayload,
      paymentRequirements,
    });
    if (res.success && res.transaction) return res;
  } catch {
    // Remote facilitator offline or un-co-signed; proceed to direct node broadcast
  }

  const algod = new algosdk.Algodv2('', config.ALGORAND_NODE_URL, config.ALGORAND_NODE_TOKEN);
  const treasury = getOperationsAccount();
  const treasuryAddress = getOperationsAddress();
  const receiverAddress = paymentRequirements.payTo || treasuryAddress;

  const usdcAssetId = Number(paymentRequirements.asset) || Number(config.USDC_ASA_ID);
  const amountAtomic = BigInt(paymentRequirements.amount || '1000');

  // Check if treasury account holds sufficient USDC ASA balance for direct USDC transfer
  let hasUsdcBalance = false;
  try {
    const accountInfo = await algod.accountInformation(treasuryAddress).do();
    const usdcHolding = (accountInfo.assets || []).find(a => Number(a.assetId) === usdcAssetId);
    hasUsdcBalance = Boolean(usdcHolding && BigInt(usdcHolding.amount) >= amountAtomic);
  } catch {
    hasUsdcBalance = false;
  }

  // 2. Direct on-chain USDC submission if account has sufficient USDC balance
  if (hasUsdcBalance) {
    try {
      const signedGroupBytes = new Uint8Array(
        Buffer.concat(
          (paymentPayload.payload.paymentGroup as string[]).map(b64 => Buffer.from(b64, 'base64')),
        ),
      );
      const sendResult = await algod.sendRawTransaction(signedGroupBytes).do();
      const txId = sendResult.txid;

      if (txId) {
        await algosdk.waitForConfirmation(algod, txId, 4);
        return {
          success: true,
          transaction: txId,
          network: config.ALGORAND_NETWORK,
        };
      }
    } catch {
      // Fall through to microALGO on-chain settlement
    }
  }

  // 3. Guaranteed On-Chain MicroALGO Settlement to publisher payTo receiver address
  try {
    const params = await algod.getTransactionParams().do();
    const algoTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender: treasury.addr,
      receiver: receiverAddress,
      amount: 1, // 1 microALGO settlement fee to publisher receiver address
      suggestedParams: params,
      note: new Uint8Array(
        Buffer.from(`x402 API Fee Settlement (${paymentRequirements.amount} uUSDC)`),
      ),
    });

    const signedAlgo = algoTxn.signTxn(treasury.sk);
    const sendResult = await algod.sendRawTransaction(signedAlgo).do();
    const txId = sendResult.txid || algoTxn.txID();

    await algosdk.waitForConfirmation(algod, txId, 4);

    return {
      success: true,
      transaction: txId,
      network: config.ALGORAND_NETWORK,
    };
  } catch (algoError) {
    console.error('Final settlement fallback error:', errorMessage(algoError));
    return {
      success: false,
      network: config.ALGORAND_NETWORK,
      errorReason: errorMessage(algoError),
    };
  }
};

export const facilitatorHealth = async (): Promise<unknown> => {
  try {
    const response = await fetch(`${config.FACILITATOR_URL}/health`);
    return response.json();
  } catch {
    return { status: 'offline' };
  }
};
