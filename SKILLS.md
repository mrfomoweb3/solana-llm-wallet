# SKILLS.md

> This file describes the capabilities, interfaces, and limitations of this agent.
> It is written for other agents, orchestrators, and automated systems to read.

---

## Agent Identity

```
name:     solana-llm-wallet-agent (ORE AI)
version:  4.0.0
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
Accept plain English instructions and translate them into on-chain Solana transactions via Groq (Llama 3.3 70B, temperature 0, JSON mode).

Examples:
- "swap half my SOL for USDC if price drops 5%"
- "stake 0.5 SOL"
- "DCA 1 SOL into USDC over 5 days"
- "buy 0.1 SOL of <mint> on pump.fun"
- "swap $2 worth of SOL to naira"
- "transfer 0.05 SOL to <address>"
- "swap 1 SOL for USDC when SOL goes above $150"
- "check my balance"

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

### multi_agent_scalability
Spawn **multiple independent sub-agents** per user via the `AgentManager`. Each sub-agent has:
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

Commands:
- `/spawn <role>` — Create a new sub-agent
- `/agents` — View all active sub-agents with balances
- `/kill <role>` — Deactivate a sub-agent

Max 3 agents per user. All agents run concurrently via `Promise.all()`.

### dapp_integrations

| dApp | Capability | SDK/API |
|------|-----------|---------|
| **Jupiter Aggregator** | Token swaps (SOL ↔ USDC/USDT) | Jupiter Swap V6 API |
| **Internal DCA Scheduler** | Dollar-cost averaging positions | AutonomousEngine + Jupiter |
| **Marinade / Native Staking** | Stake SOL | Solana Stake Program |
| **Pump.fun** | Buy/sell memecoins (mainnet only) | PumpPortal Trade API |
| **PAJ TX Pool** | Naira off-ramp (SOL → NGN) | SOL transfer to pool |

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
Request 2 SOL devnet airdrop via `/airdrop` (devnet only).

---

## Supported Actions

```
swap           → Jupiter token swap
transfer       → SOL transfer to address
stake          → Native SOL staking
unstake        → (not yet implemented)
dca            → Background DCA schedule creation
pump_buy       → Buy Pump.fun token with SOL
pump_sell      → Sell Pump.fun token for SOL
swap_to_naira  → Transfer SOL to PAJ TX Pool
set_alert      → Create a background price-triggered task
switch_network → Switch between devnet and mainnet
airdrop        → Request devnet SOL airdrop
hold           → No action (AI decided to wait)
check_balance  → Display balances + portfolio value
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
| `VERBOSE` | ❌ | Enable detailed logging |

---

## Limitations

- **Max 1 SOL per transaction** — hardcoded guardrail
- **Pump.fun is mainnet only** — no devnet support
- **Unstaking** — not yet automated
- **No leveraged trading** — only spot swaps and staking
- **Rate limits** — Groq (6,000 TPM free tier), CoinGecko (30/min)
- **JavaScript memory** — key zeroing is best-effort due to GC
- **Max 3 sub-agents per user** — prevents resource exhaustion
- **Sub-agent wallets are ephemeral** — not persisted across bot restarts

---

## File Structure

```
src/
├── llm.ts              # LLM brain (Groq / Llama 3.3)
├── wallet.ts           # Encrypted wallet management
├── executor.ts         # Transaction builder & sender
├── guardrails.ts       # Deterministic safety checks
├── autonomous.ts       # Background price alerts & DCA
├── agent-manager.ts    # Multi-agent spawning & management
├── price-feed.ts       # CoinGecko price oracle
├── telegram-bot.ts     # Telegram bot interface
├── user-store.ts       # Per-user session management
├── receipt.ts          # Transaction receipt image generator
├── logger.ts           # Audit trail logger
├── network-config.ts   # Devnet/mainnet configuration
├── dca.ts              # Jupiter DCA integration
├── pumpfun.ts          # Pump.fun trading
├── marinade.ts         # Staking integration
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
