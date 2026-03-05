/**
 * bot.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Entry point for the Telegram bot.
 *
 * Usage: npm run bot
 *
 * Required environment variables:
 *   TELEGRAM_BOT_TOKEN — from @BotFather on Telegram
 *   GROQ_API_KEY        — from console.groq.com
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as dotenv from 'dotenv';
import { createTelegramBot } from './telegram-bot';
import { logger } from './logger';
import { getDefaultNetwork } from './network-config';

dotenv.config();

async function main(): Promise<void> {
    // Validate required env vars
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
        console.error('❌ TELEGRAM_BOT_TOKEN not set in .env');
        console.error('   Get one from @BotFather on Telegram: https://t.me/BotFather');
        process.exit(1);
    }

    if (!process.env.GROQ_API_KEY) {
        console.warn('⚠️  GROQ_API_KEY not set — LLM trading instructions will fail.');
        console.warn('   The bot will still work for wallet management commands.');
    }

    const defaultNetwork = getDefaultNetwork();

    console.log(`
╔═══════════════════════════════════════════════════════════╗
║       🤖 SOLANA LLM WALLET — TELEGRAM BOT                ║
║       Autonomous. Guarded. Auditable.                     ║
╠═══════════════════════════════════════════════════════════╣
║  Default Network: ${(defaultNetwork).padEnd(38)}║
║  Bot Status:      Starting...                             ║
╚═══════════════════════════════════════════════════════════╝
`);

    logger.audit('AGENT_START', 'Telegram bot starting', {
        defaultNetwork,
        model: 'claude-sonnet-4-6',
    });

    // Create & launch bot
    const bot = createTelegramBot(token);

    await bot.launch();

    console.log('✅ Bot is running! Send /start to your bot on Telegram.');
    console.log('   Press Ctrl+C to stop.\n');
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
