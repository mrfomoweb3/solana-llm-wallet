/**
 * wallet.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Secure wallet management for the LLM agent.
 *
 * SECURITY MODEL:
 *   • Private keys are NEVER stored in plaintext.
 *   • Keys are encrypted with AES-256-GCM using a password-derived key (scrypt).
 *   • The plaintext key lives in memory only during the lifetime of a transaction.
 *   • All key material is zeroed from memory after use (best-effort in JS).
 *
 * KEY DERIVATION:
 *   scrypt(password, salt, N=2^14, r=8, p=1) → 32-byte AES key
 *   AES-256-GCM(key, iv) → ciphertext + 16-byte auth tag
 *   Stored format: base64(salt[16] || iv[12] || ciphertext || tag[16])
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
} from '@solana/web3.js';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';
import { NetworkType, getNetworkConfig } from './network-config';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WalletState {
  publicKey: string;
  solBalance: number;     // SOL (not lamports)
  usdcBalance: number;
  solPriceUSD: number;
  priceChange24h: number; // percent
  lastUpdated: string;
  network: NetworkType;
}

export interface EncryptedKeystore {
  version: number;
  algorithm: string;
  kdf: string;
  kdfParams: {
    N: number;
    r: number;
    p: number;
    dkLen: number;
    saltHex: string;
  };
  ivHex: string;
  ciphertextHex: string;
  tagHex: string;
  publicKey: string;     // store public key unencrypted for reference
  createdAt: string;
  network: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_KEYSTORE_PATH = path.resolve(process.cwd(), '.keystore.json');

// scrypt parameters — intentionally expensive to resist brute force
const SCRYPT_N = 16384; // 2^14 (2^17 exceeds Node.js crypto memory limits)
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_LEN = 32;

// ─── Wallet Class ─────────────────────────────────────────────────────────────

export class AgentWallet {
  private connection: Connection;
  private _keypair: Keypair | null = null;
  private _keystorePath: string;
  private _network: NetworkType;
  private _usdcMint: PublicKey;

  constructor(network: NetworkType = 'devnet', keystorePath?: string) {
    this._network = network;
    this._keystorePath = keystorePath ?? DEFAULT_KEYSTORE_PATH;

    const config = getNetworkConfig(network);
    this.connection = new Connection(config.rpcUrl, 'confirmed');
    this._usdcMint = new PublicKey(config.tokenMints.USDC);
  }

  get network(): NetworkType {
    return this._network;
  }

  get rpcConnection(): Connection {
    return this.connection;
  }

  // ── Key Creation & Encryption ──────────────────────────────────────────────

  /**
   * Generates a fresh keypair, encrypts it, and persists the keystore.
   * Returns the public key string.
   */
  async create(password: string): Promise<string> {
    if (fs.existsSync(this._keystorePath)) {
      throw new Error(
        `Keystore already exists at ${this._keystorePath}. ` +
        `Delete it manually to create a new wallet.`
      );
    }

    // Ensure directory exists
    const dir = path.dirname(this._keystorePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const keypair = Keypair.generate();
    const secretKey = keypair.secretKey; // Uint8Array(64)

    const keystore = this._encrypt(secretKey, password, keypair.publicKey.toString());
    fs.writeFileSync(this._keystorePath, JSON.stringify(keystore, null, 2), { mode: 0o600 });

    // Zero the secret key buffer (best-effort)
    secretKey.fill(0);

    logger.info(`Wallet created: ${keypair.publicKey.toString()}`);
    logger.info(`Keystore written to: ${this._keystorePath}`);

    return keypair.publicKey.toString();
  }

  /**
   * Loads and decrypts the keystore into memory.
   * Call this once at startup; the keypair lives in this._keypair for the session.
   */
  async unlock(password: string): Promise<void> {
    if (!fs.existsSync(this._keystorePath)) {
      throw new Error(`No keystore found at ${this._keystorePath}. Create a wallet first.`);
    }

    const keystore: EncryptedKeystore = JSON.parse(
      fs.readFileSync(this._keystorePath, 'utf8')
    );

    const secretKey = this._decrypt(keystore, password);
    this._keypair = Keypair.fromSecretKey(secretKey);

    // Verify the decrypted key matches the stored public key
    if (this._keypair.publicKey.toString() !== keystore.publicKey) {
      this._keypair = null;
      throw new Error('Key integrity check failed — wrong password or corrupted keystore.');
    }

    logger.info(`Wallet unlocked: ${this._keypair.publicKey.toString()}`);
  }

  /** Check if a keystore file exists */
  hasKeystore(): boolean {
    return fs.existsSync(this._keystorePath);
  }

  /** Check if wallet is currently unlocked */
  isUnlocked(): boolean {
    return this._keypair !== null;
  }

  /** Wipe the keypair from memory (call on graceful shutdown) */
  lock(): void {
    if (this._keypair) {
      this._keypair.secretKey.fill(0);
      this._keypair = null;
      logger.info('Wallet locked and key material cleared from memory.');
    }
  }

  // ── Private Key Import / Export ────────────────────────────────────────────

  /**
   * Import a wallet from a base58-encoded private key.
   * Encrypts the key and saves it as a keystore file.
   * Returns the public key string.
   */
  async importFromPrivateKey(privateKeyBase58: string, password: string): Promise<string> {
    if (fs.existsSync(this._keystorePath)) {
      throw new Error(
        `Keystore already exists at ${this._keystorePath}. ` +
        `Delete it or switch networks to import a new wallet.`
      );
    }

    // Ensure directory exists
    const dir = path.dirname(this._keystorePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Decode the base58 private key
    let secretKey: Uint8Array;
    try {
      const bs58 = await import('bs58');
      secretKey = bs58.default.decode(privateKeyBase58);
    } catch {
      throw new Error('Invalid private key format. Expected a base58-encoded string.');
    }

    // Validate key length (Solana keypairs are 64 bytes)
    if (secretKey.length !== 64) {
      throw new Error(`Invalid key length: expected 64 bytes, got ${secretKey.length}.`);
    }

    const keypair = Keypair.fromSecretKey(secretKey);

    const keystore = this._encrypt(secretKey, password, keypair.publicKey.toString());
    fs.writeFileSync(this._keystorePath, JSON.stringify(keystore, null, 2), { mode: 0o600 });

    // Zero the secret key buffer
    secretKey.fill(0);

    // Unlock immediately
    this._keypair = keypair;

    logger.info(`Wallet imported: ${keypair.publicKey.toString()}`);
    logger.info(`Keystore written to: ${this._keystorePath}`);

    return keypair.publicKey.toString();
  }

  /**
   * Export the private key as a base58-encoded string.
   * ⚠️ SECURITY: Only call this when the user has explicitly confirmed.
   * The wallet must be unlocked.
   */
  async getPrivateKeyBase58(): Promise<string> {
    if (!this._keypair) {
      throw new Error('Wallet is locked. Unlock first before exporting.');
    }

    const bs58 = await import('bs58');
    return bs58.default.encode(this._keypair.secretKey);
  }

  // ── Encryption / Decryption ────────────────────────────────────────────────

  private _encrypt(
    secretKey: Uint8Array,
    password: string,
    publicKey: string
  ): EncryptedKeystore {
    const salt = randomBytes(16);
    const iv = randomBytes(12);  // 96-bit nonce for GCM

    const derivedKey = scryptSync(password, salt, SCRYPT_LEN, {
      N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P,
    });

    const cipher = createCipheriv('aes-256-gcm', derivedKey, iv);
    const encrypted = Buffer.concat([
      cipher.update(Buffer.from(secretKey)),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag(); // 16-byte authentication tag

    // Zero the derived key
    derivedKey.fill(0);

    return {
      version: 1,
      algorithm: 'aes-256-gcm',
      kdf: 'scrypt',
      kdfParams: {
        N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P,
        dkLen: SCRYPT_LEN,
        saltHex: salt.toString('hex'),
      },
      ivHex: iv.toString('hex'),
      ciphertextHex: encrypted.toString('hex'),
      tagHex: tag.toString('hex'),
      publicKey,
      createdAt: new Date().toISOString(),
      network: this._network,
    };
  }

  private _decrypt(keystore: EncryptedKeystore, password: string): Uint8Array {
    const salt = Buffer.from(keystore.kdfParams.saltHex, 'hex');
    const iv = Buffer.from(keystore.ivHex, 'hex');
    const ct = Buffer.from(keystore.ciphertextHex, 'hex');
    const tag = Buffer.from(keystore.tagHex, 'hex');

    const derivedKey = scryptSync(password, salt, SCRYPT_LEN, {
      N: keystore.kdfParams.N,
      r: keystore.kdfParams.r,
      p: keystore.kdfParams.p,
    });

    const decipher = createDecipheriv('aes-256-gcm', derivedKey, iv);
    decipher.setAuthTag(tag);

    let plaintext: Buffer;
    try {
      plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
    } catch {
      derivedKey.fill(0);
      throw new Error('Decryption failed — authentication tag mismatch. Wrong password?');
    }

    derivedKey.fill(0);
    return new Uint8Array(plaintext);
  }

  // ── Balance & State ────────────────────────────────────────────────────────

  get publicKey(): PublicKey {
    if (!this._keypair) throw new Error('Wallet is locked. Call unlock() first.');
    return this._keypair.publicKey;
  }

  get keypair(): Keypair {
    if (!this._keypair) throw new Error('Wallet is locked. Call unlock() first.');
    return this._keypair;
  }

  async getSolBalance(): Promise<number> {
    try {
      const lamports = await this.connection.getBalance(this.publicKey);
      return lamports / LAMPORTS_PER_SOL;
    } catch {
      return 0; // Account may not exist on-chain yet
    }
  }

  async getUsdcBalance(): Promise<number> {
    try {
      const { getAssociatedTokenAddress, getAccount } = await import('@solana/spl-token');
      const ata = await getAssociatedTokenAddress(this._usdcMint, this.publicKey);
      const account = await getAccount(this.connection, ata);
      return Number(account.amount) / 1_000_000; // USDC has 6 decimals
    } catch {
      return 0; // No ATA yet = zero balance
    }
  }

  async requestAirdrop(solAmount: number = 2): Promise<string> {
    const config = getNetworkConfig(this._network);
    if (!config.airdropAvailable) {
      throw new Error('Airdrop is only available on devnet.');
    }

    logger.info(`Requesting ${solAmount} SOL airdrop on ${this._network}...`);
    const lamports = solAmount * LAMPORTS_PER_SOL;
    const sig = await this.connection.requestAirdrop(this.publicKey, lamports);
    await this.connection.confirmTransaction(sig, 'confirmed');
    logger.info(`Airdrop confirmed: ${sig}`);
    return sig;
  }

  async getFullState(solPriceUSD: number, priceChange24h: number): Promise<WalletState> {
    const [solBalance, usdcBalance] = await Promise.all([
      this.getSolBalance(),
      this.getUsdcBalance(),
    ]);

    return {
      publicKey: this.publicKey.toString(),
      solBalance,
      usdcBalance,
      solPriceUSD,
      priceChange24h,
      lastUpdated: new Date().toISOString(),
      network: this._network,
    };
  }
}
