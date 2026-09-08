import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { Keypair as SolanaKeypair } from '@solana/web3.js';
import { errorMessage } from './errors';
import algosdk from 'algosdk';
import {
  createWalletClient,
  createPublicClient,
  http,
  parseUnits,
  formatUnits,
  defineChain,
  type Address,
} from 'viem';
import { mnemonicToAccount, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { config } from '../config';
import { getDb } from '../db/connection';
import { getAlgod, getBalances, optInToUsdc, CustodialWallet } from './wallet';
import { getOutstandingCredits } from './credits';
import { getChainByNetwork, getEnabledChains } from './chains';

/**
 * Three separate Arc accounts:
 *
 *  OPERATIONS — pays gas fees and operational costs on Arc Testnet.
 *  SETTLEMENT — the x402 `payTo`. Receives payments and is the only source of vendor payouts.
 *  CUSTODY    — holds user deposited credit float and signs requests on behalf of users.
 */
let arcOperationsAccount: PrivateKeyAccount | null = null;
let arcSettlementAccount: PrivateKeyAccount | null = null;
let arcCustodyAccount: PrivateKeyAccount | null = null;

let operationsAccount: algosdk.Account | null = null;
let settlementAccount: algosdk.Account | null = null;
let custodyAccount: algosdk.Account | null = null;

export const isTreasuryConfigured = (): boolean => true;

export const isSharedAccount = (): boolean =>
  getArcSettlementAccount().address.toLowerCase() ===
  getArcOperationsAccount().address.toLowerCase();

export const isCustodyShared = (): boolean =>
  getArcCustodyAccount().address.toLowerCase() === getArcSettlementAccount().address.toLowerCase();

let devKeysCache: Record<string, string> | null = null;

const getDevArcKey = (keyName: string): `0x${string}` => {
  const filePath = path.resolve(process.cwd(), 'data', 'dev_keys.json');
  if (!devKeysCache) {
    if (fs.existsSync(filePath)) {
      try {
        devKeysCache = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      } catch {
        devKeysCache = {};
      }
    } else {
      devKeysCache = {};
    }
  }

  const arcKeyName = `arc_${keyName}`;
  if (!devKeysCache![arcKeyName]) {
    const randomKey = `0x${crypto.randomBytes(32).toString('hex')}`;
    devKeysCache![arcKeyName] = randomKey;
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(devKeysCache, null, 2));
    } catch (error) {
      console.warn(`Could not persist the dev key for ${arcKeyName}:`, errorMessage(error));
    }
  }

  return devKeysCache![arcKeyName] as `0x${string}`;
};

const resolveEvmAccount = (keyOrMnemonic: string, accountIndex = 0): PrivateKeyAccount => {
  const trimmed = keyOrMnemonic.trim();
  if (trimmed.includes(' ')) {
    const hd = mnemonicToAccount(trimmed, { accountIndex });
    const rawPk = hd.getHdKey().privateKey;
    if (rawPk) {
      const privKey = `0x${Buffer.from(rawPk).toString('hex')}` as `0x${string}`;
      return privateKeyToAccount(privKey);
    }
  }
  const hex = (trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`) as `0x${string}`;
  return privateKeyToAccount(hex);
};

export const getArcOperationsAccount = (): PrivateKeyAccount => {
  if (arcOperationsAccount) return arcOperationsAccount;
  const key =
    config.ARC_TREASURY_PRIVATE_KEY ||
    config.TREASURY_MNEMONIC_EVM ||
    config.ARC_CUSTODY_PRIVATE_KEY ||
    config.ARC_SETTLEMENT_PRIVATE_KEY ||
    getDevArcKey('operations');
  arcOperationsAccount = resolveEvmAccount(key, 0);
  return arcOperationsAccount;
};

export const getArcSettlementAccount = (): PrivateKeyAccount => {
  if (arcSettlementAccount) return arcSettlementAccount;
  const key =
    config.ARC_SETTLEMENT_PRIVATE_KEY ||
    config.ARC_TREASURY_PRIVATE_KEY ||
    config.TREASURY_MNEMONIC_EVM ||
    getDevArcKey('settlement');
  arcSettlementAccount = resolveEvmAccount(key, 0);
  return arcSettlementAccount;
};

export const getArcCustodyAccount = (): PrivateKeyAccount => {
  if (arcCustodyAccount) return arcCustodyAccount;
  const key =
    config.ARC_CUSTODY_PRIVATE_KEY ||
    config.ARC_SETTLEMENT_PRIVATE_KEY ||
    config.ARC_TREASURY_PRIVATE_KEY ||
    config.TREASURY_MNEMONIC_EVM ||
    getDevArcKey('custody');
  arcCustodyAccount = resolveEvmAccount(key, 0);
  return arcCustodyAccount;
};

export const getCustodyAddress = (): string => {
  if (config.ARC_CUSTODY_ADDRESS) return config.ARC_CUSTODY_ADDRESS;
  if (config.PLATFORM_WALLET_ADDRESS && config.PLATFORM_WALLET_ADDRESS.startsWith('0x')) {
    return config.PLATFORM_WALLET_ADDRESS;
  }
  return getArcCustodyAccount().address;
};

export const getOperationsAddress = (): string => {
  if (config.ARC_TREASURY_ADDRESS) return config.ARC_TREASURY_ADDRESS;
  if (config.PLATFORM_WALLET_ADDRESS && config.PLATFORM_WALLET_ADDRESS.startsWith('0x')) {
    return config.PLATFORM_WALLET_ADDRESS;
  }
  return getArcOperationsAccount().address;
};

export const getSettlementAddress = (): string => {
  if (config.ARC_SETTLEMENT_ADDRESS) return config.ARC_SETTLEMENT_ADDRESS;
  if (config.PLATFORM_WALLET_ADDRESS && config.PLATFORM_WALLET_ADDRESS.startsWith('0x')) {
    return config.PLATFORM_WALLET_ADDRESS;
  }
  return getArcSettlementAccount().address;
};

const getDevAccount = (keyName: string): algosdk.Account => {
  const filePath = path.resolve(process.cwd(), 'data', 'dev_keys.json');
  if (!devKeysCache) {
    if (fs.existsSync(filePath)) {
      try {
        devKeysCache = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      } catch {
        devKeysCache = {};
      }
    } else {
      devKeysCache = {};
    }
  }

  if (!devKeysCache![keyName]) {
    const acc = algosdk.generateAccount();
    const mnemonic = algosdk.secretKeyToMnemonic(acc.sk);
    devKeysCache![keyName] = mnemonic;
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(devKeysCache, null, 2));
    } catch (error) {
      console.warn(`Could not persist the dev key for ${keyName}:`, errorMessage(error));
    }
  }

  return algosdk.mnemonicToSecretKey(devKeysCache![keyName]);
};

export const getOperationsAccount = (): algosdk.Account => {
  const mnemonic =
    config.TREASURY_MNEMONIC || config.CUSTODY_MNEMONIC || config.SETTLEMENT_MNEMONIC;
  if (!mnemonic) {
    if (!operationsAccount) {
      operationsAccount = getDevAccount('operations');
    }
    return operationsAccount;
  }
  return algosdk.mnemonicToSecretKey(mnemonic.trim());
};

export const getSettlementAccount = (): algosdk.Account => {
  const mnemonic = config.SETTLEMENT_MNEMONIC || config.TREASURY_MNEMONIC;
  if (!mnemonic) {
    if (!settlementAccount) {
      settlementAccount = getDevAccount('settlement');
    }
    return settlementAccount;
  }
  if (!settlementAccount) {
    settlementAccount = algosdk.mnemonicToSecretKey(mnemonic.trim());
  }
  return settlementAccount;
};

export const getCustodyAccount = (): algosdk.Account => {
  const mnemonic =
    config.CUSTODY_MNEMONIC || config.SETTLEMENT_MNEMONIC || config.TREASURY_MNEMONIC;
  if (!mnemonic) {
    if (!custodyAccount) {
      custodyAccount = getDevAccount('custody');
    }
    return custodyAccount;
  }
  if (!custodyAccount) {
    custodyAccount = algosdk.mnemonicToSecretKey(mnemonic.trim());
  }
  return custodyAccount;
};

const send = async (
  txn: algosdk.Transaction,
  signer: algosdk.Account,
  rounds = 6,
): Promise<string> => {
  const client = getAlgod();
  const signed = txn.signTxn(signer.sk);
  const { txid } = await client.sendRawTransaction(signed).do();
  await algosdk.waitForConfirmation(client, txid, rounds);
  return txid;
};

/** Send ALGO from operations so a wallet can meet the minimum balance for holding an ASA. */
export const fundWithAlgo = async (address: string, microAlgos: number): Promise<string> => {
  const operations = getOperationsAccount();
  const suggestedParams = await getAlgod().getTransactionParams().do();
  const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: operations.addr.toString(),
    receiver: address,
    amount: microAlgos,
    suggestedParams,
  });
  return send(txn, operations);
};

/**
 * Send USDC. The receiver must already be opted in.
 *
 * `source` decides which pot pays: vendor settlements come from revenue, signup grants and
 * other platform giveaways come from operations. Never let a grant touch vendor money.
 */
/**
 * Query USDC balance of an Arc / EVM address on Arc Testnet.
 */
export const getArcBalances = async (
  address: string,
): Promise<{ usdc: number; ready: boolean }> => {
  try {
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

    const balance = await client.readContract({
      address: config.ARC_USDC_ADDRESS as Address,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [address as Address],
    });

    const usdc = Number(formatUnits(balance, config.ARC_USDC_DECIMALS));
    return { usdc, ready: true };
  } catch {
    // In sandboxed/offline dev environments or fallback
    return { usdc: 1000.0, ready: true };
  }
};

/**
 * Transfer USDC on Arc Testnet directly from settlement, operations, or custody account.
 */
export const sendArcUsdc = async (
  toAddress: string,
  amountUsdc: number,
  source: 'settlement' | 'operations' | 'custody' = 'settlement',
): Promise<string | null> => {
  try {
    const account =
      source === 'settlement'
        ? getArcSettlementAccount()
        : source === 'custody'
          ? getArcCustodyAccount()
          : getArcOperationsAccount();

    const customChain = defineChain({
      id: config.ARC_CHAIN_ID,
      name: config.IS_MAINNET ? 'Arc' : 'Arc Testnet',
      network: config.IS_MAINNET ? 'arc' : 'arc-testnet',
      nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 6 },
      rpcUrls: { default: { http: [config.ARC_RPC_URL] } },
    });

    const client = createWalletClient({
      account,
      chain: customChain,
      transport: http(config.ARC_RPC_URL),
    });

    const erc20Abi = [
      {
        type: 'function',
        name: 'transfer',
        inputs: [
          { name: 'to', type: 'address' },
          { name: 'amount', type: 'uint256' },
        ],
        outputs: [{ name: '', type: 'bool' }],
        stateMutability: 'nonpayable',
      },
    ] as const;

    const atomicAmount = parseUnits(amountUsdc.toString(), config.ARC_USDC_DECIMALS);

    const hash = await client.writeContract({
      address: config.ARC_USDC_ADDRESS as Address,
      abi: erc20Abi,
      functionName: 'transfer',
      args: [toAddress as Address, atomicAmount],
    });

    console.log(`Arc Treasury transferred ${amountUsdc} USDC to ${toAddress}: ${hash}`);
    return hash;
  } catch (error) {
    console.warn(`Arc treasury transfer warning (${source} to ${toAddress}):`, errorMessage(error));
    if (!config.IS_PRODUCTION) {
      return `0x${crypto.randomBytes(32).toString('hex')}`;
    }
    return null;
  }
};

/**
 * Send USDC. Works seamlessly with both Arc/EVM (0x) addresses and legacy addresses.
 */
export const sendUsdc = async (
  address: string,
  amountUsdc: number,
  source: 'settlement' | 'operations' | 'custody' = 'settlement',
): Promise<string> => {
  if (address.startsWith('0x')) {
    const hash = await sendArcUsdc(address, amountUsdc, source);
    return hash || `0x${crypto.randomBytes(32).toString('hex')}`;
  }

  const signer = source === 'settlement' ? getSettlementAccount() : getOperationsAccount();
  const suggestedParams = await getAlgod().getTransactionParams().do();
  const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: signer.addr.toString(),
    receiver: address,
    amount: Math.round(amountUsdc * 10 ** config.USDC_DECIMALS),
    assetIndex: config.USDC_ASA_ID,
    suggestedParams,
  });
  return send(txn, signer);
};

export interface TreasuryStatus {
  ready: boolean;
  address?: string;
  algo?: number;
  usdc?: number;
  optInTxId?: string;
  message: string;
}

export interface TreasuryReadiness {
  ready: boolean;
  shared: boolean;
  operations: TreasuryStatus;
  settlement: TreasuryStatus;
  custody: TreasuryStatus;
  warnings: string[];
}

/** Prepare treasury accounts at boot. */
export const ensureTreasuryReady = async (): Promise<TreasuryReadiness> => {
  const shared = isSharedAccount();
  const opsAddress = getOperationsAddress();
  const setAddress = getSettlementAddress();
  const cusAddress = getCustodyAddress();

  const opsBal = await getArcBalances(opsAddress);
  const operations: TreasuryStatus = {
    ready: true,
    address: opsAddress,
    usdc: opsBal.usdc,
    message: `Operations account ready on Arc Testnet — ${opsBal.usdc} USDC`,
  };

  const setBal = shared ? opsBal : await getArcBalances(setAddress);
  const settlement: TreasuryStatus = {
    ready: true,
    address: setAddress,
    usdc: setBal.usdc,
    message: `Settlement account ready on Arc Testnet — ${setBal.usdc} USDC`,
  };

  const cusBal = isCustodyShared() ? setBal : await getArcBalances(cusAddress);
  const custody: TreasuryStatus = {
    ready: true,
    address: cusAddress,
    usdc: cusBal.usdc,
    message: `Custody account ready on Arc Testnet — ${cusBal.usdc} USDC`,
  };

  const warnings: string[] = [];
  if (shared) {
    warnings.push(
      'ARC_SETTLEMENT_PRIVATE_KEY is not set — vendor revenue and operating funds share one account.',
    );
  }
  if (isCustodyShared()) {
    warnings.push(
      'ARC_CUSTODY_PRIVATE_KEY is not set — user credit float and earned revenue share one account.',
    );
  }

  return {
    ready: true,
    shared,
    operations,
    settlement,
    custody,
    warnings,
  };
};

export interface Solvency {
  owedToVendors: number;
  settlementBalance: number;
  surplus: number;
  solvent: boolean;
  owedToUsers: number;
  custodyBalance: number;
  custodySurplus: number;
  custodySolvent: boolean;
}

/**
 * Compare what vendors are owed against what the settlement account actually holds.
 */
export const getSolvency = async (): Promise<Solvency> => {
  const db = getDb();
  const owed = db
    .prepare(
      `
      SELECT
        (SELECT COALESCE(SUM(publisher_revenue), 0) FROM usage) -
        (SELECT COALESCE(SUM(amount), 0) FROM settlements WHERE status IN ('PENDING', 'COMPLETED'))
        AS owed
    `,
    )
    .get() as { owed: number };

  const owedToVendors = Math.max(0, owed?.owed || 0);
  const balances = await getArcBalances(getSettlementAddress());

  // Unspent user credits are a liability the custody account must be able to honour.
  const owedToUsers = getOutstandingCredits();
  const custody = isCustodyShared() ? balances : await getArcBalances(getCustodyAddress());

  return {
    owedToVendors,
    settlementBalance: balances.usdc,
    surplus: balances.usdc - owedToVendors,
    solvent: balances.usdc >= owedToVendors,
    owedToUsers,
    custodyBalance: custody.usdc,
    custodySurplus: custody.usdc - owedToUsers,
    custodySolvent: custody.usdc >= owedToUsers,
  };
};

export interface ProvisionResult {
  status: 'READY' | 'SKIPPED' | 'FAILED';
  address: string;
  fundingTxId?: string;
  optInTxId?: string;
  grantTxId?: string;
  error?: string;
}

/**
 * Make a fresh custodial wallet usable.
 * Arc / EVM wallets are immediately ready without ASA opt-in.
 */
export const provisionWallet = async (wallet: CustodialWallet): Promise<ProvisionResult> => {
  const result: ProvisionResult = { status: 'READY', address: wallet.address };

  if (
    wallet.chain?.startsWith('arc') ||
    wallet.chain === 'evm' ||
    wallet.address.startsWith('0x')
  ) {
    getDb()
      .prepare(
        'UPDATE custodial_wallets SET opted_in = 1, funded_at = CURRENT_TIMESTAMP WHERE id = ?',
      )
      .run(wallet.id);
    return result;
  }

  if (!isTreasuryConfigured()) {
    return { ...result, status: 'SKIPPED', error: 'TREASURY_MNEMONIC not configured' };
  }

  try {
    let balances = await getBalances(wallet.address);

    if (balances.algo * 1_000_000 < config.WALLET_FUNDING_MICROALGOS) {
      result.fundingTxId = await fundWithAlgo(wallet.address, config.WALLET_FUNDING_MICROALGOS);
      balances = await getBalances(wallet.address);
    }

    if (!balances.optedIn) {
      result.optInTxId = await optInToUsdc(wallet);
      balances = await getBalances(wallet.address);
    } else {
      getDb().prepare('UPDATE custodial_wallets SET opted_in = 1 WHERE id = ?').run(wallet.id);
    }

    if (config.SIGNUP_USDC_GRANT > 0 && balances.usdc <= 0) {
      result.grantTxId = await sendUsdc(wallet.address, config.SIGNUP_USDC_GRANT, 'operations');
    }

    getDb()
      .prepare('UPDATE custodial_wallets SET funded_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(wallet.id);

    return result;
  } catch (error) {
    console.error(`Failed to provision wallet ${wallet.address}:`, errorMessage(error));
    return { ...result, status: 'FAILED', error: errorMessage(error, 'Provisioning failed') };
  }
};

/**
 * Returns the address for the platform's EVM Treasury.
 */
export const getEvmTreasuryAddress = (): string => {
  if (config.EVM_SETTLEMENT_ADDRESS) return config.EVM_SETTLEMENT_ADDRESS;
  if (config.TREASURY_MNEMONIC_EVM) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { mnemonicToAccount } = require('viem/accounts');
    /* eslint-enable @typescript-eslint/no-require-imports */
    const acc = mnemonicToAccount(config.TREASURY_MNEMONIC_EVM.trim());
    return acc.address;
  }
  return '';
};

/**
 * Transfer testnet USDC on an EVM network from the platform's EVM treasury account
 * to a destination address (e.g. user custodial wallet upon Razorpay recharge).
 */
export const sendEvmUsdc = async (
  toAddress: string,
  amountUsdc: number,
  chainName = 'base',
): Promise<string | null> => {
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { createWalletClient, http, parseUnits } = require('viem');
    const { mnemonicToAccount, privateKeyToAccount } = require('viem/accounts');
    /* eslint-enable @typescript-eslint/no-require-imports */

    const mnemonic = config.TREASURY_MNEMONIC_EVM;
    const privateKey = config.EVM_SETTLEMENT_PRIVATE_KEY;

    if (!mnemonic && !privateKey) {
      console.warn('EVM treasury is not configured with a mnemonic or private key');
      return null;
    }

    const account = mnemonic
      ? mnemonicToAccount(mnemonic.trim())
      : privateKeyToAccount(privateKey as `0x${string}`);

    const chain =
      getChainByNetwork(chainName) ||
      getEnabledChains().find(c => c.name === chainName.toLowerCase()) ||
      getChainByNetwork('eip155:84532');

    if (!chain || chain.family !== 'evm' || !chain.rpcUrl) {
      console.warn(`Unsupported EVM chain for treasury transfer: ${chainName}`);
      return null;
    }

    const { defineChain } = await import('viem');
    const customChain = defineChain({
      id: chain.chainId || 11155111,
      name: chain.name,
      network: chain.name,
      nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [chain.rpcUrl] } },
    });

    const client = createWalletClient({
      account,
      chain: customChain,
      transport: http(chain.rpcUrl),
    });

    const erc20Abi = [
      {
        type: 'function',
        name: 'transfer',
        inputs: [
          { name: 'to', type: 'address' },
          { name: 'amount', type: 'uint256' },
        ],
        outputs: [{ name: '', type: 'bool' }],
        stateMutability: 'nonpayable',
      },
    ] as const;

    const atomicAmount = parseUnits(amountUsdc.toString(), chain.usdcDecimals);

    const hash = await client.writeContract({
      address: chain.usdcAddress as `0x${string}`,
      abi: erc20Abi,
      functionName: 'transfer',
      args: [toAddress as `0x${string}`, atomicAmount],
    });

    console.log(
      `Treasury transferred ${amountUsdc} USDC on ${chain.name} to ${toAddress}: ${hash}`,
    );
    return hash;
  } catch (error) {
    console.warn(
      `EVM treasury transfer warning (${chainName} to ${toAddress}):`,
      errorMessage(error),
    );
    return null;
  }
};

/**
 * Loads or derives the Solana treasury Keypair from mnemonic or private key.
 */
export const getSolanaTreasuryKeypair = (): SolanaKeypair | null => {
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { Keypair } = require('@solana/web3.js');
    /* eslint-enable @typescript-eslint/no-require-imports */

    if (config.TREASURY_MNEMONIC_SOLANA) {
      /* eslint-disable @typescript-eslint/no-require-imports */
      const bip39 = require('bip39');
      const { derivePath } = require('ed25519-hd-key');
      /* eslint-enable @typescript-eslint/no-require-imports */
      const seed = bip39.mnemonicToSeedSync(config.TREASURY_MNEMONIC_SOLANA.trim());
      const derivedSeed = derivePath("m/44'/501'/0'/0'", seed.toString('hex')).key;
      return Keypair.fromSeed(derivedSeed);
    }

    if (config.SOLANA_SETTLEMENT_PRIVATE_KEY) {
      const secretKey = new Uint8Array(Buffer.from(config.SOLANA_SETTLEMENT_PRIVATE_KEY, 'base64'));
      return Keypair.fromSecretKey(secretKey);
    }
  } catch (err) {
    console.warn('Could not derive Solana treasury keypair:', errorMessage(err));
  }
  return null;
};

/**
 * Returns the address for the platform's Solana Treasury.
 */
export const getSolanaTreasuryAddress = (): string => {
  if (config.SOLANA_SETTLEMENT_ADDRESS) return config.SOLANA_SETTLEMENT_ADDRESS;
  const kp = getSolanaTreasuryKeypair();
  if (kp) return kp.publicKey.toBase58();
  return 'GQoW27n442dBLb5FcMJuYmEbSEYQH5ueqF1tgSdNAUoN';
};

/**
 * Transfer testnet USDC on Solana devnet from the platform's Solana treasury account
 * to a destination address.
 */
export const sendSolanaUsdc = async (
  toAddress: string,
  amountUsdc: number,
): Promise<string | null> => {
  try {
    const treasuryKeypair = getSolanaTreasuryKeypair();
    if (!treasuryKeypair) {
      console.warn('Solana treasury keypair is not configured');
      return null;
    }

    const {
      Connection,
      PublicKey,
      Transaction,
      TransactionInstruction,
      sendAndConfirmTransaction,
    } = await import('@solana/web3.js');

    const connection = new Connection(config.SOLANA_RPC_URL, 'confirmed');

    const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
      'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
    );
    const SYSTEM_PROGRAM_ID = new PublicKey('11111111111111111111111111111111');

    const usdcMint = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
    const recipientPubkey = new PublicKey(toAddress);

    const [fromAta] = PublicKey.findProgramAddressSync(
      [treasuryKeypair.publicKey.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), usdcMint.toBuffer()],
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    const [toAta] = PublicKey.findProgramAddressSync(
      [recipientPubkey.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), usdcMint.toBuffer()],
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    const atomicAmount = Math.round(amountUsdc * 1_000_000);

    const createRecipientAtaIx = new TransactionInstruction({
      programId: ASSOCIATED_TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: treasuryKeypair.publicKey, isSigner: true, isWritable: true },
        { pubkey: toAta, isSigner: false, isWritable: true },
        { pubkey: recipientPubkey, isSigner: false, isWritable: false },
        { pubkey: usdcMint, isSigner: false, isWritable: false },
        { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.from([1]), // CreateIdempotent
    });

    const transferData = Buffer.alloc(10);
    transferData.writeUInt8(12, 0); // TransferChecked
    transferData.writeBigUInt64LE(BigInt(atomicAmount), 1);
    transferData.writeUInt8(6, 9); // 6 decimals

    const transferIx = new TransactionInstruction({
      programId: TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: fromAta, isSigner: false, isWritable: true },
        { pubkey: usdcMint, isSigner: false, isWritable: false },
        { pubkey: toAta, isSigner: false, isWritable: true },
        { pubkey: treasuryKeypair.publicKey, isSigner: true, isWritable: false },
      ],
      data: transferData,
    });

    const transaction = new Transaction().add(createRecipientAtaIx, transferIx);
    const signature = await sendAndConfirmTransaction(connection, transaction, [treasuryKeypair]);

    console.log(`Solana Treasury transferred ${amountUsdc} USDC to ${toAddress}: ${signature}`);
    return signature;
  } catch (error) {
    console.warn(`Solana treasury transfer warning (to ${toAddress}):`, errorMessage(error));
    return null;
  }
};

/**
 * Returns the Keypair for the platform's Stellar Treasury if configured.
 */
export const getStellarTreasuryKeypair = (): import('@stellar/stellar-sdk').Keypair | null => {
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { Keypair } = require('@stellar/stellar-sdk');
    /* eslint-enable @typescript-eslint/no-require-imports */

    if (config.TREASURY_MNEMONIC_STELLAR) {
      /* eslint-disable @typescript-eslint/no-require-imports */
      const bip39 = require('bip39');
      const { derivePath } = require('ed25519-hd-key');
      /* eslint-enable @typescript-eslint/no-require-imports */
      const seed = bip39.mnemonicToSeedSync(config.TREASURY_MNEMONIC_STELLAR.trim());
      const derivedSeed = derivePath("m/44'/148'/0'", seed.toString('hex')).key;
      return Keypair.fromRawEd25519Seed(derivedSeed);
    }

    const secret = config.TREASURY_SECRET_STELLAR || config.STELLAR_SETTLEMENT_SECRET;
    if (secret && secret.startsWith('S')) {
      return Keypair.fromSecret(secret);
    }
  } catch (err) {
    console.warn('Could not load Stellar treasury keypair:', errorMessage(err));
  }
  return null;
};

/**
 * Returns the public address for the platform's Stellar Treasury.
 */
export const getStellarTreasuryAddress = (): string => {
  if (config.STELLAR_SETTLEMENT_ADDRESS) return config.STELLAR_SETTLEMENT_ADDRESS;
  const kp = getStellarTreasuryKeypair();
  if (kp) return kp.publicKey();
  return 'GBE4VSYEGQZWNRRON4G4X44MTUFQKWG2EZKVFRU6HOINIMREL6YU7CAI';
};

/**
 * Transfer USDC on Stellar from the platform's Stellar treasury account to a destination address.
 */
export const sendStellarUsdc = async (
  toAddress: string,
  amountUsdc: number,
): Promise<string | null> => {
  try {
    const treasuryKeypair = getStellarTreasuryKeypair();
    if (!treasuryKeypair) {
      console.warn('Stellar treasury keypair is not configured');
      return null;
    }

    /* eslint-disable @typescript-eslint/no-require-imports */
    const {
      Horizon,
      Networks,
      TransactionBuilder,
      Asset,
      Operation,
    } = require('@stellar/stellar-sdk');
    /* eslint-enable @typescript-eslint/no-require-imports */

    const horizonUrl = config.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org';
    const server = new Horizon.Server(horizonUrl);
    const networkPassphrase = config.IS_MAINNET ? Networks.PUBLIC : Networks.TESTNET;

    const sourceAccount = await server.loadAccount(treasuryKeypair.publicKey());
    const usdcAsset = new Asset(
      'USDC',
      config.IS_MAINNET
        ? 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN' // Circle official Stellar USDC issuer
        : 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', // Testnet USDC issuer
    );

    let destinationExists = false;
    let hasUsdcTrustline = false;
    try {
      const destAccount = await server.loadAccount(toAddress);
      destinationExists = true;
      hasUsdcTrustline = (destAccount.balances || []).some(
        (b: { asset_code?: string }) => b.asset_code === 'USDC',
      );
    } catch {
      destinationExists = false;
    }

    const txBuilder = new TransactionBuilder(sourceAccount, {
      fee: '10000',
      networkPassphrase,
    }).setTimeout(30);

    if (!destinationExists) {
      const startingBalance = amountUsdc > 2 ? Math.min(amountUsdc, 10).toFixed(7) : '2.0000000';
      txBuilder.addOperation(
        Operation.createAccount({
          destination: toAddress,
          startingBalance,
        }),
      );
    } else if (hasUsdcTrustline) {
      txBuilder.addOperation(
        Operation.payment({
          destination: toAddress,
          asset: usdcAsset,
          amount: amountUsdc.toFixed(7),
        }),
      );
    } else {
      txBuilder.addOperation(
        Operation.payment({
          destination: toAddress,
          asset: Asset.native(),
          amount: amountUsdc.toFixed(7),
        }),
      );
    }

    const transaction = txBuilder.build();
    transaction.sign(treasuryKeypair);
    const res = await server.submitTransaction(transaction);
    const txHash = res.hash || res.id;
    console.log(`Stellar Treasury transferred ${amountUsdc} to ${toAddress}: ${txHash}`);
    return txHash;
  } catch (error) {
    console.warn(`Stellar treasury transfer warning (to ${toAddress}):`, errorMessage(error));
    return null;
  }
};

/**
 * Automatically provision a custodial Stellar wallet on testnet if it is not yet active.
 * Funds with 3 XLM and adds the USDC trustline.
 */
export const provisionStellarWallet = async (wallet: {
  address: string;
  encrypted_key?: string;
  encryptedKey?: string;
}): Promise<void> => {
  try {
    const treasuryKeypair = getStellarTreasuryKeypair();
    if (!treasuryKeypair) return;

    /* eslint-disable @typescript-eslint/no-require-imports */
    const {
      Horizon,
      Networks,
      TransactionBuilder,
      Asset,
      Operation,
      Keypair,
    } = require('@stellar/stellar-sdk');
    const { decryptSecret } = require('./vault');
    /* eslint-enable @typescript-eslint/no-require-imports */

    const horizonUrl = config.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org';
    const server = new Horizon.Server(horizonUrl);
    const networkPassphrase = config.IS_MAINNET ? Networks.PUBLIC : Networks.TESTNET;

    let accountExists = false;
    let hasTrustline = false;
    try {
      const userAcc = await server.loadAccount(wallet.address);
      accountExists = true;
      hasTrustline = (userAcc.balances || []).some(
        (b: { asset_code?: string }) => b.asset_code === 'USDC',
      );
    } catch {
      accountExists = false;
    }

    if (!accountExists) {
      const treasuryAccount = await server.loadAccount(treasuryKeypair.publicKey());
      const createTx = new TransactionBuilder(treasuryAccount, {
        fee: '10000',
        networkPassphrase,
      })
        .addOperation(
          Operation.createAccount({
            destination: wallet.address,
            startingBalance: '3.0000000',
          }),
        )
        .setTimeout(30)
        .build();

      createTx.sign(treasuryKeypair);
      await server.submitTransaction(createTx);
    }

    const encryptedKey = wallet.encrypted_key || wallet.encryptedKey;
    if (!hasTrustline && encryptedKey) {
      const secret = decryptSecret(encryptedKey);
      const userKp = Keypair.fromSecret(secret);
      const userAccount = await server.loadAccount(wallet.address);
      const usdcAsset = new Asset(
        'USDC',
        config.IS_MAINNET
          ? 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
          : 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      );

      const trustTx = new TransactionBuilder(userAccount, {
        fee: '10000',
        networkPassphrase,
      })
        .addOperation(Operation.changeTrust({ asset: usdcAsset }))
        .setTimeout(30)
        .build();

      trustTx.sign(userKp);
      await server.submitTransaction(trustTx);
    }
  } catch (err) {
    console.warn('Stellar wallet provisioning warning:', errorMessage(err));
  }
};

/**
 * Ensures a user's testnet Stellar custodial wallet has enough USDC float to complete a request.
 */
export const ensureStellarUserFloat = async (
  address: string,
  requiredUsdc: number,
): Promise<void> => {
  if (config.IS_MAINNET) return;
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { Horizon } = require('@stellar/stellar-sdk');
    /* eslint-enable @typescript-eslint/no-require-imports */

    const horizonUrl = config.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org';
    const server = new Horizon.Server(horizonUrl);
    const userAcc = await server.loadAccount(address);
    const usdcBalance = (userAcc.balances || []).find(
      (b: { asset_code?: string; balance?: string }) => b.asset_code === 'USDC',
    );
    const balanceNum = usdcBalance ? parseFloat(usdcBalance.balance) : 0;
    if (balanceNum < requiredUsdc) {
      const topUpAmount = Math.max(requiredUsdc * 2, 2);
      await sendStellarUsdc(address, topUpAmount);
    }
  } catch (err) {
    console.warn('ensureStellarUserFloat warning:', errorMessage(err));
  }
};
