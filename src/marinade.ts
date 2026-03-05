/**
 * marinade.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Solana native staking service.
 * Stake SOL by creating a stake account and delegating to a validator.
 *
 * Uses @solana/web3.js StakeProgram helpers for correct instruction encoding.
 * Works on both devnet and mainnet.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
    Connection,
    Keypair,
    LAMPORTS_PER_SOL,
    PublicKey,
    StakeProgram,
    Authorized,
    sendAndConfirmTransaction,
} from '@solana/web3.js';
import { logger } from './logger';
import { getExplorerUrl, NetworkConfig, getNetworkConfig } from './network-config';

// ─── Validators ─────────────────────────────────────────────────────────────

// Well-known validators for delegation
const VALIDATORS: Record<string, PublicKey> = {
    'devnet': new PublicKey('agjKQFnqMYGifVTcvzMRaZzDPFAqG8yLPMJVsGKwkqM'),
    'mainnet-beta': new PublicKey('7Sys29UqSSRwRe3arFKgBiKT7g5rAMKFTMESFqaBHEYV'), // Marinade validator
};

// ─── Types ──────────────────────────────────────────────────────────────────

export interface StakeResult {
    success: boolean;
    signature?: string;
    stakeAccount?: string;
    error?: string;
}

// ─── Marinade Service ───────────────────────────────────────────────────────

export class MarinadeService {
    private connection: Connection;
    private wallet: Keypair;
    private networkConfig: NetworkConfig;

    constructor(connection: Connection, wallet: Keypair, network: string) {
        this.connection = connection;
        this.wallet = wallet;
        this.networkConfig = getNetworkConfig(network as any);
    }

    /**
     * Stake SOL via native Solana staking.
     * Creates a stake account and delegates to a validator.
     */
    async stake(amountSOL: number): Promise<StakeResult> {
        if (amountSOL <= 0) {
            return { success: false, error: 'Stake amount must be > 0.' };
        }

        try {
            const lamports = Math.floor(amountSOL * LAMPORTS_PER_SOL);
            const network = this.networkConfig.network;

            logger.info(`Staking ${amountSOL} SOL via native staking on ${network}`);

            // Generate a new stake account keypair
            const stakeAccount = Keypair.generate();

            // Get the validator vote account to delegate to
            const validatorVote = VALIDATORS[network];
            if (!validatorVote) {
                return { success: false, error: `No known validator for network: ${network}` };
            }

            // Create stake account with rent-exempt minimum + stake amount
            const createStakeAccountTx = StakeProgram.createAccount({
                fromPubkey: this.wallet.publicKey,
                stakePubkey: stakeAccount.publicKey,
                authorized: new Authorized(
                    this.wallet.publicKey, // staker
                    this.wallet.publicKey, // withdrawer
                ),
                lamports,
            });

            // Delegate the stake account to the validator
            const delegateTx = StakeProgram.delegate({
                stakePubkey: stakeAccount.publicKey,
                authorizedPubkey: this.wallet.publicKey,
                votePubkey: validatorVote,
            });

            // Combine into one transaction
            const transaction = createStakeAccountTx;
            transaction.add(...delegateTx.instructions);

            // Simulate
            transaction.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;
            transaction.feePayer = this.wallet.publicKey;

            const simulation = await this.connection.simulateTransaction(transaction);
            if (simulation.value.err) {
                return { success: false, error: `Simulation failed: ${JSON.stringify(simulation.value.err)}` };
            }
            logger.info('🔬 Stake simulation passed');

            // Send
            const signature = await sendAndConfirmTransaction(
                this.connection,
                transaction,
                [this.wallet, stakeAccount],
                { commitment: 'confirmed' }
            );

            const explorerUrl = getExplorerUrl(signature, this.networkConfig.network);
            logger.audit('TRANSACTION_CONFIRMED', `Staked ${amountSOL} SOL → validator ${validatorVote.toString().substring(0, 12)}...`, {
                signature,
                stakeAccount: stakeAccount.publicKey.toString(),
                validator: validatorVote.toString(),
                explorer: explorerUrl,
            });

            return {
                success: true,
                signature,
                stakeAccount: stakeAccount.publicKey.toString(),
            };

        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.audit('ERROR', `Stake error: ${msg}`, { error: msg });
            return { success: false, error: msg };
        }
    }
}
