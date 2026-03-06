# 🤖 Solana LLM Wallet Agent

An **autonomous, AI-powered Solana wallet** that interprets natural language trading instructions, executes on-chain transactions, and operates as a **multi-user Telegram bot** with full devnet and mainnet support.

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🔑 **Encrypted wallet** | AES-256-GCM + scrypt keystores, per-user, per-network |
| 📥 **Import/Export** | Import from base58 keys, export with security confirmation |
| 🧠 **AI-powered trading** | Groq (Llama 3.3 70B) interprets natural language → guardrail checks → execution |
| 🤖 **Autonomous Engine** | Background price monitoring, condition-based execution, and automated callbacks |
| 🔄 **Jupiter swaps** | Swap SOL ↔ USDC/USDT via Jupiter aggregator |
| 🪨 **Marinade staking** | Stake SOL via native Solana staking |
| 📈 **Jupiter DCA** | Dollar-cost averaging with on-chain DCA positions |
| 🚀 **Pump.fun trading** | Buy/sell memecoins via PumpPortal API (mainnet) |
| 🏦 **Naira off-ramp** | Swap SOL to Naira via PAJ TX Pool |
| 💰 **Portfolio tracking** | Real-time SOL price from CoinGecko, USD portfolio value |
| 👥 **Multi-user** | Each Telegram user gets their own encrypted wallet and session |
| 🤖 **Multi-Agent** | Spawn independent sub-agents (trader/analyst/sniper), each with own wallet & AI brain |
| 🌐 **Devnet + Mainnet** | Per-user network switching |
| 🛡️ **Guardrails** | Max 1 SOL/tx, max 1% slippage, cooldowns, simulation-before-sign |
| 📋 **Audit trail** | Append-only JSONL log of every decision and transaction |

## 🏗️ Architecture

```
Telegram User
     │
     ▼
┌─────────────────┐     ┌──────────────┐     ┌─────────────────┐
│  telegram-bot.ts │────▶│ user-store.ts│────▶│   wallet.ts     │
│  (commands + NL) │     │ (sessions)   │     │ (AES-256-GCM)   │
└─────────────────┘     └──────────────┘     └─────────────────┘
     │                                              │
     ▼                                              ▼
┌──────────┐    ┌──────────────┐    ┌──────────────────────────┐
│  llm.ts  │───▶│ guardrails.ts│───▶│     executor.ts          │
│  (Groq)  │    │ (validation) │    │ (simulate → sign → send) │
└──────────┘    └──────────────┘    └──────────────────────────┘
                                              │
                       ┌──────────────────────┼───────────────────┐
                       ▼                      ▼                   ▼
              ┌────────────────┐   ┌──────────────────┐  ┌──────────────┐
              │ Jupiter Swap   │   │  Marinade Stake   │  │  Pump.fun    │
              │ Jupiter DCA    │   │  PAJ TX Pool      │  │  PumpPortal  │
              └────────────────┘   └──────────────────┘  └──────────────┘
                                          ▲
                                          │
                                 ┌──────────────────┐
                                 │ Autonomous Engine│
                                 │ (Price Alerts &  │
                                 │  Background DCA) │
                                 └──────────────────┘
```

## 🚀 Quick Start

### Prerequisites
- Node.js 18+
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- A Groq API key from [console.groq.com](https://console.groq.com)

### Setup

```bash
# 1. Clone and install
git clone <repo-url>
cd solana-llm-wallet
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env and add your keys:
#   GROQ_API_KEY=your-groq-key
#   TELEGRAM_BOT_TOKEN=your-bot-token
#   JUPITER_API_KEY=your-jupiter-key
#   SOLANA_NETWORK=devnet

# 3. Start the Telegram bot
npm run bot
```

### Telegram Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message and setup guide |
| `/create <password>` | Create a new wallet |
| `/import <privateKey> <password>` | Import existing wallet |
| `/unlock <password>` | Unlock wallet for the session |
| `/lock` | Lock wallet and clear keys from memory |
| `/balance` | Show balances + SOL price + portfolio USD value |
| `/airdrop` | Request 2 SOL devnet airdrop |
| `/stake <amount>` | Stake SOL |
| `/dca <amount> <orders> <days>` | Set up Jupiter DCA |
| `/pump buy <mint> <amount>` | Buy Pump.fun token (mainnet) |
| `/pump sell <mint> <amount>` | Sell Pump.fun token (mainnet) |
| `/setpool <address>` | Set PAJ TX Pool for Naira off-ramp |
| `/pool` | View PAJ TX Pool address |
| `/network <devnet\|mainnet>` | Switch network |
| `/export` | Show public key and explorer link |
| `/exportkey` | Export private key (with confirmation) |
| `/recover <code|password>` | Recover password using recovery code |
| `/alerts` | View active autonomous tasks (price alerts, DCA) |
| `/help` | List all commands |

### Natural Language Trading

Just type any instruction in plain English:

```
"swap 0.1 SOL for USDC"
"stake half my SOL"
"DCA 1 SOL into USDC over 5 days"
"buy 0.1 SOL of <mint> on pump.fun"
"swap 0.5 SOL to naira"
"swap 1 SOL for USDC when SOL goes above $150"
"transfer 0.05 SOL to <address>"
"check my balance"
```

The AI interprets your instruction → validates against guardrails → simulates on-chain → signs and executes.

## 📁 Project Structure

```
src/
├── bot.ts              # Entry point
├── telegram-bot.ts     # Telegram commands + NL handler
├── user-store.ts       # Multi-user sessions + PAJ TX Pool storage
├── wallet.ts           # Encrypted wallet (AES-256-GCM + scrypt)
├── llm.ts              # Groq LLM integration (Llama 3.3 70B)
├── executor.ts         # Transaction pipeline (simulate → sign → send)
├── autonomous.ts       # Background price monitoring & automated tasks
├── guardrails.ts       # Deterministic safety checks (Zod schema)
├── marinade.ts         # Marinade staking service
├── dca.ts              # Jupiter DCA service
├── pumpfun.ts          # Pump.fun trading service (PumpPortal API)
├── price-feed.ts       # CoinGecko price oracle
├── network-config.ts   # Devnet/mainnet configuration
├── logger.ts           # Audit logging (append-only JSONL)
config/
├── guardrails.json     # Guardrail limits configuration
scripts/
├── multi-agent-demo.ts # Multi-agent test harness (3 agents)
keystores/              # Per-user encrypted keystores (gitignored)
```

## 🤖 Multi-Agent Architecture

The system supports **multiple independent AI agents**, each with its own wallet, LLM brain, and transaction executor. No shared state.

```
┌─────────────────────────────────────────────┐
│              UserStore (Central)              │
├─────────────────────────────────────────────┤
│  Agent A: Wallet₁ + LLM₁ + Executor₁       │
│  Agent B: Wallet₂ + LLM₂ + Executor₂       │
│  Agent C: Wallet₃ + LLM₃ + Executor₃       │
└─────────────────────────────────────────────┘
```

**Run the multi-agent test harness:**
```bash
npx ts-node scripts/multi-agent-demo.ts
```

This spawns 3 agents that each create their own wallet, receive devnet SOL, and make independent AI decisions concurrently.

## 🔒 Security Model

- **Encryption at rest**: AES-256-GCM with scrypt-derived keys (N=16384, r=8, p=1)
- **Key in memory**: Only during unlocked sessions, auto-lock after 30 min
- **Simulation-before-sign**: Every transaction simulated before signing
- **Guardrails**: Hard limits cannot be overridden by LLM
- **Password auto-delete**: Telegram messages with passwords are immediately deleted
- **Private key export**: Requires explicit confirmation + auto-delete
- **Audit trail**: Every decision logged to `audit.log.jsonl`

## 🛡️ Guardrail Limits

| Limit | Value |
|-------|-------|
| Max SOL per transaction | 1.0 SOL |
| Max slippage | 100 bps (1%) |
| Cooldown between trades | 30 seconds |
| Large trade warning | >50% of balance |
| Max daily transactions | 20 |
| Min SOL rent reserve | 0.01 SOL |

## 🔌 Supported dApps

| dApp | Action | Network |
|------|--------|---------|
| Jupiter Aggregator | Token swaps (SOL ↔ USDC/USDT) | Devnet + Mainnet |
| Jupiter DCA | Dollar-cost averaging positions | Devnet + Mainnet |
| Marinade / Native Staking | Stake SOL | Devnet + Mainnet |
| Pump.fun (PumpPortal) | Buy/sell memecoins | Mainnet only |
| PAJ TX Pool | Naira off-ramp | Devnet + Mainnet |

## 📄 License

MIT
