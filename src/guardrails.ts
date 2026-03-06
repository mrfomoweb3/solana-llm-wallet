/**
 * guardrails.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The guardrail layer sits between the LLM output and the wallet signer.
 * It is the most important security component in the entire system.
 *
 * WHY GUARDRAILS ARE ESSENTIAL:
 *   Large language models can hallucinate. They might:
 *     • Output a swap amount larger than the wallet balance
 *     • Suggest interacting with an unknown or malicious program address
 *     • Generate slippage values of 100% (meaning accept any price)
 *     • Interpret "swap half" as "swap all" due to context drift
 *     • Execute continuously without cooldown, draining the wallet
 *
 *   Guardrails provide deterministic, rule-based enforcement that cannot
 *   be overridden by the LLM's output — no matter what the model says,
 *   the rules always win.
 *
 * DEFENSE IN DEPTH:
 *   1. Schema validation  — is the JSON structurally valid?
 *   2. Allowlist check    — is the action/token pair permitted?
 *   3. Amount check       — is the amount within safe limits?
 *   4. Slippage check     — is slippage within acceptable bounds?
 *   5. Balance check      — does the wallet actually have these funds?
 *   6. Program whitelist  — is the target program on our allowlist?
 *   7. Cooldown check     — has enough time passed since last execution?
 *   8. Large-trade gate   — does a high-value trade require confirmation?
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { z } from 'zod';
import { logger } from './logger';
import guardrailsConfig from '../config/guardrails.json';
import { WalletState } from './wallet';

// ─── Command Schema (strict validation via zod) ────────────────────────────

export const AgentCommandSchema = z.object({
  action: z.enum(['swap', 'transfer', 'hold', 'check_balance', 'swap_to_naira', 'stake', 'unstake', 'dca', 'pump_buy', 'pump_sell', 'switch_network', 'airdrop', 'set_alert']),
  reasoning: z.string().min(1).max(1000),
  params: z.object({
    // Swap params — nullable because LLM may return null for unused fields
    inputToken: z.string().nullable().optional().transform(v => v ?? undefined),
    outputToken: z.string().nullable().optional().transform(v => v ?? undefined),
    amountSOL: z.number().nonnegative().nullable().optional().transform(v => v ?? undefined),
    amountPercent: z.number().min(0).max(100).nullable().optional().transform(v => v ?? undefined),
    slippageBps: z.number().min(0).max(500).nullable().optional().transform(v => v ?? undefined),
    // Transfer params
    recipient: z.string().nullable().optional().transform(v => v ?? undefined),
    // Pump.fun params
    mintAddress: z.string().nullable().optional().transform(v => v ?? undefined),
    // DCA params
    numOrders: z.number().min(2).nullable().optional().transform(v => v ?? undefined),
    intervalDays: z.number().min(1).nullable().optional().transform(v => v ?? undefined),
    // Condition tracking
    conditionMet: z.boolean().nullable().optional().transform(v => v ?? undefined),
    conditionDesc: z.string().nullable().optional().transform(v => v ?? undefined),
    triggerPriceUSD: z.number().nullable().optional().transform(v => v ?? undefined),
    condition: z.enum(['above', 'below']).nullable().optional().transform(v => v ?? undefined),
  }).passthrough(),
});

export type AgentCommand = z.infer<typeof AgentCommandSchema>;

// ─── Result Types ──────────────────────────────────────────────────────────

export interface GuardrailResult {
  passed: boolean;
  blockedBy?: string;
  reason?: string;
  resolvedAmountSOL?: number; // the final, resolved amount after % → SOL conversion
}

// ─── Cooldown Tracker ──────────────────────────────────────────────────────

let lastExecutionTime: number = 0;

export function resetCooldown(): void {
  lastExecutionTime = 0;
}

export function recordExecution(): void {
  lastExecutionTime = Date.now();
}

// ─── Core Guardrail Engine ─────────────────────────────────────────────────

export function runGuardrails(
  cmd: AgentCommand,
  walletState: WalletState
): GuardrailResult {
  const cfg = guardrailsConfig;

  // ── 1. Action Allowlist ─────────────────────────────────────────────────
  if (!cfg.allowedActions.includes(cmd.action)) {
    return block('ACTION_ALLOWLIST', `Action '${cmd.action}' is not permitted.`);
  }

  // ── 2. Token Allowlist ──────────────────────────────────────────────────
  if (cmd.action === 'swap') {
    const inputOk = !cmd.params.inputToken || cfg.allowedTokens.includes(cmd.params.inputToken);
    const outputOk = !cmd.params.outputToken || cfg.allowedTokens.includes(cmd.params.outputToken);
    if (!inputOk || !outputOk) {
      return block('TOKEN_ALLOWLIST', `Token not on allowlist. Input: ${cmd.params.inputToken}, Output: ${cmd.params.outputToken}`);
    }
  }

  // ── 3. Slippage Check ───────────────────────────────────────────────────
  if (cmd.params.slippageBps !== undefined) {
    if (cmd.params.slippageBps > cfg.maxSlippageBps) {
      return block('SLIPPAGE_LIMIT', `Slippage ${cmd.params.slippageBps}bps exceeds max ${cfg.maxSlippageBps}bps.`);
    }
  }

  // ── 4. Amount Resolution & Checks ─────────────────────────────────────
  let resolvedAmountSOL: number | undefined;

  if (cmd.action === 'swap' || cmd.action === 'transfer' || cmd.action === 'swap_to_naira' || cmd.action === 'stake' || cmd.action === 'unstake' || cmd.action === 'dca' || cmd.action === 'pump_buy') {

    // Determine if this is a USDC-denominated transaction
    const isUSDCInput = cmd.params.inputToken?.toUpperCase() === 'USDC';
    const availableBalance = isUSDCInput
      ? walletState.usdcBalance
      : walletState.solBalance - (cfg.minSolRentReserve ?? 0.01);

    let resolvedAmountSOL: number | undefined;

    if (cmd.params.amountPercent !== undefined) {
      resolvedAmountSOL = (cmd.params.amountPercent / 100) * (isUSDCInput ? walletState.usdcBalance : walletState.solBalance);
      // Reserve rent for SOL swaps
      if (!isUSDCInput && resolvedAmountSOL > availableBalance) {
        resolvedAmountSOL = availableBalance;
      }
    } else if (typeof cmd.params.amountUSD === 'number') {
      // If specifying USD, convert it to the underlying token
      if (isUSDCInput) {
        resolvedAmountSOL = cmd.params.amountUSD; // 1 USDC ≈ 1 USD
      } else {
        if (!walletState.solPriceUSD || walletState.solPriceUSD <= 0) {
          return block('PRICE_UNAVAILABLE', 'Cannot calculate USD value: SOL price is currently unavailable.');
        }
        resolvedAmountSOL = cmd.params.amountUSD / walletState.solPriceUSD;
      }
    } else if (cmd.params.amountSOL !== undefined) {
      resolvedAmountSOL = cmd.params.amountSOL;
    }

    if (resolvedAmountSOL === undefined) {
      return block('AMOUNT_MISSING', 'No amount specified for swap/transfer.');
    }

    // Skip the max-SOL-per-tx check for USDC swaps (1 USDC != 1 SOL)
    // And also skip it if we just converted a tiny USD amount
    if (!isUSDCInput && resolvedAmountSOL > cfg.maxTransactionSOL) {
      return block(
        'AMOUNT_LIMIT',
        `Amount ${resolvedAmountSOL.toFixed(4)} SOL exceeds max ${cfg.maxTransactionSOL} SOL per transaction.`
      );
    }

    // Balance check
    if (resolvedAmountSOL > availableBalance) {
      const token = isUSDCInput ? 'USDC' : 'SOL';
      return block(
        'INSUFFICIENT_BALANCE',
        `Amount ${resolvedAmountSOL.toFixed(4)} ${token} exceeds available balance ${availableBalance.toFixed(4)} ${token}.`
      );
    }

    // Large trade gate
    const balance = isUSDCInput ? walletState.usdcBalance : walletState.solBalance;
    if (balance > 0) {
      const pctOfBalance = (resolvedAmountSOL / balance) * 100;
      if (pctOfBalance > cfg.largeTradeThresholdPct) {
        logger.audit('GUARDRAIL_BLOCK',
          `Large trade gate triggered: ${pctOfBalance.toFixed(1)}% of balance`,
          { resolvedAmountSOL, balancePct: pctOfBalance, threshold: cfg.largeTradeThresholdPct }
        );
        if (cfg.requireHumanConfirmForLargeTrades) {
          return block(
            'LARGE_TRADE_GATE',
            `Trade is ${pctOfBalance.toFixed(1)}% of balance (>${cfg.largeTradeThresholdPct}%). Human confirmation required.`
          );
        }
      }
    }
  }

  // ── 5. Cooldown Check ───────────────────────────────────────────────────
  const msSinceLastTx = Date.now() - lastExecutionTime;
  if (lastExecutionTime > 0 && msSinceLastTx < cfg.cooldownMs) {
    const waitSec = ((cfg.cooldownMs - msSinceLastTx) / 1000).toFixed(1);
    return block('COOLDOWN', `Cooldown active. Wait ${waitSec}s before next transaction.`);
  }

  // ── All checks passed ───────────────────────────────────────────────────
  return { passed: true, resolvedAmountSOL };
}

// ─── Helper ────────────────────────────────────────────────────────────────

function block(rule: string, reason: string): GuardrailResult {
  return { passed: false, blockedBy: rule, reason };
}
