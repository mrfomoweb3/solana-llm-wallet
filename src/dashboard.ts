/**
 * dashboard.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Terminal dashboard for observing the agent in real time.
 * Shows wallet state, current price, last LLM decision, and recent audit log.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import chalk from 'chalk';
import { WalletState } from './wallet';
import { PriceData } from './price-feed';
import { AgentCommand } from './guardrails';
import { ExecutionResult } from './executor';

// ─── Box Drawing ──────────────────────────────────────────────────────────────

const W = 62; // box width
const line = chalk.gray('─'.repeat(W));
const topBar = chalk.gray('┌' + '─'.repeat(W) + '┐');
const botBar = chalk.gray('└' + '─'.repeat(W) + '┘');
const divider = chalk.gray('├' + '─'.repeat(W) + '┤');

function row(label: string, value: string, color = chalk.white): string {
  const labelPad = label.padEnd(18);
  const valueTrunc = value.substring(0, W - 20);
  const rowContent = ` ${chalk.gray(labelPad)} ${color(valueTrunc)}`;
  return chalk.gray('│') + rowContent.padEnd(W + 10) + chalk.gray('│');
}

function header(title: string): string {
  const padded = ` ${title} `;
  const total = W - padded.length;
  const left = Math.floor(total / 2);
  const right = total - left;
  return chalk.gray('│') + chalk.gray('─'.repeat(left)) + chalk.bold.cyan(padded) + chalk.gray('─'.repeat(right)) + chalk.gray('│');
}

// ─── Render Functions ─────────────────────────────────────────────────────────

export function renderDashboard(
  wallet: WalletState,
  price: PriceData,
  lastCmd?: AgentCommand,
  lastResult?: ExecutionResult,
  iteration?: number
): void {
  // Clear previous dashboard (move cursor up)
  process.stdout.write('\x1B[2J\x1B[0f');

  const priceColor = price.priceChange24h >= 0 ? chalk.green : chalk.red;
  const priceSymbol = price.priceChange24h >= 0 ? '▲' : '▼';

  console.log(topBar);
  console.log(header('🤖 SOLANA LLM WALLET AGENT'));
  console.log(divider);
  console.log(header('WALLET'));
  console.log(row('Address', wallet.publicKey.substring(0, 32) + '...', chalk.yellow));
  console.log(row('SOL Balance', `${wallet.solBalance.toFixed(6)} SOL`, chalk.green));
  console.log(row('USDC Balance', `${wallet.usdcBalance.toFixed(2)} USDC`, chalk.green));
  console.log(row('Updated', wallet.lastUpdated));
  console.log(divider);
  console.log(header('MARKET'));
  console.log(row('SOL Price', `$${price.solPriceUSD.toFixed(2)} USD`, chalk.yellow));
  console.log(row('24h Change', `${priceSymbol} ${Math.abs(price.priceChange24h).toFixed(2)}%`, priceColor));
  console.log(row('Source', price.source));

  if (lastCmd) {
    console.log(divider);
    console.log(header('LAST LLM DECISION'));
    const actionColor = lastCmd.action === 'hold' ? chalk.gray
      : lastCmd.action === 'swap' ? chalk.green
        : chalk.yellow;
    console.log(row('Action', lastCmd.action.toUpperCase(), actionColor));
    console.log(row('Reasoning', lastCmd.reasoning.substring(0, 50) + (lastCmd.reasoning.length > 50 ? '…' : '')));

    if (lastCmd.params.conditionMet !== undefined) {
      const condColor = lastCmd.params.conditionMet ? chalk.green : chalk.gray;
      console.log(row('Condition', lastCmd.params.conditionMet ? 'MET ✅' : 'NOT MET ⏸', condColor));
    }
  }

  if (lastResult) {
    console.log(divider);
    console.log(header('LAST EXECUTION'));
    if (lastResult.signature) {
      console.log(row('Tx Signature', lastResult.signature.substring(0, 40) + '...', chalk.green));
      console.log(row('Explorer', 'solana.com/tx/...?cluster=devnet', chalk.blue));
    } else if (lastResult.error) {
      console.log(row('Error', lastResult.error.substring(0, 50), chalk.red));
    } else {
      console.log(row('Status', 'No action taken', chalk.gray));
    }
  }

  console.log(divider);
  console.log(row('Iteration', String(iteration ?? 0), chalk.cyan));
  console.log(row('Network', (wallet.network ?? 'devnet').toUpperCase(), chalk.yellow));
  console.log(row('Audit Log', 'audit.log.jsonl'));
  console.log(botBar);
  console.log();
}

export function renderBanner(): void {
  console.log(chalk.bold.cyan(`
╔═══════════════════════════════════════════════════════════╗
║          🤖 SOLANA LLM WALLET AGENT — DEVNET              ║
║          Autonomous. Guarded. Auditable.                   ║
╚═══════════════════════════════════════════════════════════╝
`));
}

export function renderSeparator(label?: string): void {
  if (label) {
    const padded = ` ${label} `;
    const total = 60 - padded.length;
    const left = Math.floor(total / 2);
    const right = total - left;
    console.log(chalk.gray('─'.repeat(left) + padded + '─'.repeat(right)));
  } else {
    console.log(chalk.gray('─'.repeat(60)));
  }
}
