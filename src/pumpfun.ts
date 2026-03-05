/**
 * pumpfun.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Pump.fun memecoin trading service.
 * Buy/sell tokens launched on Pump.fun using the PumpPortal API.
 *
 * Uses PumpPortal's local transaction API to build swap transactions,
 * then signs and sends them locally for security.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
    Connection,
    Keypair,
    LAMPORTS_PER_SOL,
    VersionedTransaction,
} from '@solana/web3.js';
import axios from 'axios';
import { logger } from './logger';
import { getExplorerUrl, NetworkConfig, getNetworkConfig } from './network-config';

// ─── Constants ──────────────────────────────────────────────────────────────

const PUMPPORTAL_API = 'https://pumpportal.fun/api/trade-local';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PumpTradeResult {
    success: boolean;
    signature?: string;
    error?: string;
}

// ─── PumpFun Service ────────────────────────────────────────────────────────

export class PumpFunService {
    private connection: Connection;
    private wallet: Keypair;
    private networkConfig: NetworkConfig;

    constructor(connection: Connection, wallet: Keypair, network: string) {
        this.connection = connection;
        this.wallet = wallet;
        this.networkConfig = getNetworkConfig(network as any);
    }

    /**
     * Buy a Pump.fun token with SOL.
     * @param mintAddress - The token's mint address
     * @param amountSOL  - Amount of SOL to spend
     * @param slippagePct - Slippage tolerance (default 5%)
     */
    async buyToken(
        mintAddress: string,
        amountSOL: number,
        slippagePct: number = 5
    ): Promise<PumpTradeResult> {
        if (amountSOL <= 0) {
            return { success: false, error: 'Buy amount must be > 0.' };
        }

        if (this.networkConfig.network !== 'mainnet-beta') {
            return { success: false, error: 'Pump.fun trading is only available on mainnet.' };
        }

        try {
            logger.info(`Pump.fun BUY: ${amountSOL} SOL → ${mintAddress}`);

            const response = await axios.post(PUMPPORTAL_API, {
                publicKey: this.wallet.publicKey.toString(),
                action: 'buy',
                mint: mintAddress,
                amount: amountSOL * LAMPORTS_PER_SOL,
                denominatedInSol: 'true',
                slippage: slippagePct,
                priorityFee: 0.0005,
                pool: 'pump',
            }, { timeout: 15_000, responseType: 'arraybuffer' });

            const txData = new Uint8Array(response.data);
            const tx = VersionedTransaction.deserialize(txData);
            tx.sign([this.wallet]);

            const signature = await this.connection.sendTransaction(tx, {
                skipPreflight: false,
                preflightCommitment: 'confirmed',
            });

            // Wait for confirmation
            const latestBlockhash = await this.connection.getLatestBlockhash();
            await this.connection.confirmTransaction({
                signature,
                blockhash: latestBlockhash.blockhash,
                lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
            });

            const explorerUrl = getExplorerUrl(signature, this.networkConfig.network);
            logger.audit('TRANSACTION_CONFIRMED', `Pump.fun BUY confirmed: ${amountSOL} SOL → ${mintAddress}`, {
                signature,
                mintAddress,
                explorer: explorerUrl,
            });

            return { success: true, signature };

        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.audit('ERROR', `Pump.fun BUY error: ${msg}`, { error: msg });
            return { success: false, error: msg };
        }
    }

    /**
     * Sell a Pump.fun token for SOL.
     * @param mintAddress   - The token's mint address
     * @param amountTokens  - Amount of tokens to sell (in token units)
     * @param slippagePct   - Slippage tolerance (default 5%)
     */
    async sellToken(
        mintAddress: string,
        amountTokens: number,
        slippagePct: number = 5
    ): Promise<PumpTradeResult> {
        if (amountTokens <= 0) {
            return { success: false, error: 'Sell amount must be > 0.' };
        }

        if (this.networkConfig.network !== 'mainnet-beta') {
            return { success: false, error: 'Pump.fun trading is only available on mainnet.' };
        }

        try {
            logger.info(`Pump.fun SELL: ${amountTokens} tokens of ${mintAddress}`);

            const response = await axios.post(PUMPPORTAL_API, {
                publicKey: this.wallet.publicKey.toString(),
                action: 'sell',
                mint: mintAddress,
                amount: amountTokens * 1_000_000, // Pump.fun tokens have 6 decimals
                denominatedInSol: 'false',
                slippage: slippagePct,
                priorityFee: 0.0005,
                pool: 'pump',
            }, { timeout: 15_000, responseType: 'arraybuffer' });

            const txData = new Uint8Array(response.data);
            const tx = VersionedTransaction.deserialize(txData);
            tx.sign([this.wallet]);

            const signature = await this.connection.sendTransaction(tx, {
                skipPreflight: false,
                preflightCommitment: 'confirmed',
            });

            const latestBlockhash = await this.connection.getLatestBlockhash();
            await this.connection.confirmTransaction({
                signature,
                blockhash: latestBlockhash.blockhash,
                lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
            });

            const explorerUrl = getExplorerUrl(signature, this.networkConfig.network);
            logger.audit('TRANSACTION_CONFIRMED', `Pump.fun SELL confirmed: ${amountTokens} tokens of ${mintAddress}`, {
                signature,
                mintAddress,
                explorer: explorerUrl,
            });

            return { success: true, signature };

        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.audit('ERROR', `Pump.fun SELL error: ${msg}`, { error: msg });
            return { success: false, error: msg };
        }
    }
}
