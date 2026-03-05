/**
 * autonomous.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Core engine for autonomous agent capabilities.
 * Handles:
 * 1. Price-triggered trades ("buy 1 SOL if price drops below $100")
 * 2. Proactive portfolio alerts ("SOL dropped 5%, want to hedge?")
 * 3. Scheduled background DCA execution
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { logger } from './logger';
import { AgentWallet } from './wallet';
import { TransactionExecutor } from './executor';
import { getSOLPrice } from './price-feed';
import { Telegraf } from 'telegraf';

export type AlertType = 'price_trigger' | 'dca_schedule';

export interface AutonomousAlert {
    id: string;
    chatId: number;
    type: AlertType;

    // For price triggers
    targetToken?: string;
    triggerPriceUSD?: number;
    condition?: 'above' | 'below';
    actionCmd?: any; // The AgentCommand to execute when triggered

    // For DCA
    intervalMs?: number;
    nextExecutionTime?: number;
    remainingOrders?: number;

    isActive: boolean;
    createdAt: number;
}

export class AutonomousEngine {
    private alerts: Map<string, AutonomousAlert> = new Map();
    private intervalId: NodeJS.Timeout | null = null;
    private bot: Telegraf;
    private store: any; // UserStore reference
    private lastSolPrice: number = 0;

    constructor(bot: Telegraf, store: any) {
        this.bot = bot;
        this.store = store;
    }

    public start() {
        if (this.intervalId) return;
        logger.info('🤖 Starting Autonomous Engine...');

        // Run the check loop every 60 seconds
        this.intervalId = setInterval(() => this.tick(), 60000);

        // Initial fetch
        getSOLPrice().then((p: any) => this.lastSolPrice = p.solPriceUSD).catch();
    }

    public stop() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
            logger.info('🛑 Stopped Autonomous Engine.');
        }
    }

    /** Add an autonomous task */
    public addAlert(alert: Omit<AutonomousAlert, 'id' | 'createdAt' | 'isActive'>): string {
        const id = `alert_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
        const fullAlert: AutonomousAlert = {
            ...alert,
            id,
            createdAt: Date.now(),
            isActive: true
        };
        this.alerts.set(id, fullAlert);
        logger.info(`Autonomous alert created [${id}] for chat ${alert.chatId}`);
        return id;
    }

    /** Get active alerts for a user */
    public getUserAlerts(chatId: number): AutonomousAlert[] {
        return Array.from(this.alerts.values()).filter(a => a.chatId === chatId && a.isActive);
    }

    /** Cancel an alert */
    public cancelAlert(id: string): boolean {
        const alert = this.alerts.get(id);
        if (alert) {
            alert.isActive = false;
            this.alerts.delete(id);
            logger.info(`Autonomous alert canceled [${id}]`);
            return true;
        }
        return false;
    }

    /** Main background loop */
    private async tick() {
        let solPrice = 0;
        try {
            const priceData = await getSOLPrice();
            solPrice = priceData.solPriceUSD;
        } catch (err) {
            logger.error('Autonomous check failed to fetch price', { error: err });
            return;
        }

        // 1. Check for significant price moves (Proactive Alerts)
        this.checkPriceMoves(solPrice);
        this.lastSolPrice = solPrice;

        // 2. Process active tasks
        const now = Date.now();
        for (const [id, alert] of this.alerts.entries()) {
            if (!alert.isActive) {
                this.alerts.delete(id);
                continue;
            }

            try {
                if (alert.type === 'price_trigger') {
                    await this.processPriceTrigger(alert, solPrice, id);
                } else if (alert.type === 'dca_schedule') {
                    await this.processDCASchedule(alert, now, id);
                }
            } catch (err) {
                logger.error(`Error processing alert ${id}:`, { error: err });
            }
        }
    }

    /** Proactive portfolio alerts if SOL drops/pumps > 5% */
    private checkPriceMoves(currentPrice: number) {
        if (this.lastSolPrice === 0) return;

        const changePct = ((currentPrice - this.lastSolPrice) / this.lastSolPrice) * 100;

        if (Math.abs(changePct) >= 5.0) {
            const isDrop = changePct < 0;
            const moveType = isDrop ? 'dropped 📉' : 'pumped 📈';

            // Notify all active sessions
            const sessions = this.store.getAllSessions ? this.store.getAllSessions() : [];

            for (const session of sessions) {
                // Only notify users who have some balance
                if (session.wallet && (session.lastBalanceSOL > 0.1 || session.lastBalanceUSDC > 5)) {
                    const msg = `⚠️ *Market Alert:*\nSOL has ${moveType} by ${Math.abs(changePct).toFixed(1)}% recently. Current price: $${currentPrice.toFixed(2)}.\n\nWant me to adjust your portfolio automatically? Try replying "swap half my SOL to USDC" or "buy more SOL".`;

                    this.bot.telegram.sendMessage(session.chatId, msg, { parse_mode: 'Markdown' })
                        .catch(err => logger.error(`Failed to send proactive alert to ${session.chatId}`, err));
                }
            }
        }
    }

    /** Execute trade if price hits target */
    private async processPriceTrigger(alert: AutonomousAlert, currentPrice: number, id: string) {
        if (!alert.triggerPriceUSD || !alert.condition || !alert.actionCmd) return;

        const conditionMet =
            (alert.condition === 'below' && currentPrice <= alert.triggerPriceUSD) ||
            (alert.condition === 'above' && currentPrice >= alert.triggerPriceUSD);

        if (conditionMet) {
            logger.audit('PRICE_CONDITION_CHECK', `Autonomous trigger hit: SOL $${currentPrice.toFixed(2)} is ${alert.condition} $${alert.triggerPriceUSD}`, { alertId: id });

            alert.isActive = false; // Run once
            this.alerts.delete(id);

            // Fetch session and execute
            const session = this.store.getSession(alert.chatId);
            if (!session) {
                await this.notifyUser(alert.chatId, `⚠️ Could not execute your price alert (wallet locked). Please /unlock and set it again.\nCondition met: SOL ${alert.condition} $${alert.triggerPriceUSD}`);
                return;
            }

            await this.notifyUser(alert.chatId, `⚡ *Autonomous Action Triggered!*\nSOL price hit $${currentPrice.toFixed(2)} (${alert.condition} $${alert.triggerPriceUSD}). Executing your trade...`);

            // We process it through the normal execution path but without a user message
            // Note: In a full system, we'd pass this back to telegram-bot.ts's runGuardrails/execute flow
            // We will export a callback or have telegram-bot register a handler
            if (this.onTriggerCallback) {
                this.onTriggerCallback(alert.chatId, alert.actionCmd);
            }
        }
    }

    /** Execute DCA orders on schedule */
    private async processDCASchedule(alert: AutonomousAlert, now: number, id: string) {
        if (!alert.nextExecutionTime || !alert.intervalMs || !alert.remainingOrders || alert.remainingOrders <= 0) {
            alert.isActive = false;
            this.alerts.delete(id);
            return;
        }

        if (now >= alert.nextExecutionTime) {
            alert.remainingOrders--;
            alert.nextExecutionTime = now + alert.intervalMs;

            if (alert.remainingOrders <= 0) {
                alert.isActive = false;
                this.alerts.delete(id);
            }

            // Fetch session and execute
            const session = this.store.getSession(alert.chatId);
            if (!session) {
                await this.notifyUser(alert.chatId, `⚠️ Skipped a DCA order (wallet locked).`);
                return;
            }

            await this.notifyUser(alert.chatId, `⏳ *Autonomous DCA Executing*\nOrder ${alert.remainingOrders + 1} remaining after this one...`);

            if (this.onTriggerCallback) {
                this.onTriggerCallback(alert.chatId, alert.actionCmd);
            }
        }
    }

    private onTriggerCallback: ((chatId: number, cmd: any) => Promise<void>) | null = null;

    public onTrigger(callback: (chatId: number, cmd: any) => Promise<void>) {
        this.onTriggerCallback = callback;
    }

    private async notifyUser(chatId: number, message: string) {
        try {
            await this.bot.telegram.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        } catch (e) {
            logger.error(`Autonomy notify failed for ${chatId}`, { error: e });
        }
    }
}
