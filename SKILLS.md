# SKILLS.md

> This file describes the capabilities, interfaces, and limitations of this agent.
> It is written for other agents, orchestrators, and automated systems to read.

---

## Agent Identity

```
name:     solana-llm-wallet-agent (ORE AI)
version:  5.0.0
network:  devnet | mainnet-beta (configurable per-user)
runtime:  Node.js / TypeScript
model:    llama-3.3-70b-versatile (Groq)
interface: Telegram Bot
```

---

## Capabilities

### wallet_management
Create, import, unlock, lock, and export Solana wallets. Each wallet is encrypted with AES-256-GCM + scrypt (N=16384) and stored per-user per-network. Auto-lock after 30 minutes of inactivity. Password messages are auto-deleted from Telegram chat.

### natural_language_trading
Accept plain English instructions and translate them into on-chain Solana transactions via Groq (Llama 3.3 70B, temperature 0, JSON mode). The AI acts as a professional crypto trader with 20+ years of experience, capable of giving real trading advice and executing complex multi-step operations.

### autonomous_execution
Execute transactions without human approval. The agent features a background **AutonomousEngine** that polls price feeds every 60 seconds and manages scheduled tasks. All decisions flow through:
1. LLM interpretation (Groq / Llama 3.3)
2. Zod schema validation
3. Guardrail validation (deterministic, cannot be LLM-overridden)
4. On-chain simulation (zero-cost pre-check)
5. Signing and confirmation

It supports:
- **Price-Triggered Alerts**: `set_alert` actions that execute a command (e.g., swap) when SOL hits a specific USD price.
- **Background DCA**: Slices a large order into smaller swaps executed automatically over a specified interval.

### multi_step_command_chaining
The LLM supports **sequential multi-step commands** — execute multiple actions in a single message:
- "Swap half my SOL to USDC and then PAJ $20 USDC" → swap first, then off-ramp
- "Stake 0.3 SOL and set an alert for SOL at $200" → stake first, then alert
- Steps execute sequentially (first completes before second starts)

### multi_agent_scalability
Spawn **multiple independent sub-agents** per user via the `AgentManager` or natural language. Each sub-agent has:
- Its own wallet (`Keypair.generate()` — unique on-chain address)
- Its own LLM brain (`new LLMBrain()` — independent decision-making)
- A role-based persona that modifies its behavior
- No shared mutable state with other agents

Available roles:
| Role | Emoji | Behavior |
|------|-------|----------|
| `trader` | 📈 | Aggressive — swaps, DCA, price triggers |
| `analyst` | 🔍 | Cautious — portfolio analysis, rebalancing advice |
| `sniper` | 🎯 | Precision — rapid price monitoring, instant execution |

Max 3 agents per user. All agents run concurrently via `Promise.all()`.

### dapp_integrations

| dApp | Capability | SDK/API | Devnet |
|------|-----------|---------|--------|
| **Jupiter Aggregator** | Token swaps (SOL ↔ USDC/USDT) | Jupiter Swap V6 API | ✅ |
| **Internal DCA Scheduler** | Dollar-cost averaging positions | AutonomousEngine + Jupiter | ✅ |
| **Native Staking** | Stake SOL to validators | Solana Stake Program | ✅ |
| **Pump.fun** | Buy/sell memecoins | PumpPortal Trade API | ❌ mainnet only |
| **PAJ TX Pool** | Naira off-ramp (SOL → NGN) | SOL transfer to pool | ✅ |

### price_monitoring
Real-time SOL/USD price and 24h change via CoinGecko API (free, no key required, 30 calls/min). Evaluates price-based conditions (drops X%, above $Y, below $Z) and powers the background `set_alert` price triggers. 15-second cache to respect rate limits. Falls back to mock price when offline.

### portfolio_tracking
Display SOL + USDC balances with real-time USD portfolio valuation via `/balance` command.

### transaction_receipts
Generates premium ticket-style receipt images for every successful transaction using `node-canvas` and the Inter font. Includes TX signature, amount, USD value, date, barcode, wallet address, and network.

### naira_offramp
Users configure a PAJ TX Pool address via `/setpool`. Supports USD-denominated amounts ("PAJ $2 worth of SOL") with automatic live price conversion.

### network_switching
Per-user network switching between devnet and mainnet. Each network has its own wallet keystore. Switch via `/network <devnet|mainnet>` or natural language ("switch to mainnet").

### airdrop
Request 2 SOL devnet airdrop via `/airdrop` or natural language ("give me some SOL", "airdrop").

---

## LLM Natural Language Instructions

The AI understands all of the following instructions. Just type naturally — no slash commands needed.

### 💱 Swaps
```
"swap 0.5 SOL for USDC"
"convert half my SOL to USDC"
"buy 0.2 SOL worth of USDC"
"swap all my USDC to SOL"
"exchange a quarter of my SOL for USDC"
"swap $5 worth of SOL to USDC"
"convert 1 USDC to SOL"
```

### 📤 Transfers
```
"send 0.1 SOL to <address>"
"transfer half my SOL to <address>"
"send all my USDC to <address>"
```

### 🪨 Staking
```
"stake 0.5 SOL"
"put my money to work"
"stake half my SOL"
"how does staking work?"
"what APY can I get staking SOL?"
"unstake my SOL"
"withdraw my staked SOL"
"deactivate my stake"
```

### 📈 DCA (Dollar-Cost Averaging)
```
"DCA 1 SOL into USDC over 5 days"
"set up a DCA — swap 0.5 SOL over 3 orders every 2 days"
"invest 0.3 SOL into USDC gradually"
"what is DCA and should I use it?"
```

### 🏦 Naira Off-Ramp (PAJ)
```
"PAJ $2 worth of SOL"
"cash out 0.1 SOL"
"send to naira"
"I need cash"
"PAJ 0.5 SOL"
"convert my SOL to naira"
```

### 🚀 Pump.fun (Mainnet Only)
```
"ape into <mint_address>"
"buy 0.1 SOL of <mint_address> on pump"
"sell my <mint_address> on pump"
"degen play on <mint_address>"
```

### ⏰ Price Alerts
```
"alert me when SOL hits $200"
"buy 0.5 SOL if price drops below $80"
"swap to USDC when SOL goes above $150"
"set an alert for SOL at $100"
"notify me if SOL drops 5%"
```

### 🌐 Network Switching
```
"switch to mainnet"
"go to devnet"
"switch to devnet"
"change network to mainnet"
```

### 💧 Airdrop (Devnet Only)
```
"give me some SOL"
"airdrop"
"I need free SOL"
"fund my wallet"
```

### 🤖 Agent Management
```
"spawn a trader agent"
"create an analyst"
"deploy a sniper bot"
"show my agents"
"list agents"
"how many agents do I have?"
"kill the trader"
"remove the sniper"
"stop the analyst"
```

### 💰 Portfolio & Balance
```
"check my balance"
"how much do I have?"
"what's my portfolio worth?"
"am I in profit?"
"show me my bags"
```

### 📊 Trading Advice & Market Analysis
```
"should I buy SOL right now?"
"is now a good time to buy?"
"what's your market outlook?"
"is SOL overvalued?"
"when should I sell?"
"what would you do with my portfolio?"
"how should I split my portfolio?"
"what's a good entry for SOL?"
"give me your honest take on the market"
"explain DeFi to me"
"what is impermanent loss?"
"how do AMMs work?"
```

### 🔗 Multi-Step Commands
```
"swap half my SOL to USDC and then PAJ $20 USDC"
"stake 0.3 SOL and set an alert for SOL at $200"
"airdrop and then swap 0.5 SOL to USDC"
"swap 0.2 SOL for USDC and send 0.1 SOL to <address>"
```

### 🗣️ Slang & Casual
```
"gm"
"how far ORE"
"LFG"
"I'm getting rekt"
"diamond hands"
"wen moon?"
"abeg help me"
"sharp sharp"
"e don red"
```

---

## Supported Actions

```
swap           → Jupiter token swap
transfer       → SOL transfer to address
stake          → Native SOL staking (dynamic validator selection)
unstake        → Native SOL unstaking (deactivates & withdraws)
dca            → Background DCA schedule creation
pump_buy       → Buy Pump.fun token with SOL (mainnet only)
pump_sell      → Sell Pump.fun token for SOL (mainnet only)
swap_to_naira  → Transfer SOL to PAJ TX Pool
set_alert      → Create a background price-triggered task
switch_network → Switch between devnet and mainnet
airdrop        → Request devnet SOL airdrop
spawn_agent    → Spawn a new sub-agent
list_agents    → View active sub-agents
kill_agent     → Deactivate a sub-agent
hold           → No action (AI decided to wait)
check_balance  → Display balances + portfolio value + advice
```

---

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome & getting started |
| `/create <password>` | Create a new encrypted wallet |
| `/import <key> <password>` | Import wallet from private key |
| `/unlock <password>` | Unlock your wallet |
| `/lock` | Lock wallet & clear keys from memory |
| `/balance` | Check SOL & USDC balances |
| `/airdrop` | Request devnet SOL airdrop |
| `/stake <amount>` | Stake SOL |
| `/dca <amount> <orders> <days>` | Set up DCA order |
| `/pump buy <mint> <amount>` | Buy token on Pump.fun |
| `/pump sell <mint> <amount>` | Sell token on Pump.fun |
| `/network <devnet\|mainnet>` | Switch network |
| `/setpool <address>` | Set PAJ TX Pool address |
| `/pool` | View PAJ TX Pool address |
| `/alerts` | View active autonomous tasks |
| `/spawn <role>` | Spawn a sub-agent (trader/analyst/sniper) |
| `/agents` | View all active sub-agents |
| `/kill <role>` | Deactivate a sub-agent |
| `/export` | Show public key & explorer link |
| `/exportkey` | Export private key (auto-deletes in 60s) |
| `/help` | List all commands |

---

## Guardrails

All guardrails are enforced deterministically and cannot be overridden by the LLM:

| Rule | Value |
|------|-------|
| Max SOL per transaction | 1.0 SOL |
| Max slippage | 100 bps (1%) |
| Cooldown between trades | 30 seconds |
| Max daily transactions | 20 |
| Min SOL rent reserve | 0.01 SOL |
| Large trade threshold | >50% of balance |
| Simulation-before-sign | Always |
| LLM failure fallback | `hold` (do nothing) |
| USD amount conversion | Live CoinGecko price |

---

## Security Model

| Layer | Implementation |
|-------|---------------|
| Key storage | AES-256-GCM + scrypt (N=16384, r=8, p=1) |
| Key lifecycle | Encrypted at rest, decrypted only in memory during session |
| Auto-lock | 30 minutes of inactivity |
| Private key export | Auto-deleted from Telegram after 60 seconds |
| Password messages | Auto-deleted immediately after processing |
| LLM isolation | LLM never touches private keys or signs transactions |
| Agent isolation | Each sub-agent has independent wallet (no shared state) |

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GROQ_API_KEY` | ✅ | Groq API key for LLM |
| `TELEGRAM_BOT_TOKEN` | ✅ | Telegram bot token |
| `JUPITER_API_KEY` | ✅ | Jupiter API key for swaps |
| `SOLANA_NETWORK` | ❌ | Default: `devnet` |
| `SOLANA_RPC_URL` | ❌ | Custom mainnet RPC (recommended: Helius) |
| `SOLANA_DEVNET_RPC_URL` | ❌ | Custom devnet RPC (recommended: Helius) |
| `VERBOSE` | ❌ | Enable detailed logging |

---

## Devnet Feature Support

All core features work on devnet:

| Feature | Devnet | Notes |
|---------|--------|-------|
| Wallet create/import/lock | ✅ | Full support |
| SOL airdrop | ✅ | 2 SOL per request |
| Jupiter swaps (SOL ↔ USDC) | ✅ | Uses devnet USDC mint |
| Native SOL staking | ✅ | Dynamic validator selection |
| Native SOL unstaking | ✅ | Deactivates and withdraws automatically |
| DCA scheduling | ✅ | Background swap automation |
| Price alerts | ✅ | CoinGecko price feed |
| PAJ naira off-ramp | ✅ | SOL transfer to pool |
| Multi-agent spawning | ✅ | Independent wallets + AI |
| Transaction receipts | ✅ | Generated for all TXs |
| Network switching | ✅ | Per-user devnet/mainnet |
| Pump.fun trading | ❌ | Mainnet only (PumpPortal API) |
| Portfolio tracking | ✅ | Live SOL price |
| Multi-step commands | ✅ | Sequential execution |
| Trading advice | ✅ | AI-powered analysis |

---

## Limitations

- **Max 1 SOL per transaction** — hardcoded guardrail
- **Pump.fun is mainnet only** — no devnet support
- **No leveraged trading** — only spot swaps and staking
- **Rate limits** — Groq (6,000 TPM free tier), CoinGecko (30/min)
- **JavaScript memory** — key zeroing is best-effort due to GC
- **Max 3 sub-agents per user** — prevents resource exhaustion
- **Sub-agent wallets are ephemeral** — not persisted across bot restarts

---

## File Structure

```
src/
├── llm.ts              # LLM brain (Groq / Llama 3.3) — 20-year crypto expert prompt
├── wallet.ts           # Encrypted wallet management (AES-256-GCM + scrypt)
├── executor.ts         # Transaction builder & sender (simulate → sign → send)
├── guardrails.ts       # Deterministic safety checks (Zod schema validation)
├── autonomous.ts       # Background price alerts & DCA engine
├── agent-manager.ts    # Multi-agent spawning & management
├── price-feed.ts       # CoinGecko price oracle (15s cache)
├── telegram-bot.ts     # Telegram bot interface & command handlers
├── user-store.ts       # Per-user session management
├── receipt.ts          # Transaction receipt image generator (node-canvas)
├── logger.ts           # Append-only JSONL audit trail
├── network-config.ts   # Devnet/mainnet configuration + custom RPC support
├── dca.ts              # Jupiter DCA integration
├── pumpfun.ts          # Pump.fun trading (mainnet only)
├── marinade.ts         # Native SOL staking (dynamic validator selection)
└── dashboard.ts        # Status dashboard
```

---

## Dependencies

| Package | Purpose |
|---------|---------|
| `groq-sdk` | LLM inference |
| `@solana/web3.js` | Solana blockchain interaction |
| `@solana/spl-token` | SPL token operations |
| `@jup-ag/dca-sdk` | Jupiter DCA positions |
| `telegraf` | Telegram bot framework |
| `axios` | HTTP client (Jupiter, CoinGecko, PumpPortal) |
| `zod` | Schema validation |
| `bs58` | Base58 encoding for keys |
| `canvas` | Transaction receipt image generation |
| `chalk` | Colored console logging |
