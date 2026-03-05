/**
 * network-config.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Centralized network configuration for devnet and mainnet-beta.
 * All network-specific constants (RPC URLs, token mints, Jupiter endpoints)
 * are defined here so the rest of the codebase is network-agnostic.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type NetworkType = 'devnet' | 'mainnet-beta';

export interface NetworkConfig {
    network: NetworkType;
    rpcUrl: string;
    explorerBase: string;
    tokenMints: Record<string, string>;
    usdcDecimals: number;
    jupiterQuoteUrl: string;
    jupiterSwapUrl: string;
    jupiterPriceUrl: string;
    airdropAvailable: boolean;
}

// ─── Network Configs ──────────────────────────────────────────────────────────

const DEVNET_CONFIG: NetworkConfig = {
    network: 'devnet',
    rpcUrl: 'https://api.devnet.solana.com',
    explorerBase: 'https://explorer.solana.com',
    tokenMints: {
        SOL: 'So11111111111111111111111111111111111111112',
        USDC: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
        USDT: 'EJwZgeZrdC8TXTQbQBoL6bfuoGMyhyppRoGJM2VGvBkr',
    },
    usdcDecimals: 6,
    jupiterQuoteUrl: 'https://api.jup.ag/swap/v1/quote',
    jupiterSwapUrl: 'https://api.jup.ag/swap/v1/swap',
    jupiterPriceUrl: 'https://api.jup.ag/price/v2',
    airdropAvailable: true,
};

const MAINNET_CONFIG: NetworkConfig = {
    network: 'mainnet-beta',
    rpcUrl: 'https://api.mainnet-beta.solana.com',
    explorerBase: 'https://explorer.solana.com',
    tokenMints: {
        SOL: 'So11111111111111111111111111111111111111112',
        USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    },
    usdcDecimals: 6,
    jupiterQuoteUrl: 'https://api.jup.ag/swap/v1/quote',
    jupiterSwapUrl: 'https://api.jup.ag/swap/v1/swap',
    jupiterPriceUrl: 'https://api.jup.ag/price/v2',
    airdropAvailable: false,
};

// ─── Public API ───────────────────────────────────────────────────────────────

const configs: Record<NetworkType, NetworkConfig> = {
    'devnet': DEVNET_CONFIG,
    'mainnet-beta': MAINNET_CONFIG,
};

export function getNetworkConfig(network: NetworkType): NetworkConfig {
    return configs[network];
}

export function getDefaultNetwork(): NetworkType {
    const env = process.env.SOLANA_NETWORK?.toLowerCase();
    if (env === 'mainnet-beta' || env === 'mainnet') return 'mainnet-beta';
    return 'devnet';
}

export function getExplorerUrl(signature: string, network: NetworkType): string {
    const config = getNetworkConfig(network);
    const clusterParam = network === 'devnet' ? '?cluster=devnet' : '';
    return `${config.explorerBase}/tx/${signature}${clusterParam}`;
}

export function getAddressExplorerUrl(address: string, network: NetworkType): string {
    const config = getNetworkConfig(network);
    const clusterParam = network === 'devnet' ? '?cluster=devnet' : '';
    return `${config.explorerBase}/address/${address}${clusterParam}`;
}
