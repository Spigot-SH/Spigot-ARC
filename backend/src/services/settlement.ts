import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { errorMessage } from './errors';
import { getDb } from '../db/connection';
import { Settlement, Wallet } from '../types';
import {
  sendUsdc,
  sendEvmUsdc,
  sendSolanaUsdc,
  sendStellarUsdc,
  getSettlementAddress,
} from './treasury';
import { getBalances } from './wallet';
import { config } from '../config';

export const getPublisherBalance = (publisherId: string) => {
  const db = getDb();

  const usageStats = db
    .prepare<unknown[], { total_revenue: number | null }>(
      `
    SELECT 
      SUM(publisher_revenue) as total_revenue
    FROM usage u
    JOIN apis a ON u.api_id = a.id
    WHERE a.publisher_id = ?
  `,
    )
    .get(publisherId);

  // PENDING counts as settled: an in-flight payout has already reserved that balance, so
  // a concurrent settle request must not be able to spend it a second time.
  const settlementStats = db
    .prepare<unknown[], { total_settled: number | null }>(
      `
    SELECT
      SUM(amount) as total_settled
    FROM settlements
    WHERE publisher_id = ? AND status IN ('PENDING', 'COMPLETED')
  `,
    )
    .get(publisherId);

  const totalRevenue = usageStats?.total_revenue || 0;
  const totalSettled = settlementStats?.total_settled || 0;

  return {
    available: totalRevenue - totalSettled,
    pending: 0,
    settled: totalSettled,
  };
};

export type SettlementOutcome =
  | {
      status: 'PAID';
      settlement: Record<string, unknown>;
      txId: string;
      chain?: string;
      walletAddress?: string;
    }
  | {
      status: 'NOTHING_DUE' | 'NO_WALLET' | 'BELOW_MINIMUM' | 'FAILED';
      message: string;
      available?: number;
      minimum?: number;
    };

/**
 * Pay a publisher's outstanding balance to their own external address.
 *
 * The settlement row is written as PENDING *before* the transfer and only then marked
 * COMPLETED. Because `getPublisherBalance` counts PENDING as already settled, a second
 * concurrent call sees nothing due instead of paying twice.
 */
export const processSettlement = async (
  publisherId: string,
  options: { force?: boolean } = { force: true },
): Promise<SettlementOutcome> => {
  const db = getDb();
  const balances = getPublisherBalance(publisherId);

  if (balances.available <= 0) {
    return {
      status: 'NOTHING_DUE',
      message: 'No balance available to withdraw',
      available: balances.available,
    };
  }

  const wallet = db
    .prepare<unknown[], Wallet>('SELECT * FROM wallets WHERE publisher_id = ?')
    .get(publisherId);
  if (!wallet) {
    return { status: 'NO_WALLET', message: 'Set a payout address before withdrawing' };
  }
  const minThreshold = options.force ? 0.000001 : wallet.min_payout || 0.000001;
  if (balances.available < minThreshold) {
    return {
      status: 'BELOW_MINIMUM',
      message: `Balance is below the minimum threshold`,
      available: balances.available,
      minimum: wallet.min_payout,
    };
  }

  // `available` sums usage.publisher_revenue, which the gateway already recorded net of
  // the platform fee — deducting it again here would charge the publisher twice.
  const amount = balances.available;
  const isStellar =
    wallet.chain?.toLowerCase() === 'stellar' ||
    (wallet.address.startsWith('G') && wallet.address.length === 56);
  const isSolana =
    !isStellar &&
    (wallet.chain?.toLowerCase() === 'solana' ||
      (!wallet.address.startsWith('0x') &&
        wallet.address.length >= 32 &&
        wallet.address.length <= 44 &&
        wallet.chain !== 'algorand'));
  const isEvm =
    !isStellar &&
    !isSolana &&
    ((wallet.chain && wallet.chain.toLowerCase() !== 'algorand') ||
      wallet.address.startsWith('0x'));

  if (!isEvm && !isSolana && !isStellar) {
    // Fail before reserving if the settlement account cannot cover this payout, so the
    // publisher gets a clear answer instead of a transfer that dies half way.
    try {
      const settlementBalance = (await getBalances(getSettlementAddress())).usdc;
      if (settlementBalance < amount) {
        return {
          status: 'FAILED',
          message: `Settlement account holds ${settlementBalance} USDC but ${amount} is due. Top it up and try again.`,
        };
      }
    } catch (error) {
      return {
        status: 'FAILED',
        message: `Could not read the settlement balance: ${errorMessage(error)}`,
      };
    }
  }

  const settlementId = uuidv4();

  const settlement = {
    id: settlementId,
    publisher_id: publisherId,
    wallet_id: wallet.id,
    amount,
    platform_fee: 0,
    net_amount: amount,
    tx_id: null as string | null,
    status: 'PENDING',
    period_start: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    period_end: new Date().toISOString(),
  };

  db.prepare(
    `
    INSERT INTO settlements (id, publisher_id, wallet_id, amount, platform_fee, net_amount, tx_id, status, period_start, period_end)
    VALUES (@id, @publisher_id, @wallet_id, @amount, @platform_fee, @net_amount, @tx_id, @status, @period_start, @period_end)
  `,
  ).run(settlement);

  try {
    let txId: string;
    if (isStellar) {
      const onChainTx = await sendStellarUsdc(wallet.address, amount);
      if (!onChainTx) {
        if (!config.IS_PRODUCTION) {
          txId = `stellar_${crypto.randomBytes(16).toString('hex')}`;
        } else {
          throw new Error('Stellar payout transfer failed on-chain');
        }
      } else {
        txId = onChainTx;
      }
    } else if (isSolana) {
      const onChainTx = await sendSolanaUsdc(wallet.address, amount);
      if (!onChainTx) {
        if (!config.IS_PRODUCTION) {
          txId = `solana_${crypto.randomBytes(16).toString('hex')}`;
        } else {
          throw new Error('Solana payout transfer failed on-chain');
        }
      } else {
        txId = onChainTx;
      }
    } else if (isEvm) {
      const chainName = wallet.chain || 'ethereum';
      const onChainTx = await sendEvmUsdc(wallet.address, amount, chainName);
      if (!onChainTx) {
        if (!config.IS_PRODUCTION) {
          txId = `0x${crypto.randomBytes(32).toString('hex')}`;
        } else {
          throw new Error('EVM payout transfer failed on-chain');
        }
      } else {
        txId = onChainTx;
      }
    } else {
      // Algorand: Pay the exact fractional amount; rounding down would zero out sub-1 USDC payouts.
      txId = await sendUsdc(wallet.address, amount);
    }

    db.prepare("UPDATE settlements SET tx_id = ?, status = 'COMPLETED' WHERE id = ?").run(
      txId,
      settlementId,
    );
    return {
      status: 'PAID',
      txId,
      chain: isSolana ? 'solana' : isEvm ? wallet.chain || 'ethereum' : 'algorand',
      walletAddress: wallet.address,
      settlement: { ...settlement, tx_id: txId, status: 'COMPLETED' },
    };
  } catch (error) {
    // Release the reservation so the balance becomes available again.
    db.prepare("UPDATE settlements SET status = 'FAILED' WHERE id = ?").run(settlementId);
    console.error(`Settlement ${settlementId} failed:`, errorMessage(error));
    return { status: 'FAILED', message: errorMessage(error, 'Payout transfer failed') };
  }
};

export const getSettlementHistory = (publisherId: string): Settlement[] => {
  return getDb()
    .prepare('SELECT * FROM settlements WHERE publisher_id = ? ORDER BY created_at DESC')
    .all(publisherId) as Settlement[];
};
