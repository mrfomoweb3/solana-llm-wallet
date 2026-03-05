/**
 * telegram-bot.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Telegram bot interface for the Solana LLM Wallet Agent.
 *
 * Users interact via Telegram commands and natural language messages.
 * Each user gets their own wallet, session, and can choose devnet/mainnet.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import { UserStore } from './user-store';
import { getSOLPrice } from './price-feed';
import { runGuardrails, recordExecution } from './guardrails';
import { logger } from './logger';
import { getExplorerUrl, getAddressExplorerUrl } from './network-config';
import { generateReceipt, ReceiptData } from './receipt';

// ── Telegram Markdown escape helper ──────────────────────────────────────────
// Escapes special chars that break Telegram's Markdown parser
function escMd(text: string): string {
    return text.replace(/([_*`\[\]])/g, '\\$1');
}

// Safe message edit: tries Markdown, falls back to plain text on parse error
async function safeEditMsg(
    telegram: Telegraf['telegram'],
    chatId: number,
    msgId: number,
    text: string,
): Promise<void> {
    try {
        await telegram.editMessageText(chatId, msgId, undefined, text, { parse_mode: 'Markdown' });
    } catch {
        // Strip markdown formatting and send as plain text
        const plain = text.replace(/[_*`\[\]]/g, '');
        try {
            await telegram.editMessageText(chatId, msgId, undefined, plain);
        } catch { /* give up silently */ }
    }
}

// ─── Create Bot ───────────────────────────────────────────────────────────────

export function createTelegramBot(token: string): Telegraf {
    const bot = new Telegraf(token);
    const store = new UserStore();

    // Track users awaiting private key export confirmation
    const pendingExportConfirm = new Set<number>();

    // ── Register command menu (visible in Telegram UI) ────────────────────────
    bot.telegram.setMyCommands([
        { command: 'start', description: '👋 Welcome & getting started' },
        { command: 'create', description: '🔑 Create a new wallet' },
        { command: 'import', description: '📥 Import wallet from private key' },
        { command: 'unlock', description: '🔓 Unlock your wallet' },
        { command: 'lock', description: '🔒 Lock wallet & clear keys' },
        { command: 'balance', description: '💰 Check SOL & USDC balances' },
        { command: 'airdrop', description: '💧 Request devnet SOL airdrop' },
        { command: 'stake', description: '🪨 Stake SOL' },
        { command: 'dca', description: '📈 Set up DCA order' },
        { command: 'pump', description: '🚀 Buy/sell on Pump.fun' },
        { command: 'network', description: '🌐 Switch devnet/mainnet' },
        { command: 'setpool', description: '🏦 Set PAJ TX Pool address' },
        { command: 'pool', description: '📋 View PAJ TX Pool address' },
        { command: 'export', description: '📍 Show public key & explorer link' },
        { command: 'exportkey', description: '🔐 Export private key (secure)' },
        { command: 'help', description: '📋 List all commands' },
    ]);

    // ── /start ──────────────────────────────────────────────────────────────

    bot.command('start', async (ctx) => {
        const network = store.getUserNetwork(ctx.chat.id);
        await ctx.reply(
            `🤖 *Solana LLM Wallet Agent*\n\n` +
            `Welcome! I'm an AI-powered Solana wallet that can execute trades based on your natural language instructions.\n\n` +
            `🌐 *Current Network:* \`${network}\`\n\n` +
            `*Getting Started:*\n` +
            `1️⃣ /create \`<password>\` — Create a new wallet\n` +
            `2️⃣ /import \`<privateKey> <password>\` — Import existing wallet\n` +
            `3️⃣ /unlock \`<password>\` — Unlock your wallet\n` +
            `4️⃣ Send me any trading instruction!\n\n` +
            `*Examples:*\n` +
            `• _"swap 0.1 SOL for USDC"_\n` +
            `• _"transfer 0.05 SOL to <address>"_\n` +
            `• _"swap 0.5 SOL to naira"_\n` +
            `• _"check my balance"_\n\n` +
            `Type /help to see all commands.`,
            { parse_mode: 'Markdown' }
        );
    });

    // ── /help ───────────────────────────────────────────────────────────────

    bot.command('help', async (ctx) => {
        await ctx.reply(
            `📋 *Available Commands*\n\n` +
            `🔑 *Wallet Management:*\n` +
            `/create \`<password>\` — Create new wallet\n` +
            `/import \`<privateKey> <password>\` — Import wallet from private key\n` +
            `/unlock \`<password>\` — Unlock existing wallet\n` +
            `/lock — Lock wallet & clear keys\n` +
            `/export — Show wallet info (public key + explorer)\n` +
            `/exportkey — Export private key (with security confirmation)\n\n` +
            `💰 *Trading:*\n` +
            `/balance — Check SOL & USDC balances\n` +
            `/airdrop — Request devnet SOL airdrop\n` +
            `Just type any instruction in plain English!\n\n` +
            `🪨 *Staking:*\n` +
            `/stake \`<amount>\` — Stake SOL\n` +
            `_"stake 0.5 SOL"_ — via natural language\n\n` +
            `📈 *Jupiter DCA:*\n` +
            `/dca \`<amount> <orders> <days>\` — Set up DCA\n` +
            `_"DCA 1 SOL into USDC over 5 days"_\n\n` +
            `🚀 *Pump.fun (mainnet only):*\n` +
            `/pump \`buy <mint> <amount>\` — Buy token\n` +
            `/pump \`sell <mint> <amount>\` — Sell token\n\n` +
            `🏦 *Naira Off-Ramp:*\n` +
            `/setpool \`<address>\` — Set PAJ TX Pool address\n` +
            `/pool — View current PAJ TX Pool address\n\n` +
            `🌐 *Network:*\n` +
            `/network \`<devnet|mainnet>\` — Switch network\n\n` +
            `⚡ *Examples:*\n` +
            `• _"swap 0.1 SOL for USDC"_\n` +
            `• _"stake half my SOL"_\n` +
            `• _"DCA 1 SOL into USDC over 5 days"_\n` +
            `• _"swap 0.5 SOL to naira"_`,
            { parse_mode: 'Markdown' }
        );
    });

    // ── /create <password> ──────────────────────────────────────────────────

    bot.command('create', async (ctx) => {
        const chatId = ctx.chat.id;

        // Try to delete the message containing the password
        try { await ctx.deleteMessage(); } catch { /* may lack permissions */ }

        const args = ctx.message.text.split(' ').slice(1).join(' ').trim();
        if (!args) {
            await ctx.reply(
                '⚠️ Please provide a password:\n`/create YourSecurePassword123`\n\n' +
                '_Your message will be auto-deleted for security._',
                { parse_mode: 'Markdown' }
            );
            return;
        }

        if (args.length < 8) {
            await ctx.reply('❌ Password must be at least 8 characters.');
            return;
        }

        const network = store.getUserNetwork(chatId);

        if (store.hasKeystore(chatId)) {
            await ctx.reply(
                `⚠️ You already have a wallet on *${network}*.\n` +
                `Use /unlock to access it, or switch networks with /network.`,
                { parse_mode: 'Markdown' }
            );
            return;
        }

        const statusMsg = await ctx.reply('⏳ Generating keypair and encrypting...');

        try {
            const result = await store.createWallet(chatId, args);

            let response =
                `✅ *Wallet Created!*\n\n` +
                `🌐 *Network:* \`${network}\`\n` +
                `🔑 *Public Key:*\n\`${result.publicKey}\`\n\n` +
                `🔗 [View on Explorer](${getAddressExplorerUrl(result.publicKey, network)})`;

            // Airdrop on devnet
            if (network === 'devnet') {
                try {
                    const session = store.getSession(chatId);
                    if (session) {
                        await session.wallet.requestAirdrop(2);
                        response += `\n\n💧 *Airdrop:* 2 SOL delivered to your devnet wallet!`;
                    }
                } catch {
                    response += `\n\n⚠️ Devnet airdrop failed (rate limited). Try again later.`;
                }
            }

            response += `\n\n🔒 _Your password was auto-deleted. Remember it — it cannot be recovered!_`;

            await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, response, { parse_mode: 'Markdown' });

            // Send recovery code as a SEPARATE auto-deleting message
            const recoveryMsg = await ctx.reply(
                `🔐 *RECOVERY CODE — SAVE THIS!*\n\n` +
                `\`${result.recoveryCode}\`\n\n` +
                `If you forget your password, use:\n` +
                `\`/recover ${result.recoveryCode} NewPassword\`\n\n` +
                `⚠️ _This message will auto-delete in 60 seconds._`,
                { parse_mode: 'Markdown' }
            );

            // Auto-delete recovery code message after 60 seconds
            setTimeout(async () => {
                try { await ctx.telegram.deleteMessage(chatId, recoveryMsg.message_id); } catch { }
            }, 60000);

        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, `❌ Failed to create wallet: ${msg}`);
        }
    });

    // ── /import <privateKey> <password> ─────────────────────────────────────

    bot.command('import', async (ctx) => {
        const chatId = ctx.chat.id;

        // SECURITY: Delete message immediately — it contains a private key!
        try { await ctx.deleteMessage(); } catch { /* may lack permissions */ }

        const args = ctx.message.text.split(' ').slice(1);
        if (args.length < 2) {
            await ctx.reply(
                '⚠️ *Import Wallet*\n\n' +
                'Usage: `/import <privateKey> <password>`\n\n' +
                'Example:\n`/import 5K3d...base58key YourSecurePassword123`\n\n' +
                '⚠️ _Your message will be auto-deleted for security. Never share your private key!_',
                { parse_mode: 'Markdown' }
            );
            return;
        }

        const privateKey = args[0];
        const password = args.slice(1).join(' ').trim();

        if (password.length < 8) {
            await ctx.reply('❌ Password must be at least 8 characters.');
            return;
        }

        const network = store.getUserNetwork(chatId);

        if (store.hasKeystore(chatId)) {
            await ctx.reply(
                `⚠️ You already have a wallet on *${network}*.\n` +
                `Use /unlock to access it, or switch networks with /network.`,
                { parse_mode: 'Markdown' }
            );
            return;
        }

        const statusMsg = await ctx.reply('⏳ Importing wallet and encrypting...');

        try {
            const pubkey = await store.importWallet(chatId, privateKey, password);

            await ctx.telegram.editMessageText(
                ctx.chat.id,
                statusMsg.message_id,
                undefined,
                `✅ *Wallet Imported!*\n\n` +
                `🌐 *Network:* \`${network}\`\n` +
                `🔑 *Public Key:*\n\`${pubkey}\`\n\n` +
                `🔗 [View on Explorer](${getAddressExplorerUrl(pubkey, network)})\n\n` +
                `🔒 _Your private key and password have been auto-deleted from chat._`,
                { parse_mode: 'Markdown' }
            );
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            await ctx.telegram.editMessageText(
                ctx.chat.id,
                statusMsg.message_id,
                undefined,
                `❌ Import failed: ${msg}`
            );
        }
    });

    // ── /recover <recoveryCode> <newPassword> ───────────────────────────────

    bot.command('recover', async (ctx) => {
        const chatId = ctx.chat.id;

        // Delete the message immediately (contains recovery code + password)
        try { await ctx.deleteMessage(); } catch { /* may lack permissions */ }

        const args = ctx.message.text.split(' ').slice(1);
        if (args.length < 2) {
            await ctx.reply(
                '⚠️ Usage:\n`/recover ORE-XXXX-XXXX NewPassword`\n\n' +
                '_Resets your wallet password using your recovery code._\n' +
                '_Your message will be auto-deleted for security._',
                { parse_mode: 'Markdown' }
            );
            return;
        }

        const recoveryCode = args[0];
        const newPassword = args.slice(1).join(' ');

        if (!store.hasKeystore(chatId)) {
            await ctx.reply('❌ No wallet found. Use /create to make one first.');
            return;
        }

        const statusMsg = await ctx.reply('🔑 Verifying recovery code...');

        try {
            const pubkey = await store.recoverWallet(chatId, recoveryCode, newPassword);

            await ctx.telegram.editMessageText(
                ctx.chat.id,
                statusMsg.message_id,
                undefined,
                `✅ *Password Reset Successful!*\n\n` +
                `🔑 *Wallet:* \`${pubkey.substring(0, 16)}...\`\n` +
                `🔒 Your wallet is now protected with the new password.\n\n` +
                `Use \`/unlock NewPassword\` to access your wallet.\n\n` +
                `⚠️ _A new recovery code was generated. Note: you'll see it the next time you recreate or the old recovery code may still work if you didn't change it._`,
                { parse_mode: 'Markdown' }
            );
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            await ctx.telegram.editMessageText(
                ctx.chat.id,
                statusMsg.message_id,
                undefined,
                `❌ Recovery failed: ${msg}`
            );
        }
    });

    // ── /unlock <password> ──────────────────────────────────────────────────

    bot.command('unlock', async (ctx) => {
        const chatId = ctx.chat.id;

        // Delete the password message
        try { await ctx.deleteMessage(); } catch { /* may lack permissions */ }

        const args = ctx.message.text.split(' ').slice(1).join(' ').trim();
        if (!args) {
            await ctx.reply(
                '⚠️ Please provide your password:\n`/unlock YourPassword`\n\n' +
                '_Your message will be auto-deleted for security._',
                { parse_mode: 'Markdown' }
            );
            return;
        }

        if (store.hasSession(chatId)) {
            await ctx.reply('✅ Your wallet is already unlocked!');
            return;
        }

        const network = store.getUserNetwork(chatId);

        if (!store.hasKeystore(chatId)) {
            await ctx.reply('❌ No wallet found. Use /create or /import to set one up.');
            return;
        }

        const statusMsg = await ctx.reply('🔓 Unlocking wallet...');

        try {
            const pubkey = await store.unlockWallet(chatId, args);
            await ctx.telegram.editMessageText(
                ctx.chat.id,
                statusMsg.message_id,
                undefined,
                `✅ *Wallet Unlocked!*\n\n` +
                `🌐 *Network:* \`${network}\`\n` +
                `🔑 *Address:* \`${pubkey}\`\n\n` +
                `Send me a trading instruction or use /balance to check your funds.`,
                { parse_mode: 'Markdown' }
            );
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            await ctx.telegram.editMessageText(
                ctx.chat.id,
                statusMsg.message_id,
                undefined,
                `❌ Unlock failed: ${msg}`
            );
        }
    });

    // ── /lock ───────────────────────────────────────────────────────────────

    bot.command('lock', async (ctx) => {
        const locked = store.lockSession(ctx.chat.id);
        if (locked) {
            await ctx.reply('🔒 Wallet locked. Key material cleared from memory.');
        } else {
            await ctx.reply('ℹ️ No active session to lock.');
        }
    });

    // ── /balance ────────────────────────────────────────────────────────────

    bot.command('balance', async (ctx) => {
        const session = store.getSession(ctx.chat.id);
        if (!session) {
            await ctx.reply('🔒 Wallet is locked. Use /unlock first.');
            return;
        }

        const statusMsg = await ctx.reply('💰 Fetching balances...');

        try {
            const priceData = await getSOLPrice();
            const state = await session.wallet.getFullState(priceData.solPriceUSD, priceData.priceChange24h);

            const priceSymbol = priceData.priceChange24h >= 0 ? '📈' : '📉';
            const priceSign = priceData.priceChange24h >= 0 ? '+' : '';

            await ctx.telegram.editMessageText(
                ctx.chat.id,
                statusMsg.message_id,
                undefined,
                `💰 *Wallet Balance*\n\n` +
                `🌐 *Network:* \`${session.network}\`\n` +
                `🔑 *Address:* \`${state.publicKey.substring(0, 20)}...\`\n\n` +
                `◎ *SOL:* \`${state.solBalance.toFixed(6)}\`\n` +
                `💵 *USDC:* \`${state.usdcBalance.toFixed(2)}\`\n\n` +
                `${priceSymbol} *SOL Price:* $${priceData.solPriceUSD.toFixed(2)} (${priceSign}${priceData.priceChange24h.toFixed(2)}% 24h)\n` +
                `📊 *Portfolio:* ~$${(state.solBalance * priceData.solPriceUSD + state.usdcBalance).toFixed(2)} USD`,
                { parse_mode: 'Markdown' }
            );
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            await ctx.telegram.editMessageText(
                ctx.chat.id,
                statusMsg.message_id,
                undefined,
                `❌ Failed to fetch balance: ${msg}`
            );
        }
    });

    // ── /airdrop ─────────────────────────────────────────────────────────────

    bot.command('airdrop', async (ctx) => {
        const session = store.getSession(ctx.chat.id);
        if (!session) {
            await ctx.reply('🔒 Wallet is locked. Use /unlock first.');
            return;
        }

        if (session.network !== 'devnet') {
            await ctx.reply('❌ Airdrop is only available on *devnet*.\nSwitch with /network `devnet`', { parse_mode: 'Markdown' });
            return;
        }

        const statusMsg = await ctx.reply('💧 Requesting devnet SOL airdrop...');

        try {
            const sig = await session.wallet.requestAirdrop(2);
            await ctx.telegram.editMessageText(
                ctx.chat.id,
                statusMsg.message_id,
                undefined,
                `💧 *Airdrop Successful!*\n\n` +
                `2 SOL has been delivered to your devnet wallet.\n` +
                `📝 *Signature:* \`${sig.substring(0, 30)}...\``,
                { parse_mode: 'Markdown' }
            );
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            await ctx.telegram.editMessageText(
                ctx.chat.id,
                statusMsg.message_id,
                undefined,
                `❌ Airdrop failed: ${msg}\n\n_Devnet airdrops are rate-limited. Try again in a few seconds._`,
                { parse_mode: 'Markdown' }
            );
        }
    });

    // ── /network <devnet|mainnet> ───────────────────────────────────────────

    bot.command('network', async (ctx) => {
        const chatId = ctx.chat.id;
        const args = ctx.message.text.split(' ').slice(1).join(' ').trim().toLowerCase();

        if (!args) {
            const current = store.getUserNetwork(chatId);
            await ctx.reply(
                `🌐 *Current Network:* \`${current}\`\n\n` +
                `To switch: /network \`devnet\` or /network \`mainnet\``,
                { parse_mode: 'Markdown' }
            );
            return;
        }

        let network: 'devnet' | 'mainnet-beta';
        if (args === 'devnet') {
            network = 'devnet';
        } else if (args === 'mainnet' || args === 'mainnet-beta') {
            network = 'mainnet-beta';
        } else {
            await ctx.reply('❌ Invalid network. Use `devnet` or `mainnet`.', { parse_mode: 'Markdown' });
            return;
        }

        const currentNetwork = store.getUserNetwork(chatId);
        if (currentNetwork === network) {
            await ctx.reply(`ℹ️ Already on \`${network}\`.`, { parse_mode: 'Markdown' });
            return;
        }

        store.setUserNetwork(chatId, network);

        const hasWallet = store.hasKeystore(chatId, network);

        let response =
            `✅ *Switched to ${network}*\n\n`;

        if (network === 'mainnet-beta') {
            response += `⚠️ *WARNING:* You are now on mainnet. Real funds will be used!\n\n`;
        }

        if (hasWallet) {
            response += `You have an existing wallet on this network.\nUse /unlock to access it.`;
        } else {
            response += `No wallet found on this network.\nUse /create or /import to set one up.`;
        }

        await ctx.reply(response, { parse_mode: 'Markdown' });
    });

    // ── /setpool <address> ──────────────────────────────────────────────────

    bot.command('setpool', async (ctx) => {
        const chatId = ctx.chat.id;
        const args = ctx.message.text.split(' ').slice(1).join(' ').trim();

        if (!args) {
            await ctx.reply(
                '🏦 *Set PAJ TX Pool Address*\n\n' +
                'Usage: `/setpool <solana-address>`\n\n' +
                'This address is used for Naira off-ramp swaps.\n' +
                'When you say _"swap SOL to naira"_, your crypto will be sent to this pool address.',
                { parse_mode: 'Markdown' }
            );
            return;
        }

        try {
            store.setPajPoolAddress(chatId, args);
            await ctx.reply(
                `✅ *PAJ TX Pool Address Set!*\n\n` +
                `🏦 *Address:*\n\`${args}\`\n\n` +
                `You can now use Naira off-ramp:\n_"swap 0.5 SOL to naira"_`,
                { parse_mode: 'Markdown' }
            );
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            await ctx.reply(`❌ ${msg}`);
        }
    });

    // ── /pool ──────────────────────────────────────────────────────────────

    bot.command('pool', async (ctx) => {
        const chatId = ctx.chat.id;
        const poolAddr = store.getPajPoolAddress(chatId);

        if (poolAddr) {
            await ctx.reply(
                `🏦 *Your PAJ TX Pool*\n\n` +
                `📍 *Address:*\n\`${poolAddr}\`\n\n` +
                `To change: /setpool \`<new-address>\``,
                { parse_mode: 'Markdown' }
            );
        } else {
            await ctx.reply(
                '❌ No PAJ TX Pool address set.\n\n' +
                'Use /setpool `<address>` to set one for Naira off-ramp.',
                { parse_mode: 'Markdown' }
            );
        }
    });

    // ── /stake <amount> ───────────────────────────────────────────────────

    bot.command('stake', async (ctx) => {
        const session = store.getSession(ctx.chat.id);
        if (!session) { await ctx.reply('🔒 Wallet is locked. Use /unlock first.'); return; }

        const args = ctx.message.text.split(' ').slice(1).join(' ').trim();
        const amount = parseFloat(args);

        if (!args || isNaN(amount) || amount <= 0) {
            await ctx.reply(
                '🪨 *Stake SOL*\n\nUsage: `/stake <amount>`\nExample: `/stake 0.5`',
                { parse_mode: 'Markdown' }
            );
            return;
        }

        const statusMsg = await ctx.reply(`⚡ Staking ${amount} SOL...`);
        const result = await session.executor.execute(
            { action: 'stake', reasoning: 'Manual stake command', params: { amountSOL: amount } } as any,
            amount
        );

        const response = result.success
            ? `✅ *Staked ${amount} SOL!*\n\n🔗 [View Transaction](${result.signature ? getExplorerUrl(result.signature, session.network) : ''})`
            : `❌ *Stake Failed:* ${escMd(result.error ?? '')}`;

        await safeEditMsg(ctx.telegram, ctx.chat.id, statusMsg.message_id, response);
    });

    // ── /dca <amount> <orders> <intervalDays> ──────────────────────────

    bot.command('dca', async (ctx) => {
        const session = store.getSession(ctx.chat.id);
        if (!session) { await ctx.reply('🔒 Wallet is locked. Use /unlock first.'); return; }

        const parts = ctx.message.text.split(' ').slice(1);
        const amount = parseFloat(parts[0]);
        const orders = parseInt(parts[1]) || 5;
        const intervalDays = parseInt(parts[2]) || 1;

        if (isNaN(amount) || amount <= 0) {
            await ctx.reply(
                '📈 *Jupiter DCA*\n\n' +
                'Usage: `/dca <totalSOL> <numOrders> <intervalDays>`\n' +
                'Example: `/dca 1 5 1` (1 SOL → USDC, 5 orders, daily)\n\n' +
                '_Min: $100 total, 2 orders, $50/order_',
                { parse_mode: 'Markdown' }
            );
            return;
        }

        const statusMsg = await ctx.reply(`📈 Setting up DCA: ${amount} SOL → USDC, ${orders} orders...`);
        const result = await session.executor.execute(
            { action: 'dca', reasoning: 'Manual DCA command', params: { amountSOL: amount, inputToken: 'SOL', outputToken: 'USDC', numOrders: orders, intervalDays } } as any,
            amount
        );

        const response = result.success
            ? `✅ *DCA Position Created!*\n\n📈 ${amount} SOL → USDC\n📅 ${orders} orders, every ${intervalDays} day(s)\n🔗 [View Transaction](${result.signature ? getExplorerUrl(result.signature, session.network) : ''})`
            : `❌ *DCA Failed:* ${escMd(result.error ?? '')}`;

        await safeEditMsg(ctx.telegram, ctx.chat.id, statusMsg.message_id, response);
    });

    // ── /pump buy|sell <mint> <amount> ───────────────────────────────

    bot.command('pump', async (ctx) => {
        const session = store.getSession(ctx.chat.id);
        if (!session) { await ctx.reply('🔒 Wallet is locked. Use /unlock first.'); return; }

        const parts = ctx.message.text.split(' ').slice(1);
        const action = parts[0]?.toLowerCase();
        const mint = parts[1];
        const amount = parseFloat(parts[2]);

        if (!action || !mint || (action === 'buy' && (isNaN(amount) || amount <= 0))) {
            await ctx.reply(
                '🚀 *Pump.fun Trading*\n\n' +
                'Usage:\n' +
                '`/pump buy <mint> <amountSOL>`\n' +
                '`/pump sell <mint> <amountTokens>`\n\n' +
                'Example: `/pump buy ABC123... 0.1`\n' +
                '_Mainnet only_',
                { parse_mode: 'Markdown' }
            );
            return;
        }

        if (action === 'buy') {
            const statusMsg = await ctx.reply(`🚀 Buying ${amount} SOL of \`${mint.substring(0, 12)}...\``);
            const result = await session.executor.execute(
                { action: 'pump_buy', reasoning: 'Manual pump buy', params: { amountSOL: amount, mintAddress: mint } } as any,
                amount
            );
            const response = result.success
                ? `✅ *Pump.fun Buy Successful!*\n\n🚀 Bought with ${amount} SOL\n🔗 [View TX](${result.signature ? getExplorerUrl(result.signature, session.network) : ''})`
                : `❌ *Pump.fun Buy Failed:* ${escMd(result.error ?? '')}`;
            await safeEditMsg(ctx.telegram, ctx.chat.id, statusMsg.message_id, response);
        } else if (action === 'sell') {
            const sellAmount = isNaN(amount) ? 0 : amount;
            const statusMsg = await ctx.reply(`🚀 Selling tokens of \`${mint.substring(0, 12)}...\``);
            const result = await session.executor.execute(
                { action: 'pump_sell', reasoning: 'Manual pump sell', params: { amountSOL: sellAmount, mintAddress: mint } } as any
            );
            const response = result.success
                ? `✅ *Pump.fun Sell Successful!*\n\n🔗 [View TX](${result.signature ? getExplorerUrl(result.signature, session.network) : ''})`
                : `❌ *Pump.fun Sell Failed:* ${escMd(result.error ?? '')}`;
            await safeEditMsg(ctx.telegram, ctx.chat.id, statusMsg.message_id, response);
        } else {
            await ctx.reply('❌ Use `/pump buy` or `/pump sell`.', { parse_mode: 'Markdown' });
        }
    });

    // ── /export (public key only) ───────────────────────────────────────────

    bot.command('export', async (ctx) => {
        const chatId = ctx.chat.id;
        const session = store.getSession(chatId);

        if (session) {
            const pubkey = session.wallet.publicKey.toString();
            await ctx.reply(
                `🔑 *Your Wallet*\n\n` +
                `🌐 *Network:* \`${session.network}\`\n` +
                `📍 *Public Key:*\n\`${pubkey}\`\n\n` +
                `🔗 [View on Explorer](${getAddressExplorerUrl(pubkey, session.network)})\n\n` +
                `💡 _To export your private key, use /exportkey_`,
                { parse_mode: 'Markdown' }
            );
            return;
        }

        const pubkey = store.getStoredPublicKey(chatId);
        if (pubkey) {
            const network = store.getUserNetwork(chatId);
            await ctx.reply(
                `🔑 *Your Wallet (locked)*\n\n` +
                `🌐 *Network:* \`${network}\`\n` +
                `📍 *Public Key:*\n\`${pubkey}\`\n\n` +
                `🔗 [View on Explorer](${getAddressExplorerUrl(pubkey, network)})\n\n` +
                `_Use /unlock to access your wallet._`,
                { parse_mode: 'Markdown' }
            );
        } else {
            await ctx.reply('❌ No wallet found. Use /create or /import to set one up.');
        }
    });

    // ── /exportkey (private key with security flow) ─────────────────────────

    bot.command('exportkey', async (ctx) => {
        const chatId = ctx.chat.id;
        const session = store.getSession(chatId);

        if (!session) {
            await ctx.reply('🔒 Wallet is locked. Use /unlock first before exporting your private key.');
            return;
        }

        // Show security disclaimer with confirmation button
        await ctx.reply(
            `⚠️ *SECURITY WARNING* ⚠️\n\n` +
            `You are about to reveal your *private key*.\n\n` +
            `🚨 *NEVER share your private key with anyone!*\n` +
            `🚨 Anyone with your private key can *steal all your funds*.\n` +
            `🚨 No admin, support, or bot will ever ask for it.\n` +
            `🚨 The private key will be shown once and the message will be deleted when you confirm.\n\n` +
            `If you understand the risks and want to proceed, type:\n` +
            `\`CONFIRM EXPORT\`\n\n` +
            `_To cancel, just send any other message or command._`,
            { parse_mode: 'Markdown' }
        );

        pendingExportConfirm.add(chatId);
    });

    // ── Handle callback: Export confirmation ────────────────────────────────

    // This is handled in the text message handler below

    // ── Natural Language Messages (Trading Instructions) ────────────────────

    bot.on(message('text'), async (ctx) => {
        const chatId = ctx.chat.id;
        const text = ctx.message.text.trim();

        // Ignore messages that look like commands
        if (text.startsWith('/')) return;

        // ── Handle export confirmation ────────────────────────────────────────
        if (pendingExportConfirm.has(chatId)) {
            pendingExportConfirm.delete(chatId);

            if (text === 'CONFIRM EXPORT') {
                const session = store.getSession(chatId);
                if (!session) {
                    await ctx.reply('🔒 Session expired. Use /unlock and try again.');
                    return;
                }

                try {
                    const privateKey = await session.wallet.getPrivateKeyBase58();

                    // Send the private key message
                    const keyMsg = await ctx.reply(
                        `🔐 *Your Private Key*\n\n` +
                        `\`${privateKey}\`\n\n` +
                        `⚠️ Copy this key and store it safely.\n` +
                        `When done, type \`DONE\` and this message will be deleted.`,
                        { parse_mode: 'Markdown' }
                    );

                    // Wait for "DONE" response to delete the message
                    // We'll track this with a temporary handler
                    const doneHandler = async (doneCtx: typeof ctx) => {
                        if (
                            doneCtx.chat.id === chatId &&
                            doneCtx.message &&
                            'text' in doneCtx.message &&
                            doneCtx.message.text.trim().toUpperCase() === 'DONE'
                        ) {
                            // Delete the private key message
                            try {
                                await ctx.telegram.deleteMessage(chatId, keyMsg.message_id);
                            } catch { /* message may already be deleted */ }

                            // Delete the "DONE" message too
                            try {
                                await doneCtx.deleteMessage();
                            } catch { /* may lack permissions */ }

                            await ctx.reply('✅ Private key message deleted. Your key is safe.');

                            // Remove this handler — we use a Set to track
                            pendingDoneConfirm.delete(chatId);
                        }
                    };

                    // Track that we're waiting for DONE from this user
                    pendingDoneConfirm.set(chatId, {
                        keyMessageId: keyMsg.message_id,
                    });

                } catch (err: unknown) {
                    const msg = err instanceof Error ? err.message : String(err);
                    await ctx.reply(`❌ Export failed: ${msg}`);
                }
            } else {
                await ctx.reply('❌ Export cancelled.');
            }
            return;
        }

        // ── Handle "DONE" after private key export ────────────────────────────
        if (pendingDoneConfirm.has(chatId) && text.toUpperCase() === 'DONE') {
            const pending = pendingDoneConfirm.get(chatId)!;
            pendingDoneConfirm.delete(chatId);

            try {
                await ctx.telegram.deleteMessage(chatId, pending.keyMessageId);
            } catch { /* message may already be deleted */ }

            try {
                await ctx.deleteMessage();
            } catch { /* may lack permissions */ }

            await ctx.reply('✅ Private key message deleted. Your key is safe.');
            return;
        }

        // ── Normal trading instruction ────────────────────────────────────────
        const session = store.getSession(chatId);
        if (!session) {
            await ctx.reply(
                '🔒 Your wallet is locked.\n\n' +
                'Use /unlock `<password>` to unlock it first, or /create to set up a new wallet.',
                { parse_mode: 'Markdown' }
            );
            return;
        }

        // Show typing indicator — feels fast and natural
        await ctx.sendChatAction('typing');

        try {
            // 1. Fetch price & wallet state
            const priceData = await getSOLPrice();
            const walletState = await session.wallet.getFullState(
                priceData.solPriceUSD,
                priceData.priceChange24h
            );

            logger.audit('INSTRUCTION_RECEIVED', `User ${chatId}: ${text}`, {
                instruction: text,
                chatId,
                network: session.network,
            });

            // 2. Ask LLM to interpret
            const cmd = await session.llm.interpret(text, walletState, priceData);

            // 3. Handle non-transactional actions — reply directly to user's message
            if (cmd.action === 'hold' || cmd.action === 'check_balance') {
                let response = `💬 _${escMd(cmd.reasoning)}_`;

                // Only show portfolio data for check_balance (not every hold)
                if (cmd.action === 'check_balance') {
                    const priceSymbol = priceData.priceChange24h >= 0 ? '📈' : '📉';
                    const priceSign = priceData.priceChange24h >= 0 ? '+' : '';
                    const portfolioUSD = (walletState.solBalance * priceData.solPriceUSD + walletState.usdcBalance).toFixed(2);

                    response += `\n\n◎ \`${walletState.solBalance.toFixed(4)} SOL\`  💵 \`${walletState.usdcBalance.toFixed(2)} USDC\`\n` +
                        `${priceSymbol} $${priceData.solPriceUSD.toFixed(2)} (${priceSign}${priceData.priceChange24h.toFixed(2)}%)  📊 ~$${portfolioUSD}`;
                }

                await ctx.reply(response, {
                    parse_mode: 'Markdown',
                    reply_parameters: { message_id: ctx.message.message_id },
                });
                return;
            }

            // 3b. Handle switch_network — AI can change network
            if (cmd.action === 'switch_network' as any) {
                const targetNet = cmd.params.outputToken?.toLowerCase().includes('main') ? 'mainnet-beta' : 'devnet';
                const currentNet = session.network;

                if (currentNet === targetNet) {
                    await ctx.reply(`💬 _You're already on ${targetNet === 'devnet' ? 'devnet' : 'mainnet'} 😄_`, {
                        parse_mode: 'Markdown',
                        reply_parameters: { message_id: ctx.message.message_id },
                    });
                    return;
                }

                // Lock current, switch, and tell user to unlock on new network
                store.lockSession(chatId);
                store.setUserNetwork(chatId, targetNet as any);

                await ctx.reply(
                    `🌐 *Switched to ${targetNet === 'devnet' ? 'Devnet' : 'Mainnet'}!*\n\n` +
                    `💬 _${escMd(cmd.reasoning)}_\n\n` +
                    `🔒 Wallet locked — use /unlock to continue on ${targetNet === 'devnet' ? 'devnet' : 'mainnet'}.`,
                    {
                        parse_mode: 'Markdown',
                        reply_parameters: { message_id: ctx.message.message_id },
                    }
                );
                return;
            }

            // 3c. Handle airdrop — AI can request devnet SOL
            if (cmd.action === 'airdrop' as any) {
                if (session.network !== 'devnet') {
                    await ctx.reply(`💬 _Airdrops only work on devnet! Switch first with \"go to devnet\" 😉_`, {
                        parse_mode: 'Markdown',
                        reply_parameters: { message_id: ctx.message.message_id },
                    });
                    return;
                }

                await ctx.sendChatAction('typing');
                try {
                    const sig = await session.wallet.rpcConnection.requestAirdrop(
                        session.wallet.keypair.publicKey,
                        2 * 1e9
                    );
                    await ctx.reply(
                        `💧 *Airdrop Received!*\n\n💬 _${escMd(cmd.reasoning)}_\n\n` +
                        `+2 SOL on devnet ✅`,
                        {
                            parse_mode: 'Markdown',
                            reply_parameters: { message_id: ctx.message.message_id },
                        }
                    );
                } catch {
                    await ctx.reply(`❌ Airdrop failed — devnet might be congested, try again in a sec!`, {
                        reply_parameters: { message_id: ctx.message.message_id },
                    });
                }
                return;
            }

            // 4. Guardrail check
            const guardrailResult = runGuardrails(cmd, walletState);

            if (!guardrailResult.passed) {
                await ctx.reply(
                    `🛑 _${escMd(guardrailResult.reason ?? '')}_ — your funds are safe, nothing was sent.`,
                    {
                        parse_mode: 'Markdown',
                        reply_parameters: { message_id: ctx.message.message_id },
                    }
                );
                return;
            }

            // 5. Check PAJ TX Pool for naira swaps
            if (cmd.action === 'swap_to_naira') {
                const pajPool = store.getPajPoolAddress(chatId);
                if (!pajPool) {
                    await ctx.reply(
                        `❌ No PAJ TX Pool set — use /setpool \`<address>\` first!`,
                        {
                            parse_mode: 'Markdown',
                            reply_parameters: { message_id: ctx.message.message_id },
                        }
                    );
                    return;
                }
            }

            // 6. Execute — show typing while processing
            await ctx.sendChatAction('typing');

            const pajPoolAddress = cmd.action === 'swap_to_naira' ? store.getPajPoolAddress(chatId) : undefined;
            const result = await session.executor.execute(cmd, guardrailResult.resolvedAmountSOL, pajPoolAddress);

            if (result.success && result.signature) {
                recordExecution();
            }

            // 7. Format response — clean and concise
            let response: string;

            if (result.success) {
                response = `✅ _${escMd(cmd.reasoning)}_`;

                if (result.signature) {
                    const explorerUrl = getExplorerUrl(result.signature, session.network);
                    response += `\n\n🔗 [View TX](${explorerUrl})`;
                }
            } else {
                response = `❌ ${escMd(result.error ?? 'Something went wrong')}\n\n💬 _${escMd(cmd.reasoning)}_`;
            }

            await ctx.reply(response, {
                parse_mode: 'Markdown',
                reply_parameters: { message_id: ctx.message.message_id },
            });

            // 8. Send receipt image for successful transactions
            if (result.success && result.signature) {
                try {
                    const receiptData: ReceiptData = {
                        type: cmd.action as ReceiptData['type'],
                        fromToken: cmd.params.inputToken ?? 'SOL',
                        toToken: cmd.params.outputToken ?? 'USDC',
                        amount: guardrailResult.resolvedAmountSOL ?? cmd.params.amountSOL ?? 0,
                        amountUSD: (cmd.params.inputToken?.toUpperCase() === 'USDC')
                            ? (guardrailResult.resolvedAmountSOL ?? cmd.params.amountSOL ?? 0)
                            : (guardrailResult.resolvedAmountSOL ?? cmd.params.amountSOL ?? 0) * priceData.solPriceUSD,
                        signature: result.signature,
                        network: session.network,
                        walletAddress: walletState.publicKey,
                        explorerUrl: getExplorerUrl(result.signature, session.network),
                        recipient: cmd.params.recipient ?? undefined,
                        numOrders: (cmd.params as any).numOrders ?? undefined,
                        intervalDays: (cmd.params as any).intervalDays ?? undefined,
                        mintAddress: (cmd.params as any).mintAddress ?? undefined,
                    };

                    const receiptBuffer = await generateReceipt(receiptData);
                    await ctx.replyWithPhoto(
                        { source: receiptBuffer, filename: 'receipt.png' },
                        {
                            caption: '🧾 Transaction Receipt',
                            reply_parameters: { message_id: ctx.message.message_id },
                        }
                    );
                } catch (receiptErr) {
                    logger.error(`Failed to generate receipt: ${receiptErr}`);
                }
            }

        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error(`Error processing instruction for user ${chatId}: ${msg}`);
            await ctx.reply(`❌ ${escMd(msg)}`, {
                parse_mode: 'Markdown',
                reply_parameters: { message_id: ctx.message.message_id },
            });
        }
    });

    // ── State for DONE tracking ─────────────────────────────────────────────
    const pendingDoneConfirm = new Map<number, { keyMessageId: number }>();

    // ── Graceful Shutdown ───────────────────────────────────────────────────

    const shutdown = (signal: string) => {
        logger.audit('AGENT_STOP', `Bot shutting down (${signal})`);
        store.lockAll();
        bot.stop(signal);
        process.exit(0);
    };

    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));

    return bot;
}
