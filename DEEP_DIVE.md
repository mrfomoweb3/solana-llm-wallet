# Deep Dive: Solana LLM Wallet Agent — ORE AI

## Overview

ORE AI is an autonomous Solana wallet agent that combines large language model reasoning with on-chain transaction execution. Unlike traditional wallets that require explicit user input for every action, ORE AI **understands natural language**, makes autonomous decisions, and executes transactions within a strict safety framework.

This document covers the wallet design, security architecture, AI decision-making pipeline, multi-agent scalability, and protocol integrations.

---

## 1. Wallet Design

### 1.1 Key Generation & Storage

The wallet uses Solana's Ed25519 keypair (64 bytes: 32-byte private key + 32-byte public key), encrypted at rest using industry-standard cryptography.

**Creation flow:**
```
User provides password
         │
         ▼
Keypair.generate()  →  64-byte secret key
         │
         ▼
scrypt(password, random_salt) → 32-byte AES key
   Parameters: N=16384, r=8, p=1 (memory-hard)
         │
         ▼
AES-256-GCM(aes_key, random_iv, secret_key) → ciphertext + auth_tag
         │
         ▼
Save to keystores/<chatId>_<network>.keystore.json
   File permissions: 0o600 (owner-only read/write)
```

**Keystore format:**
```json
{
  "version": 1,
  "algorithm": "aes-256-gcm",
  "kdf": "scrypt",
  "kdfParams": { "N": 16384, "r": 8, "p": 1, "dkLen": 32, "saltHex": "..." },
  "ivHex": "...",
  "ciphertextHex": "...",
  "tagHex": "...",
  "publicKey": "...",
  "createdAt": "...",
  "network": "devnet"
}
```

### 1.2 Multi-Agent Architecture

The `UserStore` manages multiple independent agent sessions, each with its own wallet, LLM brain, and transaction executor. This is the foundation for **multi-agent scalability** — each agent operates completely independently.

```
┌─────────────────────────────────────────────┐
│              UserStore (Central)              │
├─────────────────────────────────────────────┤
│                                             │
│  Agent A (chatId: 6557625735)               │
│  ├── AgentWallet (devnet)                   │
│  ├── LLMBrain (independent context)         │
│  ├── TransactionExecutor                    │
│  └── Auto-lock timer (30 min idle)          │
│                                             │
│  Agent B (chatId: 1234567890)               │
│  ├── AgentWallet (mainnet)                  │
│  ├── LLMBrain (independent context)         │
│  ├── TransactionExecutor                    │
│  └── Auto-lock timer (30 min idle)          │
│                                             │
│  Agent C (chatId: 9876543210)               │
│  ├── AgentWallet (devnet)                   │
│  ├── LLMBrain (independent context)         │
│  ├── TransactionExecutor                    │
│  └── Auto-lock timer (30 min idle)          │
│                                             │
└─────────────────────────────────────────────┘
```

**Key properties:**
- **Isolation**: Each agent has its own encrypted keystore, LLM context, and wallet state
- **Independent networks**: Agent A can be on devnet while Agent B is on mainnet
- **Independent decisions**: Each agent's LLM makes autonomous decisions based on its own wallet state
- **No shared state**: Agents cannot access each other's keys, balances, or decisions

### 1.3 Token Management

Each wallet tracks:
- **SOL**: Native balance via `connection.getBalance()`
- **USDC/USDT**: SPL token balances via Associated Token Accounts (ATAs)
- **Portfolio USD value**: Calculated using real-time CoinGecko price feed

Network-specific token mints are defined in `network-config.ts`:
| Token | Devnet Mint | Mainnet Mint |
|-------|-------------|--------------|
| USDC | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| USDT | `Es9vMFrzaCERtE8RBfW2Fsd4CDAx2ML2Z7bFrN4fQ9oT` | `Es9vMFrzaCERtE8RBfW2Fsd4CDAx2ML2Z7bFrN4fQ9oT` |

---

## 2. Security Architecture

### 2.1 Defense-in-Depth

Security is implemented in **six independent layers**, each working regardless of whether the others fail:

```
Layer 1: Encrypted Storage (AES-256-GCM + scrypt)
    └── Private keys never stored in plaintext
Layer 2: Memory Security (auto-lock + zero-fill)
    └── secretKey.fill(0) on lock/shutdown
Layer 3: LLM Guardrails (deterministic, code-enforced)
    └── LLM output validated by Zod schema
Layer 4: Transaction Limits (hardcoded, not LLM-configurable)
    └── Max 1 SOL/tx, max 1% slippage, cooldowns
Layer 5: Simulation-Before-Sign
    └── Every tx simulated on-chain before signing
Layer 6: Audit Trail (append-only JSONL log)
    └── Every decision and transaction recorded
```

### 2.2 Threat Model

| Threat | Mitigation |
|--------|------------|
| Private key theft at rest | AES-256-GCM + scrypt(N=16384) encryption |
| Key exposure in memory | Auto-lock at 30 min idle + `secretKey.fill(0)` |
| LLM hallucination | Zod schema validation rejects malformed commands |
| Prompt injection | System prompt is hardcoded; user input is data, not instructions |
| Sandwich attacks (MEV) | Max 1% slippage enforced by guardrails |
| Accidental large trades | Max 1.0 SOL per transaction, >50% balance warning |
| Transaction front-running | Simulation catches state changes before signing |
| Password exposure in chat | Auto-delete messages containing passwords |
| Private key exposure | Disclaimer → CONFIRM → reveal → DONE → auto-delete |
| Brute-force passwords | scrypt key derivation (memory-hard, N=16384) |
| Rate abuse | 30-second cooldown + 20 tx/day limit |

### 2.3 The Simulate-Before-Sign Principle

**Every transaction is simulated against the current on-chain state before the private key signs it.** This is the most critical security mechanism.

```
LLM outputs command
        │
        ▼
Guardrails validate (amount, slippage, tokens, recipient)
        │
        ▼
Build transaction (e.g. Jupiter quote → swap tx)
        │
        ▼
┌─────────────────────────────────────────┐
│  SIMULATE on-chain (no signature)        │
│  • Check if tx would succeed             │
│  • Verify account state changes          │
│  • Measure compute units                 │
│  • Zero cost — no SOL spent              │
└─────────────────────────────────────────┘
        │
   PASS │ FAIL → ABORT (key never touches the tx)
        │
        ▼
Sign with keypair → Send → Confirm
```

### 2.4 Guardrail System

Guardrails are **deterministic** — they run in code, not in the LLM. The LLM cannot override them.

```typescript
// Hardcoded limits (from guardrails.json)
maxTransactionSOL:      1.0    // Max SOL per transaction
maxSlippageBps:         100    // Max 1% slippage
cooldownMs:             30000  // 30s between trades
largeTradeThresholdPct: 50     // Warn on >50% balance
maxDailyTransactions:   20     // Rate limit
minSolRentReserve:      0.01   // Keep for rent/fees
```

The guardrail pipeline:
1. **Schema validation**: LLM output must match Zod schema
2. **Amount resolution**: Percentages → absolute SOL amounts
3. **Limit checks**: Amount ≤ max, slippage ≤ max, balance sufficient
4. **Cooldown check**: Minimum time between transactions
5. **Daily limit**: Maximum transactions per 24h
6. **Rent reserve**: Never spend the last 0.01 SOL

---

## 3. AI Agent Intelligence

### 3.1 LLM Architecture

ORE AI uses **Groq** (model: `llama-3.3-70b-versatile`) with `temperature: 0` for deterministic, fast inference.

```
Natural language input
        │
        ▼
┌──────────────────────────────────────┐
│  System Prompt (hardcoded):           │
│  • Identity & personality (ORE AI)    │
│  • 3-step thinking framework          │
│  • Slang & context dictionary         │
│  • Safety rules & output format       │
│  • Action map for all dApps           │
└──────────────────────────────────────┘
        │
        ▼
┌──────────────────────────────────────┐
│  User Prompt (dynamic context):       │
│  • Natural language instruction       │
│  • Current wallet state (balances)    │
│  • Real-time SOL price + 24h change   │
│  • Price condition evaluation          │
└──────────────────────────────────────┘
        │
        ▼
Groq API (application/json response)
        │
        ▼
┌──────────────────────────────────────┐
│  Output: AgentCommand JSON            │
│  {                                    │
│    "action": "swap",                  │
│    "reasoning": "Swapping 0.1 SOL..." │
│    "params": { ... }                  │
│  }                                    │
└──────────────────────────────────────┘
        │
        ▼
Zod validation → Guardrails → Executor
```

### 3.2 Natural Language Understanding

ORE AI doesn't just parse keywords — it understands **intent**, **context**, and **slang**:

| Input | Understanding | Action |
|-------|--------------|--------|
| "swap 0.1 SOL for USDC" | Direct command | `swap` |
| "I'm low on cash, PAJ 1 SOL" | Nigerian slang for naira off-ramp | `swap_to_naira` |
| "should I buy the dip?" | Advisory question | `check_balance` with market analysis |
| "ape into that meme" | Crypto slang for aggressive buy | `pump_buy` |
| "put my SOL to work" | Wants yield | `stake` |
| "spread it out over 5 days" | Wants DCA strategy | `dca` |
| "switch to mainnet" | Network change | `switch_network` |
| "gm ORE, how far?" | Nigerian greeting | `check_balance` with friendly update |

### 3.3 Decision Framework

The AI follows a 3-step process:

1. **Question or Command?** — Questions get advice; commands get execution
2. **Understand Intent** — Read between the lines using context clues
3. **Use Wallet Data** — Reference real balances, prices, and market trends

### 3.4 Fallback Behavior

If the LLM returns invalid JSON or fails schema validation, the agent defaults to `action: "hold"`. This is the **safest possible fallback** for a financial agent — when uncertain, do nothing.

---

## 4. Autonomous Engine

The system includes a dedicated `AutonomousEngine` that runs in the background independently from the Telegram command handler. This engine allows agents to execute trades proactively based on market conditions rather than waiting for user input.

### 4.1 Price-Triggered Alerts
Users can instruct the AI to execute trades when specific price thresholds are met:
- *“buy 1 SOL worth of USDC when SOL goes below $120”*
- The AI creates a `price_trigger` alert stored in the engine's state.
- The engine polls CoinGecko every 60 seconds and evaluates all active conditions.
- When a threshold is crossed, the engine automatically routes the saved command through the Guardrails and Executor pipelines.
- The user is notified asynchronously upon execution via Telegram.

### 4.2 Background DCA Scheduling
The autonomous engine also handles Dollar-Cost Averaging schedules without requiring Jupiter's external on-chain DCA program.
- Example: *“DCA 1 SOL into USDC over 5 days”*
- The LLM parses this intention and breaks the order into 5 parts.
- The engine stores a `dca_schedule` alert and executes fractions of the total order automatically at the defined intervals, sending receipts each time.

---

## 5. dApp & Protocol Integrations

### 4.1 Jupiter DEX Aggregator (Swaps)

Interacts with Jupiter V6, the largest DEX aggregator on Solana:
1. `GET /v6/quote` — Get best swap route across all Solana DEXes
2. `POST /v6/swap` — Get serialized versioned transaction
3. Simulate → Sign → Send → Confirm

### 4.2 Native Solana Staking (via Marinade)

Creates stake accounts and delegates to validators using `@solana/web3.js` StakeProgram:
1. `StakeProgram.createAccount()` with authorized staker/withdrawer
2. `StakeProgram.delegate()` to a known validator
3. Combined into single atomic transaction

### 4.3 Jupiter DCA (Dollar Cost Averaging)

Creates on-chain DCA positions using `@jup-ag/dca-sdk`:
- User specifies total amount, number of orders, and interval
- DCA executes automatically on-chain over the specified period

### 4.4 PumpPortal (Memecoin Trading)

Buys and sells memecoins via PumpPortal REST API:
- `POST /api/trade-local` — Build buy/sell transactions
- Supports token mint address-based trading
- Mainnet only

### 5.5 Naira Off-Ramp (PAJ TX Pool)

Swaps SOL/USDC to naira via PAJ TX Pool:
- User sets pool address with `/setpool`
- Agent transfers SOL to pool address for fiat conversion
- Simulation-before-sign applies to off-ramp transfers too

---

## 6. Network Configuration

| Property | Devnet | Mainnet |
|----------|--------|---------|
| RPC URL | `api.devnet.solana.com` | `api.mainnet-beta.solana.com` |
| USDC Mint | `4zMMC9...DncDU` | `EPjFWdd...Dt1v` |
| Airdrop | ✅ Available | ❌ N/A |
| Jupiter | ✅ Swaps | ✅ Swaps |
| Staking | ✅ via StakeProgram | ✅ via StakeProgram |
| Pump.fun | ❌ Mainnet only | ✅ PumpPortal |

Switching is per-agent: say "switch to mainnet" or use `/network mainnet`.

---

## 7. Real-Time Price Feed

The agent uses **CoinGecko API** for real-time SOL pricing:
- Polled every 30 seconds (with smart caching)
- Provides: current USD price, 24h change %, market cap
- Fed into every LLM decision as context
- Powers portfolio USD valuation
- Triggers autonomous execution via the `AutonomousEngine`

---

## 8. Audit Trail

Every decision is logged to `audit.log.jsonl` in append-only JSONL format:

```jsonl
{"id":"abc123","timestamp":"2026-03-02T...","event":"INSTRUCTION_RECEIVED","data":{"instruction":"swap 0.1 SOL for USDC"}}
{"id":"def456","timestamp":"2026-03-02T...","event":"GUARDRAIL_PASS","data":{"resolvedAmount":0.1}}
{"id":"ghi789","timestamp":"2026-03-02T...","event":"SIMULATION_PASS","data":{"unitsUsed":150000}}
{"id":"jkl012","timestamp":"2026-03-02T...","event":"TRANSACTION_CONFIRMED","data":{"signature":"5xYz..."}}
```

This provides a complete, tamper-evident record of every AI decision, guardrail check, and on-chain transaction.

---

## 9. Multi-Agent Scalability

### 8.1 Architecture

The system supports **unlimited concurrent agents**, each operating independently:

```
Telegram Bot (single process)
    │
    ├── Agent 1: Wallet A (devnet) + LLM Brain + Executor
    ├── Agent 2: Wallet B (mainnet) + LLM Brain + Executor
    ├── Agent 3: Wallet C (devnet) + LLM Brain + Executor
    └── Agent N: Wallet N + LLM Brain + Executor
```

### 8.2 Independence Guarantees

- **Separate keystores**: `keystores/<agentId>_<network>.keystore.json`
- **Separate LLM contexts**: Each agent gets its own wallet state and price data
- **Separate execution**: Transactions are built and signed per-agent
- **No cross-contamination**: Agent A's decisions never affect Agent B
- **Independent auto-lock**: Each session has its own 30-minute idle timer

### 8.3 Multi-Agent Test Harness

A test script (`scripts/multi-agent-demo.ts`) demonstrates 3 agents operating independently, each with different strategies and wallets, making autonomous decisions concurrently.

---

## 10. File Structure

```
src/
├── wallet.ts          # Key generation, encryption, signing
├── llm.ts             # Groq LLM integration, system prompt
├── guardrails.ts      # Deterministic safety rules (Zod)
├── executor.ts        # Transaction building & execution
├── autonomous.ts      # Background price monitoring & tasks
├── telegram-bot.ts    # Telegram UI & NL handler
├── user-store.ts      # Multi-agent session management
├── price-feed.ts      # CoinGecko real-time price feed
├── network-config.ts  # Devnet/mainnet configuration
├── marinade.ts        # Native staking service
├── dca.ts             # Jupiter DCA service
├── pumpfun.ts         # PumpPortal memecoin service
├── logger.ts          # Structured audit logging
├── dashboard.ts       # Console dashboard UI
├── agent.ts           # Standalone agent mode
└── bot.ts             # Entry point
config/
└── guardrails.json    # Safety limits configuration
scripts/
└── multi-agent-demo.ts # Multi-agent test harness
```

---

## 10. Why This Matters

Traditional crypto wallets are **passive** — they wait for explicit human input. ORE AI is an **active agent** that:

1. **Understands** natural language, slang, and context
2. **Decides** autonomously based on market data and wallet state
3. **Executes** on-chain transactions with zero human intervention
4. **Protects** itself with 6 independent security layers
5. **Scales** to unlimited independent agents
6. **Integrates** with real Solana dApps (Jupiter, Marinade, DCA, Pump.fun)

This is not a demo — it's a working prototype of what autonomous AI wallets will look like in production.
