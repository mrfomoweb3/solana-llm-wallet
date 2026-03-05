# Deep Dive: Solana LLM Wallet Agent

**Architecture, Security, and Design Decisions**

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Key Management Design](#2-key-management-design)
3. [Why LLMs Need Guardrails](#3-why-llms-need-guardrails)
4. [Simulate Before Sign](#4-simulate-before-sign)
5. [The Audit Trail](#5-the-audit-trail)
6. [What's Missing for Mainnet](#6-whats-missing-for-mainnet)

---

## 1. Architecture Overview

The system has four distinct layers. They are deliberately separated so that each can be tested, replaced, or hardened independently.

```
┌──────────────────────────────────────────────────────────────────┐
│                     OPERATOR / USER                               │
│         "swap half my SOL for USDC if price drops 5%"            │
└─────────────────────────────┬────────────────────────────────────┘
                              │ natural language
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│                    LAYER 1: LLM BRAIN (llm.ts)                    │
│                                                                    │
│  Input:  natural language instruction + wallet state + price      │
│  Output: structured AgentCommand JSON                             │
│                                                                    │
│  • System prompt enforces JSON-only output                        │
│  • Temperature = 0 for deterministic responses                    │
│  • Always includes "reasoning" field for audit trail              │
│  • Returns action: "hold" when uncertain                          │
└─────────────────────────────┬────────────────────────────────────┘
                              │ AgentCommand JSON
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│                 LAYER 2: GUARDRAIL ENGINE (guardrails.ts)         │
│                                                                    │
│  8 deterministic checks run in sequence:                          │
│   1. Action allowlist    5. Balance sufficiency                   │
│   2. Token allowlist     6. Program whitelist                     │
│   3. Slippage limit      7. Cooldown enforcement                  │
│   4. Amount limit        8. Large trade gate                      │
│                                                                    │
│  ✅ Pass → executor receives command + resolved amount            │
│  🛑 Fail → command is dropped, reason logged, sleep, retry        │
└─────────────────────────────┬────────────────────────────────────┘
                              │ validated command
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│               LAYER 3: TRANSACTION EXECUTOR (executor.ts)         │
│                                                                    │
│  Build → Simulate → Sign → Send → Confirm                        │
│                                                                    │
│  • Gets Jupiter quote for swaps                                   │
│  • Simulates against current on-chain state                       │
│  • Only signs if simulation passes                                │
│  • Sends to devnet via RPC                                        │
│  • Waits for confirmation before returning                        │
└─────────────────────────────┬────────────────────────────────────┘
                              │ ExecutionResult
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│               LAYER 4: WALLET (wallet.ts)                         │
│                                                                    │
│  • Keys encrypted at rest (AES-256-GCM + scrypt)                 │
│  • Private key lives in memory only when unlocked                 │
│  • Exposes only: publicKey, keypair (for signing), connection     │
│  • lock() zeroes key material from memory                         │
└──────────────────────────────────────────────────────────────────┘
```

### Why These Four Layers?

**Separation of Concerns** is not just good software design here — it is a security requirement.

- The LLM layer must never have direct access to the wallet signer.
- The guardrail layer must run even if the LLM is compromised or malfunctioning.
- The executor must simulate before it ever calls the signer.
- The wallet layer has no knowledge of what instructions caused a signature — it only knows it was asked to sign a valid, simulated transaction.

A compromised LLM cannot bypass the guardrails. A guardrail bug cannot expose the private key. The key encryption is independent of all business logic.

---

## 2. Key Management Design

### The Problem

AI agents are always-on processes. Unlike a browser wallet where a human physically approves each transaction, an agentic wallet needs to sign autonomously. This creates a challenge: the private key must be accessible to the process, but it must also be protected.

The naive approach — storing the key as a plaintext string in a `.env` file — is unacceptable. If the process is compromised, if logs are leaked, or if the server is accessed, the key is gone.

### Our Solution: Encrypted Keystore

We use a design inspired by Ethereum's [Web3 Secret Storage](https://github.com/ethereum/wiki/wiki/Web3-Secret-Storage-Definition), adapted for Solana's Ed25519 keypairs.

#### Key Derivation Function: scrypt

```
password + salt (16 random bytes)
        ↓
    scrypt(N=2^17, r=8, p=1)
        ↓
    32-byte derived key
```

scrypt is chosen over PBKDF2 and bcrypt because it is simultaneously memory-hard and CPU-hard. This means an attacker with specialized GPU hardware cannot efficiently brute-force the password — they need large amounts of RAM per attempt, which limits parallelism.

The parameters N=2^17, r=8, p=1 are the recommended "interactive" settings from the scrypt paper. On a modern CPU, this derivation takes approximately 100–300ms — fast enough to not annoy users at startup, but slow enough to make brute-force economically unattractive.

#### Encryption: AES-256-GCM

```
derived_key (32 bytes) + iv (12 random bytes)
        ↓
    AES-256-GCM
        ↓
    ciphertext + 16-byte authentication tag
```

AES-256-GCM provides both confidentiality (encryption) and integrity (authentication tag). If even one byte of the ciphertext is tampered with, decryption will fail with an authentication error before any plaintext is revealed.

This matters: an attacker who modifies the keystore file cannot flip bits in the ciphertext to produce a different private key. The authentication tag catches tampering.

#### Stored Format

```json
{
  "version": 1,
  "algorithm": "aes-256-gcm",
  "kdf": "scrypt",
  "kdfParams": {
    "N": 131072,
    "r": 8,
    "p": 1,
    "dkLen": 32,
    "saltHex": "..."
  },
  "ivHex": "...",
  "ciphertextHex": "...",
  "tagHex": "...",
  "publicKey": "...",
  "createdAt": "...",
  "network": "devnet"
}
```

The public key is stored unencrypted — it is not sensitive, and storing it allows quick reference without decrypting the private key.

#### In-Memory Safety

Once unlocked, the private key is held as a `Uint8Array` inside a `Keypair` object. When the agent shuts down (or `lock()` is called), the array is explicitly zeroed:

```typescript
this._keypair.secretKey.fill(0);
this._keypair = null;
```

This is "best-effort" in JavaScript/Node.js due to garbage collection, but it eliminates the key from the most recently active memory regions and prevents trivial memory dumps from exposing the key.

#### File Permissions

The keystore is written with mode `0o600` (owner read/write only on Unix systems):

```typescript
fs.writeFileSync(KEYSTORE_PATH, JSON.stringify(keystore), { mode: 0o600 });
```

---

## 3. Why LLMs Need Guardrails

### The Hallucination Problem in Financial Contexts

Large language models are probabilistic. They predict the most likely next token given context. In most applications, a slightly wrong response is a minor inconvenience. In a financial agent, a slightly wrong response can result in permanent, irreversible loss of funds.

Here are real categories of LLM failure we defend against:

#### 1. Amount Hallucination

**What can go wrong:** The user says "swap half my SOL." The wallet has 2 SOL. The LLM outputs `amountSOL: 2.0` instead of `amountSOL: 1.0`. The full balance is swapped.

**Our defense:** Guardrail check 4 (Amount Limit) caps any single transaction at 1.0 SOL regardless of what the LLM outputs. If the LLM outputs 2.0, the guardrail blocks it and the trade does not execute.

#### 2. Slippage Manipulation

**What can go wrong:** In a congested network, the LLM (having been given market context showing high volatility) might output `slippageBps: 1000` (10% slippage). This opens the door to sandwich attacks where bots front-run and back-run the transaction, extracting value.

**Our defense:** Guardrail check 3 caps slippage at 100bps (1%). Any value above this is rejected regardless of LLM output.

#### 3. Unknown Program Interaction

**What can go wrong:** A compromised or confused LLM might suggest interacting with an arbitrary program address — perhaps one that appears similar to Jupiter but is actually a drainer contract.

**Our defense:** Guardrail check 6 maintains an explicit allowlist of approved program IDs. Any transaction targeting an unlisted program is rejected before execution.

#### 4. Condition Drift

**What can go wrong:** The instruction says "swap if price drops 5%." After many cycles, the LLM might lose the context of the original condition and output `action: "swap", conditionMet: true` even when the price has not actually dropped.

**Our defense:** The price-feed module independently calculates whether the condition is met and provides this result to the LLM in the prompt. The LLM is explicitly told to return `action: "hold"` when the condition is not met. This provides redundancy — both the LLM's interpretation and the deterministic price check must agree.

#### 5. Runaway Execution

**What can go wrong:** Without rate limiting, an LLM that decides to execute a swap would execute one on every poll cycle — potentially executing dozens of swaps in minutes.

**Our defense:** Guardrail check 7 enforces a 30-second cooldown between executions. After a transaction is sent, no further transactions can be initiated for 30 seconds, regardless of what the LLM outputs.

### The Core Principle

**The LLM is an advisor, not an authority.** It proposes actions. The guardrail engine decides whether those actions are safe to execute. The LLM cannot override the guardrails. Even if the LLM is completely compromised or replaced by an adversarial model, the guardrails enforce their limits.

---

## 4. Simulate Before Sign

### The Problem

Signing a transaction commits to a specific set of on-chain state changes. If the transaction fails after being signed and sent, you have spent SOL on fees and potentially been exposed to partial state changes in more complex programs.

More importantly: if you sign a transaction before understanding what it will do, you are trusting that your code correctly constructed it. Bugs in transaction construction are common and can result in sending the wrong amount, to the wrong address, or through the wrong program.

### How Simulation Works

Solana's RPC provides a `simulateTransaction` endpoint. It runs the transaction against the current on-chain state (including the latest blockhash and account data) without actually committing it to the chain. It returns:

- Whether the transaction would succeed or fail
- The exact error if it would fail
- The program logs generated by the transaction
- The number of compute units consumed

This is completely free — it does not cost SOL and does not modify any state.

### Our Implementation

```typescript
// Simulate the versioned transaction before signing
const result = await connection.simulateTransaction(transaction, {
  sigVerify: false,                // Don't require valid signatures for simulation
  replaceRecentBlockhash: true,    // Use the latest blockhash automatically
});

if (result.value.err) {
  // Log the error and abort — never reach the signing step
  return { success: false, error: JSON.stringify(result.value.err) };
}

// Only if simulation passes do we proceed to sign
transaction.sign([keypair]);
```

The key detail: `transaction.sign()` is only called after the simulation confirms the transaction would succeed. The private key is never used for a transaction that would fail.

### What Simulation Catches

In practice, simulation catches:

- **Insufficient balance** — the amount we're trying to send exceeds the wallet balance
- **Stale quotes** — Jupiter quotes expire quickly; a stale quote fails simulation before it fails on-chain
- **Wrong token accounts** — if an associated token account doesn't exist, the transaction fails simulation
- **Compute budget exceeded** — complex swap routes sometimes exceed the compute limit; simulation reveals this
- **Program version mismatches** — if a DEX program was upgraded, old transaction formats may fail

### The Safety Guarantee

If simulation passes, we have high confidence the transaction will succeed on-chain. If it fails on-chain despite passing simulation (rare, due to race conditions on fast-moving prices), we record the failure and do not retry automatically.

---

## 5. The Audit Trail

### Why Every Decision Must Be Logged

In traditional finance, every trade is logged, timestamped, and auditable by regulators, risk managers, and post-incident reviewers. Autonomous AI agents need the same — and arguably stronger — audit trails.

When something goes wrong with an autonomous agent (a bad trade, an unexpected behavior, a guardrail that should have triggered but didn't), the audit log is the only way to reconstruct what happened.

### Our Audit Log Format

Every event is written as a single JSON line to `audit.log.jsonl` (JSON Lines format — one JSON object per line, which is easy to stream and parse):

```json
{"id":"evt_1718123456789_0001","timestamp":"2024-06-11T20:30:56.789Z","event":"INSTRUCTION_RECEIVED","data":{"message":"Instruction received","instruction":"swap half my SOL for USDC if price drops 5%"}}
{"id":"evt_1718123456823_0002","timestamp":"2024-06-11T20:30:56.823Z","event":"WALLET_STATE_FETCHED","data":{"solBalance":1.9,"usdcBalance":0,"solPrice":145.23}}
{"id":"evt_1718123456901_0003","timestamp":"2024-06-11T20:30:56.901Z","event":"LLM_REQUEST","data":{"instruction":"swap half my SOL for USDC if price drops 5%","priceCondition":{"conditionMet":false,"description":"Price drop 2.1% vs threshold 5%"}}}
{"id":"evt_1718123457234_0004","timestamp":"2024-06-11T20:30:57.234Z","event":"LLM_RESPONSE","data":{"rawText":"{\"action\":\"hold\",\"reasoning\":\"Price only dropped 2.1%, threshold is 5%. Holding.\"}","inputTokens":412,"outputTokens":38}}
{"id":"evt_1718123457235_0005","timestamp":"2024-06-11T20:30:57.235Z","event":"AGENT_HOLD","data":{"reasoning":"Price only dropped 2.1%, threshold is 5%. Holding.","conditionMet":false}}
```

### How to Debug a Bad Trade

Suppose a swap executed when it shouldn't have. The debugging process is:

1. Find the `TRANSACTION_CONFIRMED` event with the bad tx signature
2. Look backward for its `TRANSACTION_SENT` event
3. Look further back for `SIMULATION_PASS` — what logs did simulation return?
4. Look back for `GUARDRAIL_PASS` — which guardrails were checked and what were the values?
5. Look back for `LLM_RESPONSE` — what exactly did the model output? What was its reasoning?
6. Look back for `WALLET_STATE_FETCHED` — was the price data correct?

Every step of the decision chain is recorded with enough detail to reconstruct the exact state the agent saw when it made its decision.

### Append-Only by Design

The audit log is opened in append mode (`fs.appendFileSync`). The process can never overwrite or truncate it. This means:

- Historical records cannot be accidentally deleted
- If the process crashes mid-operation, completed entries are preserved
- Multiple processes (in a multi-agent setup) can write to separate log files without conflict

---

## 6. What's Missing for Mainnet

This section is important. Judges who review this know that devnet is a safe sandbox. What demonstrates maturity is understanding the gap between devnet and production — and being honest about it.

### 1. Hardware Security Module (HSM) or MPC

**Current:** Private key encrypted in a JSON file, decrypted to memory at startup.

**Mainnet requirement:** The private key should never exist in plaintext in any software process.

Two approaches:
- **HSM:** A dedicated hardware device (YubiHSM, AWS CloudHSM) that stores the key internally. The process sends a "please sign this transaction bytes" request to the HSM over a local interface, and the HSM returns the signature without ever exporting the private key.
- **MPC (Multi-Party Computation):** The private key is split into N shares distributed across multiple servers using threshold signature schemes (e.g., 2-of-3). No single server ever holds the complete key. Transactions require cooperation from at least the threshold number of servers. Projects like [Dfns](https://www.dfns.co) and [Fireblocks](https://www.fireblocks.com) provide MPC infrastructure for exactly this use case.

### 2. Rate Limiting and Exposure Reduction

**Current:** 30-second cooldown between transactions, 1 SOL max per transaction.

**Mainnet requirement:**
- Daily spending limits per instruction type
- Time-of-day restrictions (e.g., no trades between 2–6 AM)
- Circuit breaker: if 3 failed transactions occur in a row, the agent pauses and alerts
- Dollar-value limits (not just SOL-amount limits) using oracle price feeds
- Separate transaction limits for each token pair

### 3. Instruction Signing and Authentication

**Current:** Anyone who can run the process can provide any instruction.

**Mainnet requirement:** Instructions must be cryptographically signed by an authorized operator keypair. The agent verifies the signature before processing any instruction. This prevents an attacker who gains code execution from injecting malicious instructions.

### 4. Formal LLM Output Validation

**Current:** Zod schema validation on the JSON structure.

**Mainnet requirement:**
- Semantic validation: does the LLM's stated reasoning match its proposed action?
- Secondary LLM audit: run a second LLM call asking "is this action appropriate given this instruction and state?" before executing
- Rejection sampling: if the primary model and auditor model disagree, default to hold

### 5. Network Redundancy

**Current:** Single RPC endpoint (Solana devnet via `clusterApiUrl`).

**Mainnet requirement:**
- Multiple RPC providers (Helius, QuickNode, Alchemy, self-hosted validator)
- Automatic failover if primary RPC is down or returning stale data
- RPC response validation: compare blockhash across multiple providers before signing

### 6. Monitoring and Alerting

**Current:** Console logs and audit file.

**Mainnet requirement:**
- Real-time alerts to Slack/PagerDuty when a transaction above a threshold executes
- Alert when guardrails block more than N times in a row (may indicate a bug or attack)
- Balance monitoring: alert if SOL drops below minimum reserves
- Grafana dashboard showing transaction history, LLM call latency, guardrail block rate

### 7. Key Rotation

**Current:** Keypair is generated once at setup, never rotated.

**Mainnet requirement:**
- Regular key rotation procedure: generate new keypair, transfer funds, decommission old key
- If key compromise is suspected, emergency rotation procedure with minimal downtime
- Multiple "warm" backup keypairs pre-registered as upgrade authorities

### 8. Regulatory Compliance (if handling third-party funds)

This is the largest gap. If the agent handles funds belonging to users other than the operator:
- KYC/AML compliance for users who deposit funds
- Transaction reporting to comply with applicable financial regulations
- Jurisdictional analysis: different countries have different regulations for autonomous trading agents
- Terms of service and clear disclosure that decisions are made by an AI

---

## Summary

This prototype demonstrates the core architecture of a production-grade agentic wallet on Solana. The four-layer design, encrypted key storage, deterministic guardrails, simulation-before-sign pipeline, and append-only audit trail are all genuine engineering decisions with real security rationale — not scaffolding that was added for the demo.

The gap to mainnet is real and documented honestly above. The most critical missing pieces are HSM/MPC for key management and formal instruction authentication. These are solvable problems with existing infrastructure — they simply require production hardware and multi-party coordination that is outside the scope of a devnet prototype.
