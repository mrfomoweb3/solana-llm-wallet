/**
 * executor.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Transaction execution pipeline:
 *   Build → Simulate → Sign → Send → Confirm
 *
 * THE SIMULATE-BEFORE-SIGN PRINCIPLE:
 *   Every transaction is simulated against the current on-chain state BEFORE
 *   the private key is used to sign it. This means:
 *
 *   • If the transaction would fail (bad account, wrong amount, program error),
 *     we catch it at zero cost — no SOL spent on failed transactions.
 *   • Simulation shows the exact account state changes that WOULD occur,
 *     letting us verify the expected output matches the LLM's intent.
 *   • If simulation fails for any reason, the transaction is ABORTED.
 *     The private key is never exposed for a transaction that would fail.
 *
 *   In production (mainnet), this is the difference between "I lost 0.1 SOL
 *   to a failed trade" and "I caught the issue before signing."
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  Connection,
  Transaction,
  VersionedTransaction,
  PublicKey,
  LAMPORTS_PER_SOL,
  SystemProgram,
  sendAndConfirmTransaction,
  TransactionMessage,
  AddressLookupTableAccount,
} from '@solana/web3.js';
import axios from 'axios';
import { logger } from './logger';
import { AgentCommand } from './guardrails';
import { AgentWallet } from './wallet';
import { getNetworkConfig, getExplorerUrl, NetworkConfig } from './network-config';
import { MarinadeService } from './marinade';
import { DCAService } from './dca';
import { PumpFunService } from './pumpfun';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ExecutionResult {
  success: boolean;
  signature?: string;
  error?: string;
  simulation?: SimulationResult;
}

export interface SimulationResult {
  success: boolean;
  logs: string[];
  unitsUsed?: number;
  error?: string;
}

// ─── Executor Class ───────────────────────────────────────────────────────────

export class TransactionExecutor {
  private wallet: AgentWallet;
  private connection: Connection;
  private networkConfig: NetworkConfig;

  constructor(wallet: AgentWallet) {
    this.wallet = wallet;
    this.connection = wallet.rpcConnection;
    this.networkConfig = getNetworkConfig(wallet.network);
  }

  /**
   * Main entry point: execute a validated AgentCommand.
   * Build → Simulate → Sign → Send
   */
  async execute(cmd: AgentCommand, resolvedAmountSOL?: number, pajPoolAddress?: string): Promise<ExecutionResult> {
    switch (cmd.action) {
      case 'swap':
        return this.executeSwap(cmd, resolvedAmountSOL);
      case 'transfer':
        return this.executeTransfer(cmd, resolvedAmountSOL);
      case 'swap_to_naira':
        return this.executeNairaSwap(cmd, resolvedAmountSOL, pajPoolAddress);
      case 'stake':
        return this.executeStake(cmd, resolvedAmountSOL);
      case 'unstake':
        return this.executeUnstake(cmd);
      case 'dca':
        return this.executeDCA(cmd, resolvedAmountSOL);
      case 'pump_buy':
        return this.executePumpBuy(cmd, resolvedAmountSOL);
      case 'pump_sell':
        return this.executePumpSell(cmd);
      case 'hold':
      case 'check_balance':
        logger.audit('AGENT_HOLD', `Action is ${cmd.action} — no transaction needed`, {
          reasoning: cmd.reasoning,
        });
        return { success: true };
      default:
        return { success: false, error: `Unknown action: ${cmd.action}` };
    }
  }

  // ── Swap via Jupiter ──────────────────────────────────────────────────────

  private async executeSwap(
    cmd: AgentCommand,
    resolvedAmountSOL?: number
  ): Promise<ExecutionResult> {
    const inputToken = cmd.params.inputToken ?? 'SOL';
    const outputToken = cmd.params.outputToken ?? 'USDC';
    const slippageBps = cmd.params.slippageBps ?? 50;
    const amountSOL = resolvedAmountSOL ?? cmd.params.amountSOL ?? 0;

    if (amountSOL <= 0) {
      return { success: false, error: 'Swap amount must be > 0' };
    }

    // Use network-specific token mints
    const inputMint = this.networkConfig.tokenMints[inputToken];
    const outputMint = this.networkConfig.tokenMints[outputToken];
    const amountLamports = Math.floor(amountSOL * LAMPORTS_PER_SOL);

    if (!inputMint || !outputMint) {
      return { success: false, error: `Unknown token: ${!inputMint ? inputToken : outputToken}` };
    }

    logger.info(`Building swap: ${amountSOL} ${inputToken} → ${outputToken} (slippage: ${slippageBps}bps) [${this.networkConfig.network}]`);

    try {
      // ── Step 1: Get Jupiter Quote ────────────────────────────────────
      logger.info('Fetching Jupiter quote...');
      const jupApiKey = process.env.JUPITER_API_KEY ?? '';

      let quote;
      try {
        const quoteRes = await axios.get(this.networkConfig.jupiterQuoteUrl, {
          params: {
            inputMint,
            outputMint,
            amount: amountLamports,
            slippageBps,
          },
          headers: { 'x-api-key': jupApiKey },
          timeout: 10_000,
        });
        quote = quoteRes.data;
      } catch (err: any) {
        logger.error(`Jupiter Quote API failed: ${err.message}`, { response: err.response?.data });
        return { success: false, error: `Quote API failed: ${err.response?.data?.error || err.message}` };
      }

      logger.info(`Quote received: ${amountSOL} ${inputToken} → ~${(Number(quote.outAmount) / 1_000_000).toFixed(2)} ${outputToken}`);

      // ── Step 2: Get Swap Transaction ─────────────────────────────────
      let swapTransaction;
      try {
        const swapRes = await axios.post(this.networkConfig.jupiterSwapUrl, {
          quoteResponse: quote,
          userPublicKey: this.wallet.publicKey.toString(),
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: 'auto',
        }, {
          timeout: 10_000,
          headers: { 'x-api-key': jupApiKey },
        });
        swapTransaction = swapRes.data.swapTransaction;
      } catch (err: any) {
        logger.error(`Jupiter Swap API failed: ${err.message}`, { response: err.response?.data });
        return { success: false, error: `Swap API failed: ${err.response?.data?.error || err.message}` };
      }

      // Deserialize the versioned transaction
      const txBuffer = Buffer.from(swapTransaction, 'base64');
      const transaction = VersionedTransaction.deserialize(txBuffer);

      // ── Step 3: SIMULATE BEFORE SIGN ─────────────────────────────────
      const simulation = await this.simulateVersioned(transaction);

      if (!simulation.success) {
        logger.audit('SIMULATION_FAIL', 'Swap simulation failed — transaction ABORTED', {
          error: simulation.error,
          logs: simulation.logs,
        });
        return { success: false, error: `Simulation failed: ${simulation.error}`, simulation };
      }

      logger.audit('SIMULATION_PASS', `Simulation succeeded (${simulation.unitsUsed} CUs)`, {
        logs: simulation.logs.slice(-5),
      });

      // ── Step 4: Sign & Send ───────────────────────────────────────────
      transaction.sign([this.wallet.keypair]);

      const signature = await this.connection.sendTransaction(transaction, {
        maxRetries: 3,
      });

      logger.audit('TRANSACTION_SENT', `Swap transaction sent: ${signature}`, { signature });

      // ── Step 5: Confirm ───────────────────────────────────────────────
      const confirmation = await this.connection.confirmTransaction(signature, 'confirmed');

      if (confirmation.value.err) {
        logger.audit('TRANSACTION_FAILED', 'Transaction confirmed but returned error', {
          signature,
          error: JSON.stringify(confirmation.value.err),
        });
        return {
          success: false,
          signature,
          error: JSON.stringify(confirmation.value.err),
          simulation,
        };
      }

      const explorerUrl = getExplorerUrl(signature, this.networkConfig.network);
      logger.audit('TRANSACTION_CONFIRMED', `✅ Swap confirmed on ${this.networkConfig.network}!`, {
        signature,
        explorer: explorerUrl,
      });

      return { success: true, signature, simulation };

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.audit('ERROR', `Swap execution error: ${msg}`, { error: msg });
      return { success: false, error: msg };
    }
  }

  // ── Transfer SOL ──────────────────────────────────────────────────────────

  private async executeTransfer(
    cmd: AgentCommand,
    resolvedAmountSOL?: number
  ): Promise<ExecutionResult> {
    const recipient = cmd.params.recipient;
    const amountSOL = resolvedAmountSOL ?? cmd.params.amountSOL ?? 0;

    if (!recipient) {
      return { success: false, error: 'Transfer requires a recipient address.' };
    }

    if (amountSOL <= 0) {
      return { success: false, error: 'Transfer amount must be > 0.' };
    }

    try {
      const recipientPubkey = new PublicKey(recipient);
      const lamports = Math.floor(amountSOL * LAMPORTS_PER_SOL);

      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: this.wallet.publicKey,
          toPubkey: recipientPubkey,
          lamports,
        })
      );

      // Set recent blockhash
      transaction.recentBlockhash = (
        await this.connection.getLatestBlockhash()
      ).blockhash;
      transaction.feePayer = this.wallet.publicKey;

      // ── Simulate Before Sign ─────────────────────────────────────────
      const simulation = await this.simulateLegacy(transaction);

      if (!simulation.success) {
        logger.audit('SIMULATION_FAIL', 'Transfer simulation failed — ABORTED', {
          error: simulation.error,
        });
        return { success: false, error: `Simulation failed: ${simulation.error}`, simulation };
      }

      logger.audit('SIMULATION_PASS', 'Transfer simulation passed', { ...simulation });

      // ── Sign & Send ───────────────────────────────────────────────────
      const signature = await sendAndConfirmTransaction(
        this.connection,
        transaction,
        [this.wallet.keypair],
        { commitment: 'confirmed' }
      );

      const explorerUrl = getExplorerUrl(signature, this.networkConfig.network);
      logger.audit('TRANSACTION_CONFIRMED', `Transfer confirmed: ${amountSOL} SOL → ${recipient}`, {
        signature,
        explorer: explorerUrl,
      });

      return { success: true, signature, simulation };

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.audit('ERROR', `Transfer error: ${msg}`, { error: msg });
      return { success: false, error: msg };
    }
  }

  // ── Naira Swap (transfer to PAJ TX Pool) ────────────────────────────────

  private async executeNairaSwap(
    cmd: AgentCommand,
    resolvedAmountSOL?: number,
    pajPoolAddress?: string
  ): Promise<ExecutionResult> {
    const amountSOL = resolvedAmountSOL ?? cmd.params.amountSOL ?? 0;

    if (!pajPoolAddress) {
      return { success: false, error: 'No PAJ TX Pool address configured. Use /setpool to set one.' };
    }

    if (amountSOL <= 0) {
      return { success: false, error: 'Amount must be > 0.' };
    }

    try {
      const poolPubkey = new PublicKey(pajPoolAddress);
      const lamports = Math.floor(amountSOL * LAMPORTS_PER_SOL);

      logger.info(`Naira swap: sending ${amountSOL} SOL to PAJ TX Pool ${pajPoolAddress}`);

      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: this.wallet.publicKey,
          toPubkey: poolPubkey,
          lamports,
        })
      );

      transaction.recentBlockhash = (
        await this.connection.getLatestBlockhash()
      ).blockhash;
      transaction.feePayer = this.wallet.publicKey;

      // ── Simulate Before Sign ─────────────────────────────────────────
      const simulation = await this.simulateLegacy(transaction);

      if (!simulation.success) {
        logger.audit('SIMULATION_FAIL', 'Naira swap simulation failed — ABORTED', {
          error: simulation.error,
        });
        return { success: false, error: `Simulation failed: ${simulation.error}`, simulation };
      }

      logger.audit('SIMULATION_PASS', 'Naira swap simulation passed', { ...simulation });

      // ── Sign & Send ───────────────────────────────────────────────
      const signature = await sendAndConfirmTransaction(
        this.connection,
        transaction,
        [this.wallet.keypair],
        { commitment: 'confirmed' }
      );

      const explorerUrl = getExplorerUrl(signature, this.networkConfig.network);
      logger.audit('TRANSACTION_CONFIRMED', `Naira swap confirmed: ${amountSOL} SOL → PAJ TX Pool`, {
        signature,
        pajPoolAddress,
        explorer: explorerUrl,
      });

      return { success: true, signature, simulation };

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.audit('ERROR', `Naira swap error: ${msg}`, { error: msg });
      return { success: false, error: msg };
    }
  }

  // ── Stake via Marinade ────────────────────────────────────────────────────

  private async executeStake(
    cmd: AgentCommand,
    resolvedAmountSOL?: number
  ): Promise<ExecutionResult> {
    const amountSOL = resolvedAmountSOL ?? cmd.params.amountSOL ?? 0;

    if (amountSOL <= 0) {
      return { success: false, error: 'Stake amount must be > 0.' };
    }

    try {
      const marinade = new MarinadeService(
        this.connection,
        this.wallet.keypair,
        this.networkConfig.network
      );
      const result = await marinade.stake(amountSOL);
      return {
        success: result.success,
        signature: result.signature,
        error: result.error,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg };
    }
  }

  // ── Unstake via Native Staking ──────────────────────────────────────────────

  private async executeUnstake(
    cmd: AgentCommand
  ): Promise<ExecutionResult> {
    try {
      const marinade = new MarinadeService(
        this.connection,
        this.wallet.keypair,
        this.networkConfig.network
      );
      const result = await marinade.unstake();

      if (result.success && result.amountUnstaked && result.amountUnstaked > 0) {
        return {
          success: true,
          signature: result.signature,
          error: undefined,
        };
      }

      // Deactivation initiated but no withdrawal yet
      if (result.success && result.error) {
        return {
          success: true,
          signature: result.signature,
          error: result.error,
        };
      }

      return {
        success: result.success,
        signature: result.signature,
        error: result.error,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg };
    }
  }

  // ── DCA via Jupiter ───────────────────────────────────────────────────────

  private async executeDCA(
    cmd: AgentCommand,
    resolvedAmountSOL?: number
  ): Promise<ExecutionResult> {
    const totalAmount = resolvedAmountSOL ?? cmd.params.amountSOL ?? 0;
    const inputToken = cmd.params.inputToken ?? 'SOL';
    const outputToken = cmd.params.outputToken ?? 'USDC';
    const numOrders = (cmd.params as any).numOrders ?? 5;
    const intervalDays = (cmd.params as any).intervalDays ?? 1;

    if (totalAmount <= 0) {
      return { success: false, error: 'DCA amount must be > 0.' };
    }

    try {
      const dca = new DCAService(
        this.connection,
        this.wallet.keypair,
        this.networkConfig.network
      );
      const intervalSec = intervalDays * 86400;
      const result = await dca.createDCA(inputToken, outputToken, totalAmount, numOrders, intervalSec);
      return {
        success: result.success,
        signature: result.signature,
        error: result.error,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg };
    }
  }

  // ── Pump.fun Buy ──────────────────────────────────────────────────────────

  private async executePumpBuy(
    cmd: AgentCommand,
    resolvedAmountSOL?: number
  ): Promise<ExecutionResult> {
    const amountSOL = resolvedAmountSOL ?? cmd.params.amountSOL ?? 0;
    const mintAddress = (cmd.params as any).mintAddress;

    if (!mintAddress) {
      return { success: false, error: 'Pump.fun buy requires a token mint address.' };
    }
    if (amountSOL <= 0) {
      return { success: false, error: 'Buy amount must be > 0.' };
    }

    try {
      const pump = new PumpFunService(
        this.connection,
        this.wallet.keypair,
        this.networkConfig.network
      );
      const result = await pump.buyToken(mintAddress, amountSOL);
      return {
        success: result.success,
        signature: result.signature,
        error: result.error,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg };
    }
  }

  // ── Pump.fun Sell ─────────────────────────────────────────────────────────

  private async executePumpSell(cmd: AgentCommand): Promise<ExecutionResult> {
    const amountTokens = cmd.params.amountSOL ?? 0; // LLM puts amount in amountSOL
    const mintAddress = (cmd.params as any).mintAddress;

    if (!mintAddress) {
      return { success: false, error: 'Pump.fun sell requires a token mint address.' };
    }
    if (amountTokens <= 0) {
      return { success: false, error: 'Sell amount must be > 0.' };
    }

    try {
      const pump = new PumpFunService(
        this.connection,
        this.wallet.keypair,
        this.networkConfig.network
      );
      const result = await pump.sellToken(mintAddress, amountTokens);
      return {
        success: result.success,
        signature: result.signature,
        error: result.error,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg };
    }
  }

  // ── Simulation Helpers ────────────────────────────────────────────────────

  /**
   * Simulate a legacy (non-versioned) transaction.
   */
  private async simulateLegacy(tx: Transaction): Promise<SimulationResult> {
    try {
      const result = await this.connection.simulateTransaction(tx);
      return {
        success: !result.value.err,
        logs: result.value.logs ?? [],
        unitsUsed: result.value.unitsConsumed ?? undefined,
        error: result.value.err ? JSON.stringify(result.value.err) : undefined,
      };
    } catch (err) {
      return { success: false, logs: [], error: String(err) };
    }
  }

  /**
   * Simulate a versioned transaction (Jupiter returns these).
   */
  private async simulateVersioned(tx: VersionedTransaction): Promise<SimulationResult> {
    try {
      // Fetch address lookup table accounts needed by this transaction
      const altAccounts: AddressLookupTableAccount[] = [];
      for (const msg of [tx.message]) {
        if ('addressTableLookups' in msg) {
          for (const lookup of msg.addressTableLookups) {
            const account = await this.connection.getAddressLookupTable(lookup.accountKey);
            if (account.value) altAccounts.push(account.value);
          }
        }
      }

      const result = await this.connection.simulateTransaction(tx, {
        sigVerify: false,
        replaceRecentBlockhash: true,
      });

      return {
        success: !result.value.err,
        logs: result.value.logs ?? [],
        unitsUsed: result.value.unitsConsumed ?? undefined,
        error: result.value.err ? JSON.stringify(result.value.err) : undefined,
      };
    } catch (err) {
      return { success: false, logs: [], error: String(err) };
    }
  }
}
