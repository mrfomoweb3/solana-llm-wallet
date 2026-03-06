import { generateReceipt } from '../src/receipt';
import * as fs from 'fs';

async function test() {
    console.log("Generating receipt...");
    const buf = await generateReceipt({
        type: 'swap',
        fromToken: 'SOL',
        toToken: 'USDC',
        amount: 0.1,
        amountUSD: 14.50,
        signature: '5xYzx34d9asdf823jsdf',
        network: 'devnet',
        walletAddress: '3fA...2Bs'
    });
    fs.writeFileSync('test-receipt.png', buf);
    console.log("Saved to test-receipt.png");
}

test().catch(console.error);
