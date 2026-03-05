/**
 * dca.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Jupiter DCA (Dollar-Cost Averaging) service.
 * Creates on-chain DCA positions that automatically execute recurring swaps.
 *
 * Uses @jup-ag/dca-sdk for transaction building.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
    Connection,
    Keypair,
    LAMPORTS_PER_SOL,
    PublicKey,
    sendAndConfirmTransaction,
} from '@solana/web3.js';
import { DCA, Network } from '@jup-ag/dca-sdk';
import { logger } from './logger';
import { getExplorerUrl, NetworkConfig, getNetworkConfig } from './network-config';

// ─── Token Mints ────────────────────────────────────────────────────────────

const SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
const USDC_MINT_MAINNET = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const USDC_MINT_DEVNET = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DCAResult {
    success: boolean;
    signature?: string;
    dcaPublicKey?: string;
    error?: string;
}

// ─── DCA Service ────────────────────────────────────────────────────────────

export class DCAService {
    private connection: Connection;
    private wallet: Keypair;
    private networkConfig: NetworkConfig;
    private dca: DCA;

    constructor(connection: Connection, wallet: Keypair, network: string) {
        this.connection = connection;
        this.wallet = wallet;
        this.networkConfig = getNetworkConfig(network as any);

        const dcaNetwork = network === 'mainnet-beta' ? Network.MAINNET : Network.DEVNET;
        this.dca = new DCA(connection, dcaNetwork);
    }

    /**
     * Create a DCA position.
     * @param inputToken  - Token to sell (e.g., 'USDC' or 'SOL')
     * @param outputToken - Token to buy (e.g., 'SOL' or 'USDC')
     * @param totalAmount - Total amount to invest (in input token units)
     * @param numOrders   - Number of recurring orders
     * @param intervalSec - Interval between orders in seconds (default: 86400 = 1 day)
     */
    async createDCA(
        inputToken: string,
        outputToken: string,
        totalAmount: number,
        numOrders: number,
        intervalSec: number = 86400,
    ): Promise<DCAResult> {
        if (totalAmount <= 0) {
            return { success: false, error: 'DCA amount must be > 0.' };
        }
        if (numOrders < 2) {
            return { success: false, error: 'DCA requires at least 2 orders.' };
        }

        try {
            const inputMint = this._resolveMint(inputToken);
            const outputMint = this._resolveMint(outputToken);

            if (!inputMint || !outputMint) {
                return { success: false, error: `Unknown token: ${!inputMint ? inputToken : outputToken}` };
            }

            // Calculate amount in smallest units
            const isSOLInput = inputToken.toUpperCase() === 'SOL';
            const inAmount = BigInt(Math.floor(
                isSOLInput ? totalAmount * LAMPORTS_PER_SOL : totalAmount * 1_000_000
            ));

            const perOrderAmount = inAmount / BigInt(numOrders);

            logger.info(`Creating DCA: ${totalAmount} ${inputToken} → ${outputToken}, ${numOrders} orders, every ${intervalSec}s`);

            const { tx, dcaPubKey } = await this.dca.createDcaV2({
                payer: this.wallet.publicKey,
                user: this.wallet.publicKey,
                inAmount,
                inAmountPerCycle: perOrderAmount,
                cycleSecondsApart: BigInt(intervalSec),
                inputMint,
                outputMint,
                minOutAmountPerCycle: null,
                maxOutAmountPerCycle: null,
                startAt: null,
            });

            // Simulate first
            const simulation = await this.connection.simulateTransaction(tx);
            if (simulation.value.err) {
                return { success: false, error: `Simulation failed: ${JSON.stringify(simulation.value.err)}` };
            }

            const signature = await sendAndConfirmTransaction(
                this.connection,
                tx,
                [this.wallet],
                { commitment: 'confirmed' }
            );

            const explorerUrl = getExplorerUrl(signature, this.networkConfig.network);
            logger.audit('TRANSACTION_CONFIRMED', `DCA created: ${totalAmount} ${inputToken} → ${outputToken}`, {
                signature,
                dcaPubKey: dcaPubKey.toString(),
                numOrders,
                intervalSec,
                explorer: explorerUrl,
            });

            return {
                success: true,
                signature,
                dcaPublicKey: dcaPubKey.toString(),
            };

        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.audit('ERROR', `DCA error: ${msg}`, { error: msg });
            return { success: false, error: msg };
        }
    }

    private _resolveMint(token: string): PublicKey | null {
        const t = token.toUpperCase();
        if (t === 'SOL') return SOL_MINT;
        if (t === 'USDC') {
            return this.networkConfig.network === 'mainnet-beta' ? USDC_MINT_MAINNET : USDC_MINT_DEVNET;
        }
        return null;
    }
}
