/**
 * logger.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Structured audit logger with two outputs:
 *   1. Human-readable console output (chalk-colored)
 *   2. Append-only JSON audit log on disk (for post-trade debugging)
 *
 * The audit log is the single source of truth for:
 *   • Every instruction received
 *   • Every LLM decision + raw reasoning
 *   • Every guardrail check (pass or block)
 *   • Every simulation result
 *   • Every transaction sent (or rejected)
 *
 * This is what judges will evaluate for the "deep dive" section.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';

// ─── Types ────────────────────────────────────────────────────────────────────

export type AuditEventType =
  | 'AGENT_START'
  | 'INSTRUCTION_RECEIVED'
  | 'WALLET_STATE_FETCHED'
  | 'LLM_REQUEST'
  | 'LLM_RESPONSE'
  | 'GUARDRAIL_PASS'
  | 'GUARDRAIL_BLOCK'
  | 'SIMULATION_PASS'
  | 'SIMULATION_FAIL'
  | 'TRANSACTION_SENT'
  | 'TRANSACTION_CONFIRMED'
  | 'TRANSACTION_FAILED'
  | 'AGENT_HOLD'
  | 'PRICE_CONDITION_CHECK'
  | 'ERROR'
  | 'AGENT_STOP';

export interface AuditEntry {
  id:        string;
  timestamp: string;
  event:     AuditEventType;
  data:      Record<string, unknown>;
}

// ─── Logger ───────────────────────────────────────────────────────────────────

const LOG_PATH = path.resolve(process.cwd(), 'audit.log.jsonl');

let entryCount = 0;

function generateId(): string {
  entryCount++;
  return `evt_${Date.now()}_${entryCount.toString().padStart(4, '0')}`;
}

function writeAuditEntry(event: AuditEventType, data: Record<string, unknown>): AuditEntry {
  const entry: AuditEntry = {
    id:        generateId(),
    timestamp: new Date().toISOString(),
    event,
    data,
  };
  // Append-only — never overwrite
  fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n', 'utf8');
  return entry;
}

// ─── Console Formatters ───────────────────────────────────────────────────────

const EVENT_STYLES: Record<AuditEventType, (msg: string) => string> = {
  AGENT_START:            (m) => chalk.bold.green(`🚀 ${m}`),
  INSTRUCTION_RECEIVED:   (m) => chalk.bold.cyan(`📨 ${m}`),
  WALLET_STATE_FETCHED:   (m) => chalk.blue(`💰 ${m}`),
  LLM_REQUEST:            (m) => chalk.magenta(`🧠 ${m}`),
  LLM_RESPONSE:           (m) => chalk.magenta(`🧠 ${m}`),
  GUARDRAIL_PASS:         (m) => chalk.green(`✅ ${m}`),
  GUARDRAIL_BLOCK:        (m) => chalk.bold.red(`🛑 ${m}`),
  SIMULATION_PASS:        (m) => chalk.green(`🔬 ${m}`),
  SIMULATION_FAIL:        (m) => chalk.bold.yellow(`⚠️  ${m}`),
  TRANSACTION_SENT:       (m) => chalk.bold.yellow(`📤 ${m}`),
  TRANSACTION_CONFIRMED:  (m) => chalk.bold.green(`✅ ${m}`),
  TRANSACTION_FAILED:     (m) => chalk.bold.red(`❌ ${m}`),
  AGENT_HOLD:             (m) => chalk.gray(`⏸  ${m}`),
  PRICE_CONDITION_CHECK:  (m) => chalk.blue(`📊 ${m}`),
  ERROR:                  (m) => chalk.bold.red(`💥 ${m}`),
  AGENT_STOP:             (m) => chalk.gray(`🛑 ${m}`),
};

// ─── Public API ───────────────────────────────────────────────────────────────

export const logger = {
  info(message: string, data: Record<string, unknown> = {}): void {
    console.log(chalk.gray(`[${new Date().toISOString()}]`), chalk.white(message));
    if (Object.keys(data).length > 0) {
      console.log(chalk.gray(JSON.stringify(data, null, 2)));
    }
  },

  warn(message: string, data: Record<string, unknown> = {}): void {
    console.log(chalk.gray(`[${new Date().toISOString()}]`), chalk.yellow(`⚠  ${message}`));
    if (Object.keys(data).length > 0) {
      console.log(chalk.yellow(JSON.stringify(data, null, 2)));
    }
  },

  error(message: string, data: Record<string, unknown> = {}): void {
    console.log(chalk.gray(`[${new Date().toISOString()}]`), chalk.red(`✗  ${message}`));
    if (Object.keys(data).length > 0) {
      console.log(chalk.red(JSON.stringify(data, null, 2)));
    }
  },

  audit(event: AuditEventType, message: string, data: Record<string, unknown> = {}): AuditEntry {
    const style = EVENT_STYLES[event] ?? ((m: string) => m);
    console.log(chalk.gray(`[${new Date().toISOString()}]`), style(message));
    if (Object.keys(data).length > 0 && process.env.VERBOSE === 'true') {
      console.log(chalk.gray(JSON.stringify(data, null, 2)));
    }
    return writeAuditEntry(event, { message, ...data });
  },

  /**
   * Read back the audit log for debugging a specific trade.
   * Useful in the deep-dive write-up: "here is every step leading to tx XYZ"
   */
  readAuditLog(): AuditEntry[] {
    if (!fs.existsSync(LOG_PATH)) return [];
    return fs
      .readFileSync(LOG_PATH, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  },

  /**
   * Pretty-print the last N audit entries to the console.
   */
  printRecentAudit(n = 20): void {
    const entries = this.readAuditLog().slice(-n);
    console.log(chalk.bold('\n─── Recent Audit Log ───────────────────────────────'));
    for (const e of entries) {
      const style = EVENT_STYLES[e.event] ?? ((m: string) => m);
      const msg = (e.data as Record<string, string>).message ?? e.event;
      console.log(chalk.gray(e.timestamp), style(msg));
    }
    console.log(chalk.bold('────────────────────────────────────────────────────\n'));
  },
};
