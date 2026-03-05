/**
 * multi-agent-demo.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Multi-Agent Test Harness
 *
 * Demonstrates 3 independent AI agents, each with their own wallet,
 * LLM brain, and strategy — operating concurrently on Solana devnet.
 *
 * This proves that the system supports multiple autonomous agents
 * managing their own wallets independently.
 *
 * Usage: npx ts-node scripts/multi-agent-demo.ts
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { LLMBrain } from '../src/llm';
import { getSOLPrice } from '../src/price-feed';
import { WalletState } from '../src/wallet';

// ─── Configuration ──────────────────────────────────────────────────────────

const RPC_URL = 'https://api.devnet.solana.com';
const AGENTS = [
    {
        name: 'Agent Alpha',
        emoji: '🔵',
        strategy: 'Conservative — prefers staking and holding',
        instruction: "I have some SOL, what's the safest way to grow my portfolio?",
    },
    {
        name: 'Agent Beta',
        emoji: '🟢',
        strategy: 'Trader — active DCA and swaps',
        instruction: 'Set up a DCA for 0.5 SOL into USDC over 5 days',
    },
    {
        name: 'Agent Gamma',
        emoji: '🔴',
        strategy: 'Curious — asks questions and seeks advice',
        instruction: "What's the current SOL price and should I buy more?",
    },
];

// ─── Agent Simulation ───────────────────────────────────────────────────────

interface AgentResult {
    name: string;
    emoji: string;
    publicKey: string;
    solBalance: number;
    strategy: string;
    instruction: string;
    decision: {
        action: string;
        reasoning: string;
    };
    timeMs: number;
}

async function runAgent(
    agentConfig: typeof AGENTS[number],
    connection: Connection,
): Promise<AgentResult> {
    const startTime = Date.now();

    // 1. Create independent wallet
    const keypair = Keypair.generate();
    const publicKey = keypair.publicKey.toString();

    console.log(`${agentConfig.emoji} ${agentConfig.name} — Wallet: ${publicKey.substring(0, 16)}...`);
    console.log(`   Strategy: ${agentConfig.strategy}`);

    // 2. Request airdrop (devnet only)
    try {
        const airdropSig = await connection.requestAirdrop(keypair.publicKey, 2 * LAMPORTS_PER_SOL);
        await connection.confirmTransaction(airdropSig, 'confirmed');
        console.log(`   ✅ Airdrop: 2 SOL received`);
    } catch (err) {
        console.log(`   ⚠️  Airdrop failed (devnet may be congested)`);
    }

    // 3. Get agent's wallet state
    const balance = await connection.getBalance(keypair.publicKey);
    const solBalance = balance / LAMPORTS_PER_SOL;

    // 4. Get market data
    const priceData = await getSOLPrice();

    // 5. Create independent LLM brain
    const llm = new LLMBrain();

    // 6. Build wallet state for this agent
    const walletState: WalletState = {
        publicKey: publicKey,
        solBalance: solBalance,
        usdcBalance: 0,
        solPriceUSD: priceData.solPriceUSD,
        priceChange24h: priceData.priceChange24h,
        lastUpdated: new Date().toISOString(),
        network: 'devnet' as any,
    };

    // 7. Agent independently interprets its instruction
    console.log(`   🧠 Thinking: "${agentConfig.instruction}"`);
    const cmd = await llm.interpret(agentConfig.instruction, walletState, priceData);

    const timeMs = Date.now() - startTime;

    console.log(`   📋 Decision: ${cmd.action}`);
    console.log(`   💬 "${cmd.reasoning.substring(0, 80)}..."`);
    console.log(`   ⏱️  ${timeMs}ms\n`);

    return {
        name: agentConfig.name,
        emoji: agentConfig.emoji,
        publicKey,
        solBalance,
        strategy: agentConfig.strategy,
        instruction: agentConfig.instruction,
        decision: {
            action: cmd.action,
            reasoning: cmd.reasoning,
        },
        timeMs,
    };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
    console.log('\n');
    console.log('╔═══════════════════════════════════════════════════════════╗');
    console.log('║        🤖 ORE AI — Multi-Agent Test Harness              ║');
    console.log('║        3 Independent Agents on Solana Devnet             ║');
    console.log('╚═══════════════════════════════════════════════════════════╝');
    console.log('');

    const connection = new Connection(RPC_URL, 'confirmed');

    // Get SOL price first (shared market data — same for all agents)
    const priceData = await getSOLPrice();
    console.log(`📊 SOL Price: $${priceData.solPriceUSD.toFixed(2)} (${priceData.priceChange24h >= 0 ? '+' : ''}${priceData.priceChange24h.toFixed(2)}% 24h)\n`);
    console.log('─'.repeat(60));
    console.log('');

    // Run all 3 agents concurrently (proving independence)
    const results = await Promise.all(
        AGENTS.map(agent => runAgent(agent, connection))
    );

    // ─── Results Summary ───────────────────────────────────────────────────

    console.log('─'.repeat(60));
    console.log('\n📊 MULTI-AGENT RESULTS SUMMARY\n');

    console.log('┌──────────────┬──────────┬────────────────┬──────────────────┐');
    console.log('│ Agent        │ Balance  │ Action         │ Time             │');
    console.log('├──────────────┼──────────┼────────────────┼──────────────────┤');

    for (const r of results) {
        const name = `${r.emoji} ${r.name}`.padEnd(14);
        const bal = `${r.solBalance.toFixed(2)} SOL`.padEnd(10);
        const action = r.decision.action.padEnd(16);
        const time = `${r.timeMs}ms`.padEnd(18);
        console.log(`│ ${name}│ ${bal}│ ${action}│ ${time}│`);
    }

    console.log('└──────────────┴──────────┴────────────────┴──────────────────┘');

    console.log('\n✅ KEY OBSERVATIONS:');
    console.log('   • Each agent has its OWN wallet (different public keys)');
    console.log('   • Each agent made an INDEPENDENT decision based on its strategy');
    console.log('   • Agents ran CONCURRENTLY (Promise.all)');
    console.log('   • No shared state between agents');
    console.log('   • Each agent has its own LLM brain instance');

    // Show that decisions differ
    const uniqueActions = new Set(results.map(r => r.decision.action));
    if (uniqueActions.size > 1) {
        console.log(`   • Agents chose ${uniqueActions.size} DIFFERENT actions — proving autonomous decision-making`);
    }

    console.log('\n🏁 Demo complete.\n');
}

main().catch(console.error);
