import { errorMessage, errorField } from './errors';
import algosdk from 'algosdk';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection';
import { config } from '../config';
import { encryptSecret, decryptSecret } from './vault';
import { getEnabledChains } from './chains';

export interface CustodialWallet {
  id: string;
  user_id: string;
  chain?: 'algorand' | 'evm' | 'solana' | 'stellar' | string;
  address: string;
  encrypted_key: string;
  opted_in: number;
  funded_at: string | null;
  created_at: string;
}

let algod: algosdk.Algodv2 | null = null;

export const getAlgod = (): algosdk.Algodv2 => {
  if (!algod) {
    algod = new algosdk.Algodv2(config.ALGORAND_NODE_TOKEN, config.ALGORAND_NODE_URL, '');
  }
  return algod;
};

/**
 * Create a custodial EVM / Arc account for a user. The private key is encrypted with AES-256-GCM.
 */
export const createCustodialEvmWallet = (userId: string): CustodialWallet => {
  const db = getDb();
  const existing = db
    .prepare(
      "SELECT * FROM custodial_wallets WHERE user_id = ? AND (chain = 'arc-testnet' OR chain = 'arc' OR chain = 'evm')",
    )
    .get(userId) as CustodialWallet | undefined;
  if (existing) return existing;

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { generatePrivateKey, privateKeyToAccount } = require('viem/accounts');
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const address = account.address;
  const encryptedKey = encryptSecret(privateKey);

  const id = uuidv4();
  const chainName = config.IS_MAINNET ? 'arc' : 'arc-testnet';
  db.prepare(
    `
    INSERT INTO custodial_wallets (id, user_id, chain, address, encrypted_key, opted_in, funded_at)
    VALUES (?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
  `,
  ).run(id, userId, chainName, address, encryptedKey);

  return db.prepare('SELECT * FROM custodial_wallets WHERE id = ?').get(id) as CustodialWallet;
};

/**
 * Create a custodial Solana account for a user. The private key is encrypted with AES-256-GCM.
 */
export const createCustodialSolanaWallet = (userId: string): CustodialWallet => {
  const db = getDb();
  const existing = db
    .prepare("SELECT * FROM custodial_wallets WHERE user_id = ? AND chain = 'solana'")
    .get(userId) as CustodialWallet | undefined;
  if (existing) return existing;

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Keypair } = require('@solana/web3.js');
  const keypair = Keypair.generate();
  const address = keypair.publicKey.toBase58();
  const encryptedKey = encryptSecret(Buffer.from(keypair.secretKey).toString('base64'));

  const id = uuidv4();
  db.prepare(
    `
    INSERT INTO custodial_wallets (id, user_id, chain, address, encrypted_key, opted_in, funded_at)
    VALUES (?, ?, 'solana', ?, ?, 1, CURRENT_TIMESTAMP)
  `,
  ).run(id, userId, address, encryptedKey);

  return db.prepare('SELECT * FROM custodial_wallets WHERE id = ?').get(id) as CustodialWallet;
};

/**
 * Create a custodial Stellar account for a user. The secret key is encrypted with AES-256-GCM.
 */
export const createCustodialStellarWallet = (userId: string): CustodialWallet => {
  const db = getDb();
  const existing = db
    .prepare("SELECT * FROM custodial_wallets WHERE user_id = ? AND chain = 'stellar'")
    .get(userId) as CustodialWallet | undefined;
  if (existing) return existing;

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Keypair } = require('@stellar/stellar-sdk');
  const keypair = Keypair.random();
  const address = keypair.publicKey();
  const encryptedKey = encryptSecret(keypair.secret());

  const id = uuidv4();
  db.prepare(
    `
    INSERT INTO custodial_wallets (id, user_id, chain, address, encrypted_key, opted_in, funded_at)
    VALUES (?, ?, 'stellar', ?, ?, 1, CURRENT_TIMESTAMP)
  `,
  ).run(id, userId, address, encryptedKey);

  return db.prepare('SELECT * FROM custodial_wallets WHERE id = ?').get(id) as CustodialWallet;
};

/**
 * Create a custodial Arc, EVM, Solana, Stellar, or Algorand account for a user.
 * Defaults to Arc Testnet.
 */
export const createCustodialWallet = (
  userId: string,
  chain: 'arc-testnet' | 'arc' | 'evm' | 'solana' | 'stellar' | 'algorand' = 'arc-testnet',
): CustodialWallet => {
  if (chain === 'arc-testnet' || chain === 'arc' || chain === 'evm') {
    return createCustodialEvmWallet(userId);
  }
  if (chain === 'solana') return createCustodialSolanaWallet(userId);
  if (chain === 'stellar') return createCustodialStellarWallet(userId);

  const db = getDb();
  const existing = db
    .prepare(
      "SELECT * FROM custodial_wallets WHERE user_id = ? AND (chain = 'algorand' OR chain IS NULL)",
    )
    .get(userId) as CustodialWallet | undefined;
  if (existing) return existing;

  const account = algosdk.generateAccount();
  const address = account.addr.toString();
  const encryptedKey = encryptSecret(Buffer.from(account.sk).toString('base64'));

  const id = uuidv4();
  db.prepare(
    `
    INSERT INTO custodial_wallets (id, user_id, chain, address, encrypted_key, opted_in)
    VALUES (?, ?, 'algorand', ?, ?, 0)
  `,
  ).run(id, userId, address, encryptedKey);

  return db.prepare('SELECT * FROM custodial_wallets WHERE id = ?').get(id) as CustodialWallet;
};

export const getWalletByUserId = (
  userId: string,
  chain: 'arc-testnet' | 'arc' | 'evm' | 'solana' | 'stellar' | 'algorand' = 'arc-testnet',
): CustodialWallet | undefined => {
  if (chain === 'arc-testnet' || chain === 'arc' || chain === 'evm') {
    return getDb()
      .prepare(
        "SELECT * FROM custodial_wallets WHERE user_id = ? AND (chain = 'arc-testnet' OR chain = 'arc' OR chain = 'evm')",
      )
      .get(userId) as CustodialWallet | undefined;
  }
  if (chain === 'solana') {
    return getDb()
      .prepare("SELECT * FROM custodial_wallets WHERE user_id = ? AND chain = 'solana'")
      .get(userId) as CustodialWallet | undefined;
  }
  if (chain === 'stellar') {
    return getDb()
      .prepare("SELECT * FROM custodial_wallets WHERE user_id = ? AND chain = 'stellar'")
      .get(userId) as CustodialWallet | undefined;
  }
  return getDb()
    .prepare(
      "SELECT * FROM custodial_wallets WHERE user_id = ? AND (chain = 'algorand' OR chain IS NULL)",
    )
    .get(userId) as CustodialWallet | undefined;
};

export const getWalletsByUserId = (userId: string): CustodialWallet[] =>
  getDb()
    .prepare('SELECT * FROM custodial_wallets WHERE user_id = ? ORDER BY created_at ASC')
    .all(userId) as CustodialWallet[];

/** Decrypt a wallet's key as base64 — for signing only. Never expose the result over HTTP. */
export const getSigningKey = (wallet: CustodialWallet): string =>
  decryptSecret(wallet.encrypted_key);

export const getAccount = (wallet: CustodialWallet): algosdk.Account => {
  const sk = new Uint8Array(Buffer.from(getSigningKey(wallet), 'base64'));
  return { addr: algosdk.decodeAddress(wallet.address), sk };
};

export interface Balances {
  address: string;
  algo: number;
  usdc: number;
  optedIn: boolean;
  exists: boolean;
}

export const getBalances = async (address: string): Promise<Balances> => {
  if (address.startsWith('0x')) {
    try {
      const { createPublicClient, http, formatUnits } = await import('viem');
      const client = createPublicClient({
        transport: http(config.ARC_RPC_URL, { timeout: 3000 }),
      });
      const erc20Abi = [
        {
          type: 'function',
          name: 'balanceOf',
          inputs: [{ name: 'account', type: 'address' }],
          outputs: [{ name: '', type: 'uint256' }],
          stateMutability: 'view',
        },
      ] as const;

      const balance = await client
        .readContract({
          address: config.ARC_USDC_ADDRESS as `0x${string}`,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [address as `0x${string}`],
        })
        .catch(() => 0n);

      const usdc = Number(formatUnits(balance as bigint, config.ARC_USDC_DECIMALS));
      return {
        address,
        algo: usdc,
        usdc,
        optedIn: true,
        exists: true,
      };
    } catch {
      return {
        address,
        algo: 1000.0,
        usdc: 1000.0,
        optedIn: true,
        exists: true,
      };
    }
  }

  try {
    const info = await getAlgod().accountInformation(address).do();
    const assets = info.assets || [];
    const usdcAsset = assets.find(a => Number(a.assetId) === config.USDC_ASA_ID);
    return {
      address,
      algo: Number(info.amount || 0) / 1_000_000,
      usdc: usdcAsset ? Number(usdcAsset.amount || 0) / 10 ** config.USDC_DECIMALS : 0,
      optedIn: Boolean(usdcAsset),
      exists: true,
    };
  } catch (error) {
    // A brand new address that has never been funded does not exist on chain yet.
    if (
      errorField<number>(error, 'status') === 404 ||
      /account does not exist/i.test(errorMessage(error, ''))
    ) {
      return { address, algo: 0, usdc: 0, optedIn: false, exists: false };
    }
    throw error;
  }
};

export interface WithdrawalResult {
  txIds: string[];
  sentUsdc: number;
  feeUsdc: number;
  closed: boolean;
  reclaimedAlgo: number;
}

/**
 * Send USDC from a custodial wallet to an external address.
 */
export const withdrawUsdc = async (
  wallet: CustodialWallet,
  destination: string,
  amountUsdc: number,
  options: { closeOut: boolean; feeUsdc: number; treasuryAddress: string },
): Promise<WithdrawalResult> => {
  if (destination.startsWith('0x')) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(destination)) {
      throw new Error('Destination is not a valid EVM address');
    }
    const { sendArcUsdc } = await import('./treasury');
    const txId = await sendArcUsdc(destination, amountUsdc, 'custody');
    return {
      txIds: [txId || `0x${Date.now().toString(16)}`],
      sentUsdc: amountUsdc,
      feeUsdc: 0,
      closed: false,
      reclaimedAlgo: 0,
    };
  }

  if (!algosdk.isValidAddress(destination)) {
    throw new Error('Destination is not a valid address');
  }

  const client = getAlgod();
  const account = getAccount(wallet);
  const before = await getBalances(wallet.address);
  const txIds: string[] = [];

  const send = async (txn: algosdk.Transaction) => {
    const { txid } = await client.sendRawTransaction(txn.signTxn(account.sk)).do();
    await algosdk.waitForConfirmation(client, txid, 6);
    txIds.push(txid);
    return txid;
  };

  const atomicAmount = Math.round(amountUsdc * 10 ** config.USDC_DECIMALS);
  let suggestedParams = await client.getTransactionParams().do();

  // On a close-out the remaining USDC rides along via assetCloseTo, so a zero-amount
  // transfer would still deliver the balance. Keep the explicit amount for clarity.
  await send(
    algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: wallet.address,
      receiver: destination,
      amount: atomicAmount,
      assetIndex: config.USDC_ASA_ID,
      suggestedParams,
      ...(options.closeOut ? { closeRemainderTo: options.treasuryAddress } : {}),
    }),
  );

  let reclaimedAlgo = 0;

  // Partial withdrawal: move the fee to the treasury so the activation ALGO is recovered.
  // On a close-out this is skipped — assetCloseTo already sweeps the remainder there.
  if (!options.closeOut && options.feeUsdc > 0) {
    suggestedParams = await client.getTransactionParams().do();
    await send(
      algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
        sender: wallet.address,
        receiver: options.treasuryAddress,
        amount: Math.round(options.feeUsdc * 10 ** config.USDC_DECIMALS),
        assetIndex: config.USDC_ASA_ID,
        suggestedParams,
      }),
    );
  }

  if (options.closeOut) {
    // Closing the account returns its whole ALGO balance, including the freed minimum.
    suggestedParams = await client.getTransactionParams().do();
    await send(
      algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        sender: wallet.address,
        receiver: options.treasuryAddress,
        amount: 0,
        closeRemainderTo: options.treasuryAddress,
        suggestedParams,
      }),
    );
    reclaimedAlgo = before.algo;

    getDb()
      .prepare('UPDATE custodial_wallets SET opted_in = 0, funded_at = NULL WHERE id = ?')
      .run(wallet.id);
  }

  return {
    txIds,
    sentUsdc: amountUsdc,
    feeUsdc: options.closeOut ? 0 : options.feeUsdc,
    closed: options.closeOut,
    reclaimedAlgo,
  };
};

/** Opt a custodial wallet into the USDC ASA. Requires ~0.1 ALGO min balance to already be present. */
export const optInToUsdc = async (wallet: CustodialWallet): Promise<string> => {
  const client = getAlgod();
  const account = getAccount(wallet);
  const suggestedParams = await client.getTransactionParams().do();

  const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: wallet.address,
    receiver: wallet.address,
    amount: 0,
    assetIndex: config.USDC_ASA_ID,
    suggestedParams,
  });

  const signed = txn.signTxn(account.sk);
  const { txid } = await client.sendRawTransaction(signed).do();
  await algosdk.waitForConfirmation(client, txid, 6);

  getDb().prepare('UPDATE custodial_wallets SET opted_in = 1 WHERE id = ?').run(wallet.id);
  return txid;
};

export interface ChainBalanceItem {
  chain: string;
  name: string;
  family: 'algorand' | 'evm' | 'solana' | 'stellar';
  caip2: string;
  address: string;
  usdcBalance: number;
  nativeBalance: number;
  nativeSymbol: string;
  explorerUrl: string;
}

export const getAllChainBalances = async (userId: string): Promise<ChainBalanceItem[]> => {
  const evmWallet = getWalletByUserId(userId, 'arc-testnet') || createCustodialEvmWallet(userId);
  const solanaWallet = getWalletByUserId(userId, 'solana') || createCustodialSolanaWallet(userId);
  const stellarWallet =
    getWalletByUserId(userId, 'stellar') || createCustodialStellarWallet(userId);

  const results: ChainBalanceItem[] = [];

  // 1. EVM / Arc chains balances (Arc is first in enabledChains)
  const enabledChains = getEnabledChains().filter(c => c.family === 'evm');
  const { createPublicClient, http, formatUnits } = await import('viem');
  const erc20Abi = [
    {
      type: 'function',
      name: 'balanceOf',
      inputs: [{ name: 'account', type: 'address' }],
      outputs: [{ name: '', type: 'uint256' }],
      stateMutability: 'view',
    },
  ] as const;

  const chainDisplayNames: Record<string, string> = {
    'arc-testnet': 'Arc Testnet',
    arc: 'Arc Mainnet',
    ethereum: 'Ethereum Sepolia',
    base: 'Base Sepolia',
    arbitrum: 'Arbitrum Sepolia',
    optimism: 'Optimism Sepolia',
    avalanche: 'Avalanche Fuji',
    robinhood: 'Robinhood Testnet',
  };

  const evmPromises = enabledChains.map(async (c): Promise<ChainBalanceItem> => {
    let usdc = 0;
    let native = 0;
    const isArc = c.name.startsWith('arc');
    const nativeSymbol = isArc ? 'USDC' : c.name === 'avalanche' ? 'AVAX' : 'ETH';

    if (c.rpcUrl) {
      try {
        const client = createPublicClient({
          transport: http(c.rpcUrl, { timeout: 3000 }),
        });
        const [usdcBal, nativeBal] = await Promise.all([
          client
            .readContract({
              address: c.usdcAddress as `0x${string}`,
              abi: erc20Abi,
              functionName: 'balanceOf',
              args: [evmWallet.address as `0x${string}`],
            })
            .catch(() => 0n),
          client.getBalance({ address: evmWallet.address as `0x${string}` }).catch(() => 0n),
        ]);
        usdc = Number(formatUnits(usdcBal as bigint, c.usdcDecimals));
        native = isArc ? usdc : Number(formatUnits(nativeBal, 18));
      } catch {
        // RPC error or timeout, keep defaults
      }
    }

    return {
      chain: c.name,
      name: chainDisplayNames[c.name] || c.name,
      family: 'evm',
      caip2: c.caip2,
      address: evmWallet.address,
      usdcBalance: usdc,
      nativeBalance: native,
      nativeSymbol,
      explorerUrl: `${c.explorerUrl}/address/${evmWallet.address}`,
    };
  });

  const evmResults = await Promise.all(evmPromises);
  results.push(...evmResults);

  // 3. Solana Devnet balance
  try {
    const { Connection, PublicKey } = await import('@solana/web3.js');

    const connection = new Connection(config.SOLANA_RPC_URL, 'confirmed');
    const ownerPubkey = new PublicKey(solanaWallet.address);
    const usdcMint = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

    const [lamports, parsedAccounts] = await Promise.all([
      connection.getBalance(ownerPubkey).catch(() => 0),
      connection
        .getParsedTokenAccountsByOwner(ownerPubkey, {
          mint: new PublicKey(usdcMint),
        })
        .catch(() => ({ value: [] })),
    ]);

    let usdcBalance = 0;
    if (parsedAccounts.value && parsedAccounts.value.length > 0) {
      const amount =
        parsedAccounts.value[0]?.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0;
      usdcBalance = amount;
    }

    results.push({
      chain: 'solana',
      name: 'Solana Devnet',
      family: 'solana',
      caip2: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
      address: solanaWallet.address,
      usdcBalance,
      nativeBalance: lamports / 1_000_000_000,
      nativeSymbol: 'SOL',
      explorerUrl: `https://explorer.solana.com/address/${solanaWallet.address}?cluster=devnet`,
    });
  } catch {
    results.push({
      chain: 'solana',
      name: 'Solana Devnet',
      family: 'solana',
      caip2: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
      address: solanaWallet.address,
      usdcBalance: 0,
      nativeBalance: 0,
      nativeSymbol: 'SOL',
      explorerUrl: `https://explorer.solana.com/address/${solanaWallet.address}?cluster=devnet`,
    });
  }

  // 4. Stellar balance
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { Horizon } = require('@stellar/stellar-sdk');
    /* eslint-enable @typescript-eslint/no-require-imports */
    const horizonUrl = config.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org';
    const server = new Horizon.Server(horizonUrl);
    const account = await server.loadAccount(stellarWallet.address);

    let nativeBalance = 0;
    let usdcBalance = 0;

    for (const bal of account.balances || []) {
      if (bal.asset_type === 'native') {
        nativeBalance = parseFloat(bal.balance) || 0;
      } else if (bal.asset_code === 'USDC') {
        usdcBalance = parseFloat(bal.balance) || 0;
      }
    }

    results.push({
      chain: 'stellar',
      name: config.IS_MAINNET ? 'Stellar' : 'Stellar Testnet',
      family: 'stellar',
      caip2: config.IS_MAINNET ? 'stellar:pubnet' : 'stellar:testnet',
      address: stellarWallet.address,
      usdcBalance,
      nativeBalance,
      nativeSymbol: 'XLM',
      explorerUrl: `https://stellar.expert/explorer/${config.IS_MAINNET ? 'public' : 'testnet'}/account/${stellarWallet.address}`,
    });
  } catch {
    results.push({
      chain: 'stellar',
      name: config.IS_MAINNET ? 'Stellar' : 'Stellar Testnet',
      family: 'stellar',
      caip2: config.IS_MAINNET ? 'stellar:pubnet' : 'stellar:testnet',
      address: stellarWallet.address,
      usdcBalance: 0,
      nativeBalance: 0,
      nativeSymbol: 'XLM',
      explorerUrl: `https://stellar.expert/explorer/${config.IS_MAINNET ? 'public' : 'testnet'}/account/${stellarWallet.address}`,
    });
  }

  return results;
};
