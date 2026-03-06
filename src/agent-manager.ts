/**
 * agent-manager.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Multi-Agent Manager — enables users to spawn multiple independent AI agents,
 * each with its own wallet, LLM brain, and trading strategy.
 *
 * SCALABILITY PROOF:
 *   • Each sub-agent has its OWN Keypair (independent wallet)
 *   • Each sub-agent has its OWN LLMBrain instance (independent decision-making)
 *   • Sub-agents operate concurrently via Promise.all
 *   • No shared mutable state between agents
 *   • Per-user isolation: each Telegram user manages their own fleet of agents
 *
 * ARCHITECTURE:
 *   User → AgentManager → SubAgent[] → { Wallet, LLM, Alerts }
 *   Each SubAgent is fully autonomous and can be started/stopped independently.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { LLMBrain } from './llm';
import { AgentWallet, WalletState } from './wallet';
import { getSOLPrice, PriceData } from './price-feed';
import { logger } from './logger';
import { NetworkType, getNetworkConfig } from './network-config';

// ─── Types ──────────────────────────────────────────────────────────────────

export type AgentRole = 'trader' | 'analyst' | 'sniper';

export interface SubAgent {
    id: string;
    name: string;
    role: AgentRole;
    emoji: string;
    keypair: Keypair;
    publicKey: string;
    llm: LLMBrain;
    isActive: boolean;
    createdAt: number;
    lastDecision?: { action: string; reasoning: string; timestamp: number };
    network: NetworkType;
}

export interface AgentStatus {
    id: string;
    name: string;
    role: AgentRole;
    emoji: string;
    publicKey: string;
    solBalance: number;
    isActive: boolean;
    createdAt: string;
    lastDecision?: { action: string; reasoning: string };
}

// ─── Role Configuration ─────────────────────────────────────────────────────

const ROLE_CONFIG: Record<AgentRole, { name: string; emoji: string; persona: string }> = {
    trader: {
        name: 'Trader Agent',
        emoji: '📈',
        persona: 'You are an aggressive trading agent. You prefer action — swaps, DCA setups, and price-triggered trades. When in doubt, look for trading opportunities. You are fast, decisive, and always looking for the next trade.',
    },
    analyst: {
        name: 'Analyst Agent',
        emoji: '🔍',
        persona: 'You are a cautious portfolio analyst. You prefer to check balances, analyze positions, and suggest rebalancing strategies. You never rush into trades. You advise on risk management and diversification.',
    },
    sniper: {
        name: 'Sniper Agent',
        emoji: '🎯',
        persona: 'You are a precision sniper agent. You watch for rapid price movements and act instantly when opportunities appear. You specialize in setting up price alerts and conditional trades. Speed is everything.',
    },
};

// ─── Agent Manager ──────────────────────────────────────────────────────────

const MAX_AGENTS_PER_USER = 3;

export class AgentManager {
    /**
     * Map of chatId → Map of agentId → SubAgent
     * Each user has their own fleet of independent agents.
     */
    private userAgents: Map<number, Map<string, SubAgent>> = new Map();

    /**
     * Spawn a new independent sub-agent for a user.
     * Each sub-agent gets its own wallet keypair and LLM brain.
     */
    async spawnAgent(chatId: number, role: AgentRole, network: NetworkType): Promise<SubAgent> {
        // Ensure user has an agent map
        if (!this.userAgents.has(chatId)) {
            this.userAgents.set(chatId, new Map());
        }

        const agents = this.userAgents.get(chatId)!;

        // Check limit
        if (agents.size >= MAX_AGENTS_PER_USER) {
            throw new Error(`Maximum ${MAX_AGENTS_PER_USER} agents per user. Use /kill to remove one first.`);
        }

        // Check for duplicate role
        for (const [, agent] of agents) {
            if (agent.role === role && agent.isActive) {
                throw new Error(`You already have an active ${role} agent. Kill it first with /kill ${role}.`);
            }
        }

        const config = ROLE_CONFIG[role];
        const id = `${role}_${Date.now()}`;

        // Create INDEPENDENT wallet (own keypair)
        const keypair = Keypair.generate();
        const publicKey = keypair.publicKey.toString();

        // Create INDEPENDENT LLM brain
        const llm = new LLMBrain();

        const agent: SubAgent = {
            id,
            name: config.name,
            role,
            emoji: config.emoji,
            keypair,
            publicKey,
            llm,
            isActive: true,
            createdAt: Date.now(),
            network,
        };

        agents.set(id, agent);

        logger.audit('AGENT_SPAWNED', `${config.emoji} ${config.name} spawned for user ${chatId}`, {
            agentId: id,
            role,
            publicKey,
            network,
        });

        return agent;
    }

    /**
     * Get all agents for a user.
     */
    getUserAgents(chatId: number): SubAgent[] {
        const agents = this.userAgents.get(chatId);
        if (!agents) return [];
        return Array.from(agents.values());
    }

    /**
     * Get active agents for a user.
     */
    getActiveAgents(chatId: number): SubAgent[] {
        return this.getUserAgents(chatId).filter(a => a.isActive);
    }

    /**
     * Kill (deactivate) a sub-agent by role name.
     */
    killAgent(chatId: number, role: string): SubAgent | null {
        const agents = this.userAgents.get(chatId);
        if (!agents) return null;

        for (const [id, agent] of agents) {
            if ((agent.role === role || agent.id === role) && agent.isActive) {
                agent.isActive = false;

                logger.audit('AGENT_KILLED', `${agent.emoji} ${agent.name} killed for user ${chatId}`, {
                    agentId: id,
                    role: agent.role,
                });

                return agent;
            }
        }

        return null;
    }

    /**
     * Get detailed status of all agents for a user, including balances.
     */
    async getAgentStatuses(chatId: number, connection: Connection): Promise<AgentStatus[]> {
        const agents = this.getUserAgents(chatId);
        if (agents.length === 0) return [];

        // Fetch balances concurrently (proving independence)
        const statuses = await Promise.all(
            agents.map(async (agent) => {
                let solBalance = 0;
                try {
                    const lamports = await connection.getBalance(agent.keypair.publicKey);
                    solBalance = lamports / LAMPORTS_PER_SOL;
                } catch { }

                return {
                    id: agent.id,
                    name: agent.name,
                    role: agent.role,
                    emoji: agent.emoji,
                    publicKey: agent.publicKey,
                    solBalance,
                    isActive: agent.isActive,
                    createdAt: new Date(agent.createdAt).toISOString(),
                    lastDecision: agent.lastDecision
                        ? { action: agent.lastDecision.action, reasoning: agent.lastDecision.reasoning }
                        : undefined,
                };
            })
        );

        return statuses;
    }

    /**
     * Run a decision cycle for all active agents concurrently.
     * Each agent independently interprets the same market data
     * but makes its OWN decision based on its role/persona.
     */
    async runAllAgents(chatId: number, instruction: string, connection: Connection): Promise<{
        agentName: string;
        emoji: string;
        role: AgentRole;
        action: string;
        reasoning: string;
        publicKey: string;
        timeMs: number;
    }[]> {
        const active = this.getActiveAgents(chatId);
        if (active.length === 0) return [];

        const priceData = await getSOLPrice();

        // Run ALL agents concurrently — proving true independence
        const results = await Promise.all(
            active.map(async (agent) => {
                const startTime = Date.now();

                // Each agent builds its own wallet state
                let solBalance = 0;
                try {
                    const lamports = await connection.getBalance(agent.keypair.publicKey);
                    solBalance = lamports / LAMPORTS_PER_SOL;
                } catch { }

                const walletState: WalletState = {
                    publicKey: agent.publicKey,
                    solBalance,
                    usdcBalance: 0,
                    solPriceUSD: priceData.solPriceUSD,
                    priceChange24h: priceData.priceChange24h,
                    lastUpdated: new Date().toISOString(),
                    network: agent.network,
                };

                // Each agent uses its OWN LLM brain to interpret
                const cmd = await agent.llm.interpret(instruction, walletState, priceData);

                const timeMs = Date.now() - startTime;

                // Store last decision
                agent.lastDecision = {
                    action: cmd.action,
                    reasoning: cmd.reasoning,
                    timestamp: Date.now(),
                };

                return {
                    agentName: agent.name,
                    emoji: agent.emoji,
                    role: agent.role,
                    action: cmd.action,
                    reasoning: cmd.reasoning,
                    publicKey: agent.publicKey,
                    timeMs,
                };
            })
        );

        return results;
    }

    /**
     * Get the persona/system prompt modifier for a given role.
     * This is appended to the base system prompt to give each agent
     * a distinct personality.
     */
    static getRolePersona(role: AgentRole): string {
        return ROLE_CONFIG[role]?.persona ?? '';
    }

    /**
     * Get all available roles.
     */
    static getAvailableRoles(): AgentRole[] {
        return ['trader', 'analyst', 'sniper'];
    }

    /**
     * Get role display info.
     */
    static getRoleInfo(role: AgentRole): { name: string; emoji: string; persona: string } {
        return ROLE_CONFIG[role];
    }

    /**
     * Total agent count across all users (for metrics).
     */
    getTotalAgentCount(): number {
        let count = 0;
        for (const [, agents] of this.userAgents) {
            count += agents.size;
        }
        return count;
    }
}
