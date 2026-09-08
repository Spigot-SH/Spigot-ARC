import { config } from '../config';

export type ChainFamily = 'algorand' | 'evm' | 'solana' | 'stellar';

export interface ChainInfo {
  family: ChainFamily;
  caip2: string;
  name: string;
  usdcAddress: string;
  usdcDecimals: number;
  facilitatorUrl: string;
  explorerUrl: string;
  rpcUrl?: string;
  chainId?: number;
  tokenName?: string;
  tokenVersion?: string;
}

type ChainData = Omit<ChainInfo, 'family' | 'facilitatorUrl' | 'usdcDecimals'>;

/**
 * Chain constants per network profile.
 *
 * Selected by `config.NETWORK_PROFILE`, the same switch that moves Algorand, so flipping
 * ALGORAND_NETWORK_PROFILE=mainnet moves EVM and Solana with it rather than leaving them
 * silently pointed at testnet.
 *
 * USDC addresses are the canonical Circle deployments. Anything not verifiable is left out
 * of the mainnet table on purpose: an unknown chain is refused at boot rather than guessed,
 * because a wrong token address on mainnet spends real money into a contract nobody owns.
 */
const EVM_CHAINS_BY_PROFILE: Record<string, Record<string, ChainData>> = {
  testnet: {
    'arc-testnet': {
      chainId: 5042002,
      caip2: 'eip155:5042002',
      name: 'arc-testnet',
      usdcAddress: '0x3600000000000000000000000000000000000000',
      explorerUrl: 'https://testnet.arcscan.app',
      rpcUrl: 'https://rpc.testnet.arc.network',
      tokenName: 'USDC',
      tokenVersion: '2',
    },
    ethereum: {
      chainId: 11155111,
      caip2: 'eip155:11155111',
      name: 'ethereum',
      usdcAddress: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
      explorerUrl: 'https://sepolia.etherscan.io',
      rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com',
      tokenName: 'USDC',
      tokenVersion: '2',
    },
    base: {
      chainId: 84532,
      caip2: 'eip155:84532',
      name: 'base',
      usdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      explorerUrl: 'https://sepolia.basescan.org',
      rpcUrl: 'https://sepolia.base.org',
      tokenName: 'USDC',
      tokenVersion: '2',
    },
    arbitrum: {
      chainId: 421614,
      caip2: 'eip155:421614',
      name: 'arbitrum',
      usdcAddress: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
      explorerUrl: 'https://sepolia.arbiscan.io',
      rpcUrl: 'https://sepolia-rollup.arbitrum.io/rpc',
      tokenName: 'USD Coin',
      tokenVersion: '2',
    },
    optimism: {
      chainId: 11155420,
      caip2: 'eip155:11155420',
      name: 'optimism',
      usdcAddress: '0x5fd84259d66Cd46123540766Be93DFE6D43130D7',
      explorerUrl: 'https://sepolia-optimism.etherscan.io',
      rpcUrl: 'https://sepolia.optimism.io',
      tokenName: 'USD Coin',
      tokenVersion: '2',
    },
    avalanche: {
      chainId: 43113,
      caip2: 'eip155:43113',
      name: 'avalanche',
      usdcAddress: '0x5425890298aed601595a70AB815c96711a31Bc65',
      explorerUrl: 'https://testnet.snowtrace.io',
      rpcUrl: 'https://api.avax-test.network/ext/bc/C/rpc',
      tokenName: 'USD Coin',
      tokenVersion: '2',
    },
    robinhood: {
      chainId: 46630,
      caip2: 'eip155:46630',
      name: 'robinhood',
      usdcAddress: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
      explorerUrl: 'https://testnet.robinscan.com',
      rpcUrl: 'https://rpc.testnet.robinhoodchain.com',
      tokenName: 'USDC',
      tokenVersion: '2',
    },
  },
  mainnet: {
    arc: {
      chainId: 5042001,
      caip2: 'eip155:5042001',
      name: 'arc',
      usdcAddress: '0x3600000000000000000000000000000000000000',
      explorerUrl: 'https://arcscan.app',
      rpcUrl: 'https://rpc.arc.network',
      tokenName: 'USDC',
      tokenVersion: '2',
    },
    ethereum: {
      chainId: 1,
      caip2: 'eip155:1',
      name: 'ethereum',
      usdcAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      explorerUrl: 'https://etherscan.io',
      rpcUrl: 'https://ethereum-rpc.publicnode.com',
      tokenName: 'USD Coin',
      tokenVersion: '2',
    },
    base: {
      chainId: 8453,
      caip2: 'eip155:8453',
      name: 'base',
      usdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      explorerUrl: 'https://basescan.org',
      rpcUrl: 'https://mainnet.base.org',
      tokenName: 'USD Coin',
      tokenVersion: '2',
    },
    arbitrum: {
      chainId: 42161,
      caip2: 'eip155:42161',
      name: 'arbitrum',
      usdcAddress: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
      explorerUrl: 'https://arbiscan.io',
      rpcUrl: 'https://arb1.arbitrum.io/rpc',
      tokenName: 'USD Coin',
      tokenVersion: '2',
    },
    optimism: {
      chainId: 10,
      caip2: 'eip155:10',
      name: 'optimism',
      usdcAddress: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
      explorerUrl: 'https://optimistic.etherscan.io',
      rpcUrl: 'https://mainnet.optimism.io',
      tokenName: 'USD Coin',
      tokenVersion: '2',
    },
    avalanche: {
      chainId: 43114,
      caip2: 'eip155:43114',
      name: 'avalanche',
      usdcAddress: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
      explorerUrl: 'https://snowtrace.io',
      rpcUrl: 'https://api.avax.network/ext/bc/C/rpc',
      tokenName: 'USD Coin',
      tokenVersion: '2',
    },
    // `robinhood` is deliberately absent. Its mainnet chain id, USDC address and RPC could
    // not be verified, and guessing them would burn real funds. Enabling it on mainnet needs
    // the values supplied explicitly via EVM_CHAIN_OVERRIDES_JSON.
  },
};

const SOLANA_CHAINS_BY_PROFILE: Record<string, Record<string, ChainData>> = {
  testnet: {
    solana: {
      caip2: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
      name: 'solana',
      usdcAddress: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
      explorerUrl: 'https://explorer.solana.com',
      rpcUrl: config.SOLANA_RPC_URL,
      tokenName: 'USDC',
    },
  },
  mainnet: {
    solana: {
      caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      name: 'solana',
      usdcAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      explorerUrl: 'https://explorer.solana.com',
      rpcUrl: config.SOLANA_RPC_URL,
      tokenName: 'USDC',
    },
  },
};

const STELLAR_CHAINS_BY_PROFILE: Record<string, Record<string, ChainData>> = {
  testnet: {
    stellar: {
      caip2: 'stellar:testnet',
      name: 'stellar',
      usdcAddress: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
      explorerUrl: 'https://stellar.expert/explorer/testnet',
      rpcUrl: config.STELLAR_RPC_URL || 'https://soroban-testnet.stellar.org',
      tokenName: 'USDC',
    },
  },
  mainnet: {
    stellar: {
      caip2: 'stellar:pubnet',
      name: 'stellar',
      usdcAddress: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
      explorerUrl: 'https://stellar.expert/explorer/public',
      rpcUrl: config.STELLAR_RPC_URL || 'https://mainnet.stellar.org',
      tokenName: 'USDC',
    },
  },
};

/** Per-chain escape hatch: EVM_CHAIN_OVERRIDES_JSON={"base":{"rpcUrl":"https://..."}} */
const applyOverrides = (name: string, data: ChainData): ChainData => {
  const override = config.CHAIN_OVERRIDES[name];
  return override ? { ...data, ...override } : data;
};

const EVM_CHAINS_DATA = EVM_CHAINS_BY_PROFILE[config.NETWORK_PROFILE] || {};
const SOLANA_CHAINS_DATA = SOLANA_CHAINS_BY_PROFILE[config.NETWORK_PROFILE] || {};
const STELLAR_CHAINS_DATA = STELLAR_CHAINS_BY_PROFILE[config.NETWORK_PROFILE] || {};

let _chains: ChainInfo[] | null = null;

function initializeChains(): ChainInfo[] {
  if (_chains) return _chains;

  const chains: ChainInfo[] = [];

  // Primary chain: Arc (Circle L1 with native USDC gas)
  const arcChainName = config.IS_MAINNET ? 'arc' : 'arc-testnet';
  const arcData = EVM_CHAINS_DATA[arcChainName] || {
    chainId: config.ARC_CHAIN_ID,
    caip2: config.ARC_NETWORK,
    name: arcChainName,
    usdcAddress: config.ARC_USDC_ADDRESS,
    explorerUrl: config.ARC_EXPLORER_URL,
    rpcUrl: config.ARC_RPC_URL,
    tokenName: 'USDC',
    tokenVersion: '2',
  };

  chains.push({
    ...applyOverrides(arcChainName, arcData),
    family: 'evm',
    usdcDecimals: 6,
    facilitatorUrl: config.EVM_FACILITATOR_URL,
  });

  // Additional EVM chains
  const enabledEvmChains = config.EVM_ENABLED_CHAINS || [];
  for (const chainName of enabledEvmChains) {
    if (chainName === arcChainName) continue;
    const chainData = EVM_CHAINS_DATA[chainName];
    if (!chainData) {
      // Silently skipping would leave the chain enabled in config but absent at runtime, so
      // payments for it would fail far from the cause. On mainnet this is usually a chain
      // whose constants were never verified: supply them via EVM_CHAIN_OVERRIDES_JSON.
      throw new Error(
        `EVM chain "${chainName}" is enabled but has no ${config.NETWORK_PROFILE} definition. ` +
          `Remove it from EVM_ENABLED_CHAINS, or supply its constants via EVM_CHAIN_OVERRIDES_JSON.`,
      );
    }
    chains.push({
      ...applyOverrides(chainName, chainData),
      family: 'evm',
      usdcDecimals: 6,
      facilitatorUrl: config.EVM_FACILITATOR_URL,
    });
  }

  // Solana chains
  const enabledSolanaChains = config.SOLANA_ENABLED_CHAINS || [];
  for (const chainName of enabledSolanaChains) {
    const chainData = SOLANA_CHAINS_DATA[chainName];
    if (!chainData) {
      throw new Error(
        `Solana chain "${chainName}" is enabled but has no ${config.NETWORK_PROFILE} definition.`,
      );
    }
    chains.push({
      ...applyOverrides(chainName, chainData),
      family: 'solana',
      usdcDecimals: 6,
      facilitatorUrl: config.SOLANA_FACILITATOR_URL,
    });
  }

  // Stellar chains
  const enabledStellarChains = config.STELLAR_ENABLED_CHAINS || [];
  for (const chainName of enabledStellarChains) {
    const chainData = STELLAR_CHAINS_DATA[chainName];
    if (!chainData) {
      throw new Error(
        `Stellar chain "${chainName}" is enabled but has no ${config.NETWORK_PROFILE} definition.`,
      );
    }
    chains.push({
      ...applyOverrides(chainName, chainData),
      family: 'stellar',
      usdcDecimals: 7,
      facilitatorUrl: config.STELLAR_FACILITATOR_URL,
    });
  }

  _chains = chains;
  return chains;
}

export function getEnabledChains(): ChainInfo[] {
  return initializeChains();
}

export function getChainByNetwork(network: string): ChainInfo | undefined {
  const chains = getEnabledChains();
  const raw = network.toLowerCase().trim();
  const normalized = raw.replace(/\s+/g, '-');
  return chains.find(
    c =>
      c.caip2.toLowerCase() === raw ||
      c.caip2.toLowerCase() === normalized ||
      c.name.toLowerCase() === raw ||
      c.name.toLowerCase() === normalized,
  );
}

export function isArcNetwork(network: string): boolean {
  const raw = network.toLowerCase().trim();
  const query = raw.replace(/\s+/g, '-');
  return (
    query === config.ARC_NETWORK.toLowerCase() ||
    query === config.ARC_CHAIN_ID.toString() ||
    query === 'arc' ||
    query === 'arc-testnet' ||
    query === 'eip155:5042002' ||
    query === 'eip155:5042001' ||
    query.includes('504200')
  );
}

export function isEvmNetwork(network: string): boolean {
  return network.startsWith('eip155:');
}

export function isAlgorandNetwork(network: string): boolean {
  return network.startsWith('algorand:');
}

export function isSolanaNetwork(network: string): boolean {
  return network.startsWith('solana:');
}

export function isStellarNetwork(network: string): boolean {
  return network.startsWith('stellar:') || network === 'stellar';
}

/** Solana's explorer needs an explicit cluster for anything that is not mainnet-beta. */
const solanaCluster = (): string => (config.IS_MAINNET ? '' : '?cluster=devnet');

export function getExplorerTxUrl(network: string, txHash: string): string {
  const chain = getChainByNetwork(network);
  if (!chain) return '';
  if (chain.family === 'solana') {
    return `${chain.explorerUrl}/tx/${txHash}${solanaCluster()}`;
  }
  if (chain.family === 'stellar') {
    return `${chain.explorerUrl}/tx/${txHash}`;
  }
  return `${chain.explorerUrl}/tx/${txHash}`;
}

/** Address view on the right explorer for the active profile. Used by the frontend. */
export function getExplorerAddressUrl(network: string, address: string): string {
  const chain = getChainByNetwork(network);
  if (!chain) return '';
  if (chain.family === 'solana') {
    return `${chain.explorerUrl}/address/${address}${solanaCluster()}`;
  }
  if (chain.family === 'stellar') {
    return `${chain.explorerUrl}/account/${address}`;
  }
  return `${chain.explorerUrl}/address/${address}`;
}
