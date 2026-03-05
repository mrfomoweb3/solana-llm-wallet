/**
 * agent.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Main agent orchestration loop.
 *
 * THE FULL PIPELINE (every 30 seconds):
 *
 *   1. Fetch wallet state (SOL + USDC balances)
 *   2. Fetch current SOL price from Jupiter
 *   3. Send instruction + state to Claude
 *   4. Receive structured AgentCommand from Claude
 *   5. Run command through guardrail engine
 *      → If blocked: log reason, sleep, repeat
 *   6. Simulate transaction on-chain
 *      → If fails: log error, sleep, repeat
 *   7. Sign & send transaction
 *   8. Confirm & record in audit log
 *   9. Update dashboard
 *  10. Sleep until next cycle
 *
 * All steps 1–10 are logged to audit.log.jsonl for later debugging.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as readline from 'readline';
import * as dotenv from 'dotenv';
import chalk from 'chalk';

import { AgentWallet } from './wallet';
import { LLMBrain } from './llm';
import { runGuardrails, recordExecution } from './guardrails';
import { TransactionExecutor } from './executor';
import { getSOLPrice } from './price-feed';
import { logger } from './logger';
import { renderDashboard, renderBanner, renderSeparator } from './dashboard';
import { AgentCommand } from './guardrails';
import { ExecutionResult } from './executor';
import { getDefaultNetwork } from './network-config';

// ─── Bootstrap ────────────────────────────────────────────────────────────────

dotenv.config();

const POLL_INTERVAL_MS = 30_000; // 30 seconds between cycles

// ─── Main Agent Class ─────────────────────────────────────────────────────────

export class SolanaLLMAgent {
  private wallet: AgentWallet;
  private llm: LLMBrain;
  private executor: TransactionExecutor;
  private running: boolean = false;
  private iteration: number = 0;

  // State for dashboard
  private lastCmd?: AgentCommand;
  private lastResult?: ExecutionResult;

  constructor() {
    this.wallet = new AgentWallet(getDefaultNetwork());
    this.llm = new LLMBrain();
    this.executor = new TransactionExecutor(this.wallet);
  }

  // ── Startup ───────────────────────────────────────────────────────────────

  async start(instruction: string, password: string): Promise<void> {
    renderBanner();

    logger.audit('AGENT_START', 'Agent initializing', {
      instruction,
      network: this.wallet.network,
      model: 'claude-sonnet-4-6',
    });

    // Unlock wallet
    await this.wallet.unlock(password);

    this.running = true;
    this.registerShutdown();

    logger.info(`Agent started with instruction: "${instruction}"`);
    logger.info(`Polling every ${POLL_INTERVAL_MS / 1000}s. Press Ctrl+C to stop.\n`);

    // Main loop
    while (this.running) {
      try {
        await this.tick(instruction);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.audit('ERROR', `Unhandled error in agent loop: ${msg}`, { error: msg });
      }

      if (this.running) {
        await sleep(POLL_INTERVAL_MS);
      }
    }
  }

  // ── Single Tick ───────────────────────────────────────────────────────────

  private async tick(instruction: string): Promise<void> {
    this.iteration++;
    renderSeparator(`Cycle ${this.iteration}`);

    // ── 1. Fetch Wallet State ────────────────────────────────────────────
    const priceData = await getSOLPrice();
    const walletState = await this.wallet.getFullState(
      priceData.solPriceUSD,
      priceData.priceChange24h
    );

    logger.audit('WALLET_STATE_FETCHED', 'Wallet state refreshed', {
      solBalance: walletState.solBalance,
      usdcBalance: walletState.usdcBalance,
      solPrice: priceData.solPriceUSD,
    });

    // ── 2. Ask LLM ────────────────────────────────────────────────────────
    let cmd: AgentCommand;
    try {
      cmd = await this.llm.interpret(instruction, walletState, priceData);
    } catch (err) {
      logger.error('LLM call failed — skipping cycle', { error: String(err) });
      return;
    }

    this.lastCmd = cmd;

    if (cmd.action === 'hold' || cmd.action === 'check_balance') {
      logger.audit('AGENT_HOLD', `LLM decided to hold: ${cmd.reasoning}`, {
        reasoning: cmd.reasoning,
      });
      renderDashboard(walletState, priceData, cmd, this.lastResult, this.iteration);
      return;
    }

    // ── 3. Guardrail Check ────────────────────────────────────────────────
    const guardrailResult = runGuardrails(cmd, walletState);

    if (!guardrailResult.passed) {
      logger.audit('GUARDRAIL_BLOCK', `Blocked by ${guardrailResult.blockedBy}: ${guardrailResult.reason}`, {
        blockedBy: guardrailResult.blockedBy,
        reason: guardrailResult.reason,
        cmd,
      });
      renderDashboard(walletState, priceData, cmd, this.lastResult, this.iteration);
      return;
    }

    logger.audit('GUARDRAIL_PASS', 'All guardrail checks passed', {
      resolvedAmountSOL: guardrailResult.resolvedAmountSOL,
    });

    // ── 4. Execute ────────────────────────────────────────────────────────
    const result = await this.executor.execute(cmd, guardrailResult.resolvedAmountSOL);
    this.lastResult = result;

    if (result.success && result.signature) {
      recordExecution(); // reset cooldown timer
    }

    // ── 5. Update Dashboard ───────────────────────────────────────────────
    // Refresh wallet state for dashboard
    const updatedState = await this.wallet.getFullState(
      priceData.solPriceUSD,
      priceData.priceChange24h
    );

    renderDashboard(updatedState, priceData, cmd, result, this.iteration);
  }

  // ── Shutdown ──────────────────────────────────────────────────────────────

  private registerShutdown(): void {
    const shutdown = () => {
      logger.audit('AGENT_STOP', 'Agent shutting down gracefully');
      this.running = false;
      this.wallet.lock();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }
}

// ─── CLI Entry Point ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  dotenv.config();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  console.log(chalk.bold.cyan('\n🤖 Solana LLM Wallet Agent\n'));

  // Get instruction
  console.log(chalk.gray('Examples:'));
  console.log(chalk.gray('  "swap half my SOL for USDC if price drops 5%"'));
  console.log(chalk.gray('  "swap 0.1 SOL for USDC now"'));
  console.log(chalk.gray('  "transfer 0.05 SOL to <address>"'));
  console.log();

  const instruction = await question(chalk.cyan('Enter instruction: '));
  const password = await question(chalk.cyan('Enter wallet password: '));

  rl.close();

  if (!instruction.trim()) {
    console.error(chalk.red('No instruction provided.'));
    process.exit(1);
  }

  const agent = new SolanaLLMAgent();
  await agent.start(instruction.trim(), password);
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Run
main().catch((err) => {
  console.error(chalk.red('Fatal error:'), err);
  process.exit(1);
});
