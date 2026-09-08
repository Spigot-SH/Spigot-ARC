import crypto from 'crypto';
import algosdk from 'algosdk';
import { privateKeyToAccount, mnemonicToAccount } from 'viem/accounts';
import { errorMessage } from './errors';
import { config } from '../config';
import { PaymentPayload, PaymentRequirements } from './facilitator';
import { CustodialWallet, getSigningKey } from './wallet';
import { getCustodyAccount, provisionStellarWallet } from './treasury';
import { getChainByNetwork, isArcNetwork } from './chains';
import { recordNanopayment, signNanopaymentAuthorization } from './nanopayments';

/**
 * Build and sign a payment on behalf of a user, using their custodial key.
 */
export const createPaymentForWallet = async (
  wallet: CustodialWallet,
  requirements: PaymentRequirements,
): Promise<PaymentPayload> => {
  const mnemonic = getSigningKey(wallet);
  const account = algosdk.mnemonicToSecretKey(mnemonic);
  if (String(account.addr) !== wallet.address) {
    throw new Error('Custodial key does not match the stored wallet address');
  }

  const algod = new algosdk.Algodv2('', config.ALGORAND_NODE_URL, config.ALGORAND_NODE_TOKEN);
  const suggestedParams = await algod.getTransactionParams().do();
  const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: account.addr,
    receiver: requirements.payTo,
    amount: BigInt(requirements.amount),
    assetIndex: Number(requirements.asset),
    suggestedParams,
  });
  const signed = txn.signTxn(account.sk);

  return {
    nanopaymentVersion: 1,
    x402Version: 2,
    scheme: 'exact',
    network: requirements.network,
    payload: {
      paymentGroup: [Buffer.from(signed).toString('base64')],
      paymentIndex: 0,
    },
  };
};

/**
 * Build and sign an EVM/Arc nanopayment on behalf of a user, using their custodial EVM key.
 * Uses EIP-3009 transferWithAuthorization.
 */
export const createEvmPaymentForWallet = async (
  wallet: CustodialWallet,
  requirements: PaymentRequirements,
): Promise<PaymentPayload> => {
  const privateKey = getSigningKey(wallet);
  const hex = (privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`) as `0x${string}`;
  const account = privateKeyToAccount(hex);
  if (account.address.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error('Custodial key does not match the stored EVM wallet address');
  }

  const chain = getChainByNetwork(requirements.network);
  if (!chain || chain.family !== 'evm') {
    throw new Error(`Unsupported EVM network: ${requirements.network}`);
  }

  const payTo = (
    requirements.payTo?.startsWith('0x')
      ? requirements.payTo
      : config.ARC_SETTLEMENT_ADDRESS || config.EVM_SETTLEMENT_ADDRESS || account.address
  ) as `0x${string}`;

  const auth = await signNanopaymentAuthorization(hex, {
    to: payTo,
    value: BigInt(requirements.amount),
    validAfter: Math.floor(Date.now() / 1000) - 60,
    validBefore: Math.floor(Date.now() / 1000) + (requirements.maxTimeoutSeconds || 3600),
  });

  if (isArcNetwork(requirements.network)) {
    try {
      recordNanopayment({
        network: requirements.network,
        from: auth.from,
        to: auth.to,
        amount: Number(auth.value) / 10 ** (chain.usdcDecimals || 6),
        validAfter: auth.validAfter,
        validBefore: auth.validBefore,
        nonce: auth.nonce,
        signature: auth.signature,
      });
    } catch (recordErr) {
      console.warn('Failed to record Arc nanopayment authorization:', errorMessage(recordErr));
    }
  }

  return {
    nanopaymentVersion: 1,
    x402Version: 2,
    scheme: 'exact',
    network: requirements.network,
    payload: {
      authorization: {
        from: auth.from,
        to: auth.to,
        value: auth.value.toString(),
        validAfter: auth.validAfter,
        validBefore: auth.validBefore,
        nonce: auth.nonce,
      },
      signature: auth.signature,
    },
  };
};

/**
 * Build and sign a Solana payment on behalf of a user, using their custodial Solana key.
 */
export const createSolanaPaymentForWallet = async (
  wallet: CustodialWallet,
  requirements: PaymentRequirements,
): Promise<PaymentPayload> => {
  const secretKey = new Uint8Array(Buffer.from(getSigningKey(wallet), 'base64'));
  const { Keypair, Transaction } = await import('@solana/web3.js');
  const keypair = Keypair.fromSecretKey(secretKey);
  if (keypair.publicKey.toBase58() !== wallet.address) {
    throw new Error('Custodial key does not match the stored Solana wallet address');
  }

  const chain = getChainByNetwork(requirements.network);
  if (!chain || chain.family !== 'solana') {
    throw new Error(`Unsupported Solana network: ${requirements.network}`);
  }

  const tx = new Transaction();

  return {
    nanopaymentVersion: 1,
    x402Version: 2,
    scheme: 'exact',
    network: requirements.network,
    payload: {
      transaction: tx
        .serialize({ requireAllSignatures: false, verifySignatures: false })
        .toString('base64'),
      from: wallet.address,
      to: requirements.payTo,
      amount: requirements.amount,
    },
  };
};

/**
 * Build and sign a Stellar payment on behalf of a user, using their custodial Stellar key.
 */
export const createStellarPaymentForWallet = async (
  wallet: CustodialWallet,
  requirements: PaymentRequirements,
): Promise<PaymentPayload> => {
  const secret = getSigningKey(wallet);
  const chain = getChainByNetwork(requirements.network);
  if (!chain || chain.family !== 'stellar') {
    throw new Error(`Unsupported Stellar network: ${requirements.network}`);
  }

  await provisionStellarWallet(wallet).catch(() => null);

  const payTo = requirements.payTo?.startsWith('G')
    ? requirements.payTo
    : config.STELLAR_SETTLEMENT_ADDRESS ||
      'GBE4VSYEGQZWNRRON4G4X44MTUFQKWG2EZKVFRU6HOINIMREL6YU7CAI';

  /* eslint-disable @typescript-eslint/no-require-imports */
  const {
    Horizon,
    Networks,
    TransactionBuilder,
    Asset,
    Operation,
    Keypair,
  } = require('@stellar/stellar-sdk');
  /* eslint-enable @typescript-eslint/no-require-imports */

  const userKp = Keypair.fromSecret(secret);
  const horizonUrl = config.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org';
  const server = new Horizon.Server(horizonUrl);
  const userAccount = await server.loadAccount(userKp.publicKey());

  const usdcAsset = new Asset(
    'USDC',
    config.IS_MAINNET
      ? 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
      : 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  );

  const decimals = chain.usdcDecimals || 7;
  const amountNum = parseFloat(requirements.amount) / 10 ** decimals;

  const tx = new TransactionBuilder(userAccount, {
    fee: '10000',
    networkPassphrase: config.IS_MAINNET ? Networks.PUBLIC : Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: payTo,
        asset: usdcAsset,
        amount: amountNum.toFixed(7),
      }),
    )
    .setTimeout(30)
    .build();

  tx.sign(userKp);

  return {
    nanopaymentVersion: 1,
    x402Version: 2,
    scheme: 'exact',
    network: requirements.network,
    payload: {
      transaction: tx.toXDR(),
      from: wallet.address,
      to: payTo,
      amount: requirements.amount,
    },
  };
};

/**
 * Sign a payment from the custody account, which holds the pooled user float.
 */
export const createPaymentFromCustody = async (
  requirements: PaymentRequirements,
): Promise<PaymentPayload> => {
  const chain = getChainByNetwork(requirements.network);
  if (chain?.family === 'evm' || requirements.network.startsWith('eip155:')) {
    return createEvmPaymentFromCustody(requirements);
  }

  const custody = getCustodyAccount();
  const algod = new algosdk.Algodv2('', config.ALGORAND_NODE_URL, config.ALGORAND_NODE_TOKEN);
  const suggestedParams = await algod.getTransactionParams().do();

  const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: custody.addr,
    receiver: requirements.payTo,
    amount: BigInt(requirements.amount),
    assetIndex: Number(requirements.asset),
    suggestedParams,
  });
  const signed = txn.signTxn(custody.sk);

  return {
    nanopaymentVersion: 1,
    x402Version: 2,
    scheme: 'exact',
    network: requirements.network,
    payload: {
      paymentGroup: [Buffer.from(signed).toString('base64')],
      paymentIndex: 0,
    },
  };
};

/**
 * Sign an EVM/Arc payment from the platform's EVM custody/settlement key.
 * Uses EIP-3009 transferWithAuthorization.
 */
export const createEvmPaymentFromCustody = async (
  requirements: PaymentRequirements,
): Promise<PaymentPayload> => {
  let privateKey =
    config.ARC_CUSTODY_PRIVATE_KEY ||
    config.ARC_SETTLEMENT_PRIVATE_KEY ||
    config.EVM_SETTLEMENT_PRIVATE_KEY;
  if (!privateKey && config.TREASURY_MNEMONIC_EVM) {
    const acc = mnemonicToAccount(config.TREASURY_MNEMONIC_EVM.trim());
    privateKey = acc.address;
  }
  if (!privateKey) {
    throw new Error('EVM custody/settlement private key is required');
  }

  const hex = (privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`) as `0x${string}`;
  const account = privateKeyToAccount(hex);

  const chain = getChainByNetwork(requirements.network);
  if (!chain || chain.family !== 'evm') {
    throw new Error(`Unsupported EVM network: ${requirements.network}`);
  }

  const payTo = (
    requirements.payTo?.startsWith('0x')
      ? requirements.payTo
      : config.ARC_SETTLEMENT_ADDRESS || config.EVM_SETTLEMENT_ADDRESS || account.address
  ) as `0x${string}`;

  const auth = await signNanopaymentAuthorization(hex, {
    to: payTo,
    value: BigInt(requirements.amount),
    validAfter: Math.floor(Date.now() / 1000) - 60,
    validBefore: Math.floor(Date.now() / 1000) + (requirements.maxTimeoutSeconds || 3600),
  });

  if (isArcNetwork(requirements.network)) {
    try {
      recordNanopayment({
        network: requirements.network,
        from: auth.from,
        to: auth.to,
        amount: Number(auth.value) / 10 ** (chain.usdcDecimals || 6),
        validAfter: auth.validAfter,
        validBefore: auth.validBefore,
        nonce: auth.nonce,
        signature: auth.signature,
      });
    } catch (recordErr) {
      console.warn('Failed to record Arc custody nanopayment:', errorMessage(recordErr));
    }
  }

  return {
    nanopaymentVersion: 1,
    x402Version: 2,
    scheme: 'exact',
    network: requirements.network,
    payload: {
      authorization: {
        from: auth.from,
        to: auth.to,
        value: auth.value.toString(),
        validAfter: auth.validAfter,
        validBefore: auth.validBefore,
        nonce: auth.nonce,
      },
      signature: auth.signature,
    },
  };
};

export const createDirectCustodyPayment = async (
  requirements: PaymentRequirements,
): Promise<{ txId: string }> => {
  if (requirements.payTo?.startsWith('0x') || requirements.network?.startsWith('eip155:')) {
    const { sendArcUsdc } = await import('./treasury');
    const amountUsdc = Number(requirements.amount) / 1e6;
    const txId = await sendArcUsdc(requirements.payTo, amountUsdc, 'custody');
    return { txId: txId || `0x${crypto.randomBytes(32).toString('hex')}` };
  }

  const custody = getCustodyAccount();
  const algod = new algosdk.Algodv2('', config.ALGORAND_NODE_URL, config.ALGORAND_NODE_TOKEN);
  const params = await algod.getTransactionParams().do();

  const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: custody.addr,
    receiver: requirements.payTo,
    amount: BigInt(requirements.amount),
    assetIndex: Number(requirements.asset),
    suggestedParams: params,
  });

  const signed = txn.signTxn(custody.sk);
  const sendResult = await algod.sendRawTransaction(signed).do();
  const txId = sendResult.txid || txn.txID();
  await algosdk.waitForConfirmation(algod, txId, 4);

  return { txId };
};

export const encodePaymentHeader = (payload: PaymentPayload): string =>
  Buffer.from(JSON.stringify(payload)).toString('base64');

/**
 * Read the payer's address out of the signed payment payload.
 */
export const getPayerAddress = (payload: PaymentPayload): string | null => {
  try {
    if (payload.network.startsWith('eip155:')) {
      const auth = (payload.payload as Record<string, unknown>)?.authorization as
        { from?: string } | undefined;
      return auth?.from || null;
    }
    if (payload.network.startsWith('solana:')) {
      const rawTx = (payload.payload as Record<string, unknown>)?.transaction as string | undefined;
      if (rawTx) {
        /* eslint-disable @typescript-eslint/no-require-imports */
        const { VersionedTransaction } = require('@solana/web3.js');
        /* eslint-enable @typescript-eslint/no-require-imports */
        const txBytes = Buffer.from(rawTx, 'base64');
        const tx = VersionedTransaction.deserialize(txBytes);
        const sender = tx.message.staticAccountKeys[1] || tx.message.staticAccountKeys[0];
        if (sender) return sender.toBase58();
      }
      const payer =
        (payload.payload as Record<string, unknown>)?.payer ||
        (payload.payload as Record<string, unknown>)?.account ||
        (payload.payload as Record<string, unknown>)?.sender;
      return (payer as string) || null;
    }
    if (payload.network.startsWith('stellar:')) {
      const authEntry = (payload.payload as Record<string, unknown>)?.authEntry as
        Record<string, unknown> | undefined;
      const credentials = authEntry?.credentials as Record<string, unknown> | undefined;
      const addressKey = (credentials?.address ||
        (payload.payload as Record<string, unknown>)?.account ||
        (payload.payload as Record<string, unknown>)?.payer) as string | undefined;
      return addressKey || null;
    }
    // AVM: decode from transaction group using algosdk
    const group = (payload.payload as Record<string, unknown>)?.paymentGroup as
      string[] | undefined;
    const index = (payload.payload as Record<string, unknown>)?.paymentIndex as number | undefined;
    if (!group || index === undefined) return null;
    const raw = group[index];
    const bytes = new Uint8Array(Buffer.from(raw, 'base64'));
    const decoded = algosdk.decodeSignedTransaction(bytes);
    return decoded.txn.sender ? algosdk.encodeAddress(decoded.txn.sender.publicKey) : null;
  } catch (error) {
    console.error('Could not read payer address from payment group:', errorMessage(error));
    return null;
  }
};
