/**
 * user-store.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Multi-user session management for the Telegram bot.
 *
 * Each Telegram user gets:
 *   • Their own encrypted wallet keystore on disk (keystores/<chatId>.keystore.json)
 *   • A runtime session with unlocked wallet, LLM brain, and executor
 *   • Per-user network selection (devnet or mainnet-beta)
 *   • Auto-lock after 30 minutes of inactivity
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as fs from 'fs';
import * as path from 'path';
import { PublicKey } from '@solana/web3.js';
import { AgentWallet } from './wallet';
import { LLMBrain } from './llm';
import { TransactionExecutor } from './executor';
import { NetworkType, getDefaultNetwork } from './network-config';
import { logger } from './logger';

// ─── Constants ────────────────────────────────────────────────────────────────

const KEYSTORES_DIR = path.resolve(process.cwd(), 'keystores');
const AUTO_LOCK_MS = 30 * 60 * 1000; // 30 minutes
const USER_PREFS_FILE = path.resolve(process.cwd(), 'keystores', 'user-prefs.json');

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UserSession {
    chatId: number;
    wallet: AgentWallet;
    llm: LLMBrain;
    executor: TransactionExecutor;
    network: NetworkType;
    lastActivity: number;
}

interface UserPrefs {
    [chatId: string]: {
        network: NetworkType;
        pajTxPoolAddress?: string;
    };
}

// ─── User Store ───────────────────────────────────────────────────────────────

export class UserStore {
    private sessions: Map<number, UserSession> = new Map();
    private autoLockTimer: NodeJS.Timeout | null = null;

    constructor() {
        // Ensure keystores directory exists
        if (!fs.existsSync(KEYSTORES_DIR)) {
            fs.mkdirSync(KEYSTORES_DIR, { recursive: true });
        }

        // Start auto-lock checker
        this.autoLockTimer = setInterval(() => this.checkAutoLock(), 60_000);
    }

    // ── Keystore Path ─────────────────────────────────────────────────────────

    private getKeystorePath(chatId: number, network: NetworkType): string {
        return path.join(KEYSTORES_DIR, `${chatId}_${network}.keystore.json`);
    }

    // ── User Preferences ──────────────────────────────────────────────────────

    private loadPrefs(): UserPrefs {
        if (!fs.existsSync(USER_PREFS_FILE)) return {};
        try {
            return JSON.parse(fs.readFileSync(USER_PREFS_FILE, 'utf8'));
        } catch {
            return {};
        }
    }

    private savePrefs(prefs: UserPrefs): void {
        fs.writeFileSync(USER_PREFS_FILE, JSON.stringify(prefs, null, 2), { mode: 0o600 });
    }

    getUserNetwork(chatId: number): NetworkType {
        const prefs = this.loadPrefs();
        return prefs[String(chatId)]?.network ?? getDefaultNetwork();
    }

    setUserNetwork(chatId: number, network: NetworkType): void {
        const prefs = this.loadPrefs();
        const existing = prefs[String(chatId)] ?? { network: getDefaultNetwork() };
        prefs[String(chatId)] = { ...existing, network };
        this.savePrefs(prefs);

        // If the user has an active session on a different network, lock it
        const session = this.sessions.get(chatId);
        if (session && session.network !== network) {
            this.lockSession(chatId);
        }
    }

    // ── PAJ TX Pool Address ───────────────────────────────────────────────────

    getPajPoolAddress(chatId: number): string | undefined {
        const prefs = this.loadPrefs();
        return prefs[String(chatId)]?.pajTxPoolAddress;
    }

    hasPajPool(chatId: number): boolean {
        return !!this.getPajPoolAddress(chatId);
    }

    setPajPoolAddress(chatId: number, address: string): void {
        // Validate the address is a valid Solana public key
        try {
            new PublicKey(address);
        } catch {
            throw new Error('Invalid Solana address. Please provide a valid public key.');
        }

        const prefs = this.loadPrefs();
        const existing = prefs[String(chatId)] ?? { network: getDefaultNetwork() };
        prefs[String(chatId)] = { ...existing, pajTxPoolAddress: address };
        this.savePrefs(prefs);
    }

    // ── Session Management ────────────────────────────────────────────────────

    hasSession(chatId: number): boolean {
        return this.sessions.has(chatId);
    }

    getSession(chatId: number): UserSession | undefined {
        const session = this.sessions.get(chatId);
        if (session) {
            session.lastActivity = Date.now();
        }
        return session;
    }

    hasKeystore(chatId: number, network?: NetworkType): boolean {
        const net = network ?? this.getUserNetwork(chatId);
        return fs.existsSync(this.getKeystorePath(chatId, net));
    }

    /**
     * Create a new wallet for a user.
     * Returns the public key string.
     */
    async createWallet(chatId: number, password: string): Promise<string> {
        const network = this.getUserNetwork(chatId);
        const keystorePath = this.getKeystorePath(chatId, network);

        const wallet = new AgentWallet(network, keystorePath);
        const pubkey = await wallet.create(password);

        // Immediately unlock and create session
        await wallet.unlock(password);
        const llm = new LLMBrain();
        const executor = new TransactionExecutor(wallet);

        const session: UserSession = {
            chatId,
            wallet,
            llm,
            executor,
            network,
            lastActivity: Date.now(),
        };

        this.sessions.set(chatId, session);

        logger.info(`Created wallet for user ${chatId} on ${network}: ${pubkey}`);
        return pubkey;
    }

    /**
     * Unlock an existing wallet for a user.
     */
    async unlockWallet(chatId: number, password: string): Promise<string> {
        const network = this.getUserNetwork(chatId);
        const keystorePath = this.getKeystorePath(chatId, network);

        if (!fs.existsSync(keystorePath)) {
            throw new Error('No wallet found. Use /create to create one first.');
        }

        const wallet = new AgentWallet(network, keystorePath);
        await wallet.unlock(password);

        const llm = new LLMBrain();
        const executor = new TransactionExecutor(wallet);

        const session: UserSession = {
            chatId,
            wallet,
            llm,
            executor,
            network,
            lastActivity: Date.now(),
        };

        this.sessions.set(chatId, session);

        logger.info(`Unlocked wallet for user ${chatId} on ${network}: ${wallet.publicKey.toString()}`);
        return wallet.publicKey.toString();
    }

    /**
     * Import a wallet from a base58-encoded private key.
     * Returns the public key string.
     */
    async importWallet(chatId: number, privateKeyBase58: string, password: string): Promise<string> {
        const network = this.getUserNetwork(chatId);
        const keystorePath = this.getKeystorePath(chatId, network);

        const wallet = new AgentWallet(network, keystorePath);
        const pubkey = await wallet.importFromPrivateKey(privateKeyBase58, password);

        const llm = new LLMBrain();
        const executor = new TransactionExecutor(wallet);

        const session: UserSession = {
            chatId,
            wallet,
            llm,
            executor,
            network,
            lastActivity: Date.now(),
        };

        this.sessions.set(chatId, session);

        logger.info(`Imported wallet for user ${chatId} on ${network}: ${pubkey}`);
        return pubkey;
    }

    /**
     * Lock a user's session and wipe key material.
     */
    lockSession(chatId: number): boolean {
        const session = this.sessions.get(chatId);
        if (!session) return false;

        session.wallet.lock();
        this.sessions.delete(chatId);
        logger.info(`Locked session for user ${chatId}`);
        return true;
    }

    /**
     * Auto-lock sessions that have been inactive for too long.
     */
    private checkAutoLock(): void {
        const now = Date.now();
        for (const [chatId, session] of this.sessions) {
            if (now - session.lastActivity > AUTO_LOCK_MS) {
                logger.info(`Auto-locking inactive session for user ${chatId}`);
                this.lockSession(chatId);
            }
        }
    }

    /**
     * Lock all sessions (for shutdown).
     */
    lockAll(): void {
        for (const [chatId] of this.sessions) {
            this.lockSession(chatId);
        }
        if (this.autoLockTimer) {
            clearInterval(this.autoLockTimer);
        }
    }

    /**
     * Get the public key for a user's wallet on their current network (without unlocking).
     */
    getStoredPublicKey(chatId: number): string | null {
        const network = this.getUserNetwork(chatId);
        const keystorePath = this.getKeystorePath(chatId, network);

        if (!fs.existsSync(keystorePath)) return null;

        try {
            const keystore = JSON.parse(fs.readFileSync(keystorePath, 'utf8'));
            return keystore.publicKey ?? null;
        } catch {
            return null;
        }
    }
}
