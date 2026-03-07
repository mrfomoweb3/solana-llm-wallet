/**
 * marinade.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Solana native staking service.
 * Stake and unstake SOL by creating/managing stake accounts.
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
    Transaction,
} from '@solana/web3.js';
import { logger } from './logger';
import { getExplorerUrl, NetworkConfig, getNetworkConfig } from './network-config';

// ─── Validators ─────────────────────────────────────────────────────────────

// Preferred mainnet validators (fallback if dynamic fetch fails)
const MAINNET_VALIDATOR_FALLBACK = new PublicKey('7Sys29UqSSRwRe3arFKgBiKT7g5rAMKFTMESFqaBHEYV');

/**
 * Fetch a real, active vote account from the cluster.
 * This avoids IncorrectProgramId errors caused by stale/invalid hardcoded validators.
 */
async function getActiveValidator(connection: Connection, network: string): Promise<PublicKey> {
    try {
        const voteAccounts = await connection.getVoteAccounts('confirmed');
        const active = voteAccounts.current;
        if (active.length > 0) {
            active.sort((a, b) => b.activatedStake - a.activatedStake);
            const picked = active[0];
            logger.info(`Selected validator: ${picked.votePubkey} (stake: ${(picked.activatedStake / LAMPORTS_PER_SOL).toFixed(0)} SOL)`);
            return new PublicKey(picked.votePubkey);
        }
    } catch (err) {
        logger.error('Failed to fetch vote accounts, using fallback', { error: err });
    }
    if (network === 'mainnet-beta') return MAINNET_VALIDATOR_FALLBACK;
    throw new Error('No active validators found on this network.');
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface StakeResult {
    success: boolean;
    signature?: string;
    stakeAccount?: string;
    error?: string;
}

export interface UnstakeResult {
    success: boolean;
    signature?: string;
    amountUnstaked?: number;
    accountsClosed?: number;
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

            const stakeAccount = Keypair.generate();
            const validatorVote = await getActiveValidator(this.connection, network);
            const rentExemption = await this.connection.getMinimumBalanceForRentExemption(200);
            const totalLamports = lamports + rentExemption;

            const createStakeAccountTx = StakeProgram.createAccount({
                fromPubkey: this.wallet.publicKey,
                stakePubkey: stakeAccount.publicKey,
                authorized: new Authorized(
                    this.wallet.publicKey,
                    this.wallet.publicKey,
                ),
                lamports: totalLamports,
            });

            const delegateTx = StakeProgram.delegate({
                stakePubkey: stakeAccount.publicKey,
                authorizedPubkey: this.wallet.publicKey,
                votePubkey: validatorVote,
            });

            const transaction = createStakeAccountTx;
            transaction.add(...delegateTx.instructions);

            transaction.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;
            transaction.feePayer = this.wallet.publicKey;

            const simulation = await this.connection.simulateTransaction(transaction);
            if (simulation.value.err) {
                return { success: false, error: `Simulation failed: ${JSON.stringify(simulation.value.err)}` };
            }
            logger.info('🔬 Stake simulation passed');

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

    /**
     * Unstake SOL — deactivate and withdraw from stake accounts.
     *
     * Finds all stake accounts owned by this wallet, deactivates active ones,
     * and withdraws SOL from deactivated/inactive ones back to the wallet.
     * Works on both devnet and mainnet.
     */
    async unstake(): Promise<UnstakeResult> {
        try {
            const network = this.networkConfig.network;
            logger.info(`Unstaking SOL on ${network}`);

            // Find all stake accounts where this wallet is the withdrawer
            const stakeAccounts = await this.connection.getParsedProgramAccounts(
                StakeProgram.programId,
                {
                    filters: [
                        { dataSize: 200 },
                        {
                            memcmp: {
                                offset: 12,
                                bytes: this.wallet.publicKey.toBase58(),
                            },
                        },
                    ],
                }
            );

            if (stakeAccounts.length === 0) {
                return { success: false, error: 'No stake accounts found for this wallet. Nothing to unstake.' };
            }

            logger.info(`Found ${stakeAccounts.length} stake account(s)`);

            let totalUnstaked = 0;
            let accountsClosed = 0;
            let lastSignature = '';
            let deactivatedCount = 0;

            for (const account of stakeAccounts) {
                const stakeAccountPubkey = account.pubkey;
                const balance = account.account.lamports;
                const balanceSOL = balance / LAMPORTS_PER_SOL;

                const parsedData = account.account.data as any;
                const stakeState = parsedData?.parsed?.type ?? 'unknown';
                const stakeInfo = parsedData?.parsed?.info?.stake;

                logger.info(`Stake account ${stakeAccountPubkey.toString().substring(0, 12)}... — ${balanceSOL.toFixed(4)} SOL — state: ${stakeState}`);

                try {
                    const transaction = new Transaction();

                    if (stakeState === 'delegated') {
                        const deactivationEpoch = stakeInfo?.delegation?.deactivationEpoch;
                        const epochInfo = await this.connection.getEpochInfo();
                        const maxEpoch = '18446744073709551615'; // u64::MAX means not deactivated
                        const isAlreadyDeactivating = deactivationEpoch && deactivationEpoch !== maxEpoch;
                        const isFullyDeactivated = isAlreadyDeactivating && Number(deactivationEpoch) < epochInfo.epoch;

                        if (isFullyDeactivated) {
                            // Already deactivated and cooldown passed — just withdraw
                            transaction.add(
                                StakeProgram.withdraw({
                                    stakePubkey: stakeAccountPubkey,
                                    authorizedPubkey: this.wallet.publicKey,
                                    toPubkey: this.wallet.publicKey,
                                    lamports: balance,
                                }).instructions[0]
                            );
                            totalUnstaked += balanceSOL;
                            accountsClosed++;
                            logger.info(`  → Withdrawing ${balanceSOL.toFixed(4)} SOL (fully deactivated)`);
                        } else if (!isAlreadyDeactivating) {
                            // Active delegation — deactivate it
                            transaction.add(
                                StakeProgram.deactivate({
                                    stakePubkey: stakeAccountPubkey,
                                    authorizedPubkey: this.wallet.publicKey,
                                }).instructions[0]
                            );
                            deactivatedCount++;
                            logger.info(`  → Deactivating stake account (will be withdrawable next epoch)`);
                        } else {
                            // Currently deactivating, not yet withdrawable
                            logger.info(`  → Already deactivating, waiting for epoch ${Number(deactivationEpoch) + 1}`);
                            continue;
                        }
                    } else if (stakeState === 'initialized' || stakeState === 'inactive') {
                        // Not delegated — can withdraw immediately
                        transaction.add(
                            StakeProgram.withdraw({
                                stakePubkey: stakeAccountPubkey,
                                authorizedPubkey: this.wallet.publicKey,
                                toPubkey: this.wallet.publicKey,
                                lamports: balance,
                            }).instructions[0]
                        );
                        totalUnstaked += balanceSOL;
                        accountsClosed++;
                        logger.info(`  → Withdrawing ${balanceSOL.toFixed(4)} SOL (${stakeState})`);
                    } else {
                        logger.info(`  → Skipping account in state: ${stakeState}`);
                        continue;
                    }

                    if (transaction.instructions.length === 0) continue;

                    transaction.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;
                    transaction.feePayer = this.wallet.publicKey;

                    const simulation = await this.connection.simulateTransaction(transaction);
                    if (simulation.value.err) {
                        logger.error(`Simulation failed for ${stakeAccountPubkey.toString().substring(0, 12)}: ${JSON.stringify(simulation.value.err)}`);
                        continue;
                    }

                    const sig = await sendAndConfirmTransaction(
                        this.connection,
                        transaction,
                        [this.wallet],
                        { commitment: 'confirmed' }
                    );
                    lastSignature = sig;

                    logger.audit('TRANSACTION_CONFIRMED', `Unstake action on ${stakeAccountPubkey.toString().substring(0, 12)}...`, {
                        signature: sig,
                        stakeAccount: stakeAccountPubkey.toString(),
                        amountSOL: balanceSOL,
                    });

                } catch (err: unknown) {
                    const msg = err instanceof Error ? err.message : String(err);
                    logger.error(`Failed to unstake account ${stakeAccountPubkey.toString().substring(0, 12)}: ${msg}`);
                }
            }

            // Return results
            if (totalUnstaked > 0) {
                return {
                    success: true,
                    signature: lastSignature,
                    amountUnstaked: totalUnstaked,
                    accountsClosed,
                };
            }

            if (deactivatedCount > 0) {
                return {
                    success: true,
                    amountUnstaked: 0,
                    accountsClosed: 0,
                    error: `Deactivated ${deactivatedCount} stake account(s). Your SOL will be withdrawable after the current epoch ends. Run "unstake" again after that to withdraw.`,
                };
            }

            return {
                success: false,
                error: `Found ${stakeAccounts.length} stake account(s) but none could be processed right now. They may be in a cooldown period.`,
            };

        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.audit('ERROR', `Unstake error: ${msg}`, { error: msg });
            return { success: false, error: msg };
        }
    }
}
