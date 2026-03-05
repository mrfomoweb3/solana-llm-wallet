# SKILLS.md

> This file describes the capabilities, interfaces, and limitations of this agent.
> It is written for other agents, orchestrators, and automated systems to read.

---

## Agent Identity

```
name:     solana-llm-wallet-agent
version:  3.0.0
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
- "swap 0.5 SOL to naira"
- "transfer 0.05 SOL to <address>"
- "check my balance"

### autonomous_execution
Execute transactions without human approval. The agent features a background **AutonomousEngine** that polls price feeds and manages scheduled tasks. All decisions flow through:
1. LLM interpretation (Groq / Llama 3.3)
2. Zod schema validation
3. Guardrail validation (deterministic, cannot be LLM-overridden)
4. On-chain simulation (zero-cost pre-check)
5. Signing and confirmation

It supports:
- **Price-Triggered Alerts**: `set_alert` actions that execute a command (e.g., swap) when SOL hits a specific USD price.
- **Background DCA**: Slices a large order into smaller swaps executed automatically over a specified interval.

### dapp_integrations

| dApp | Capability | SDK/API |
|------|-----------|---------|
| **Jupiter Aggregator** | Token swaps (SOL ↔ USDC/USDT) | Jupiter Swap V6 API |
| **Internal DCA Scheduler** | Dollar-cost averaging positions | AutonomousEngine + Jupiter |
| **Marinade / Native Staking** | Stake SOL | Solana Stake Program |
| **Pump.fun** | Buy/sell memecoins (mainnet only) | PumpPortal Trade API |
| **PAJ TX Pool** | Naira off-ramp (SOL → NGN) | SOL transfer to pool |

### price_monitoring
Real-time SOL/USD price and 24h change via CoinGecko API (free, no key required, 30 calls/min). Evaluates price-based conditions (drops X%, above $Y, below $Z) and powers the background `set_alert` price triggers. Falls back to mock price when offline.

### portfolio_tracking
Display SOL + USDC balances with real-time USD portfolio valuation via `/balance` command.

### naira_offramp
Users configure a PAJ TX Pool address via `/setpool`. When they say "swap SOL to naira", the bot transfers SOL to the pool address for off-chain Naira conversion.

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
hold           → No action (AI decided to wait)
check_balance  → Display balances
```

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
- **Rate limits** — Groq (30 RPM free tier), CoinGecko (30/min)
- **JavaScript memory** — key zeroing is best-effort due to GC

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
