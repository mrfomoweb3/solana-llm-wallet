/**
 * setup.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * One-time setup script:
 *   1. Creates a new encrypted wallet keystore
 *   2. Requests a devnet SOL airdrop
 *   3. Prints the public key and explorer link
 *
 * Run: npm run setup
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as readline from 'readline';
import * as dotenv   from 'dotenv';
import * as fs       from 'fs';
import chalk         from 'chalk';
import { AgentWallet } from '../src/wallet';

dotenv.config();

async function main(): Promise<void> {
  const rl = readline.createInterface({
    input:  process.stdin,
    output: process.stdout,
  });

  const question = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  console.log(chalk.bold.cyan('\n═══════════════════════════════════════════'));
  console.log(chalk.bold.cyan('  Solana LLM Wallet Agent — Setup'));
  console.log(chalk.bold.cyan('═══════════════════════════════════════════\n'));

  // Check for existing keystore
  if (fs.existsSync('.keystore.json')) {
    console.log(chalk.yellow('⚠  A keystore already exists at .keystore.json'));
    const overwrite = await question(chalk.yellow('Overwrite? (type YES to confirm): '));
    if (overwrite !== 'YES') {
      console.log(chalk.gray('Setup cancelled.'));
      rl.close();
      return;
    }
    fs.unlinkSync('.keystore.json');
  }

  // Check for API key
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log(chalk.red('❌ ANTHROPIC_API_KEY not found in .env'));
    console.log(chalk.gray('Create a .env file with: ANTHROPIC_API_KEY=your-key-here'));
    rl.close();
    process.exit(1);
  }

  // Get password
  console.log(chalk.bold('\nChoose a wallet password.'));
  console.log(chalk.gray('This password encrypts your private key. Store it safely — it cannot be recovered.\n'));
  
  const password = await question(chalk.cyan('Enter password: '));
  const confirm  = await question(chalk.cyan('Confirm password: '));

  if (password !== confirm) {
    console.log(chalk.red('❌ Passwords do not match.'));
    rl.close();
    process.exit(1);
  }

  if (password.length < 8) {
    console.log(chalk.red('❌ Password must be at least 8 characters.'));
    rl.close();
    process.exit(1);
  }

  rl.close();

  // Create wallet
  console.log(chalk.gray('\nGenerating keypair and encrypting...\n'));

  const wallet = new AgentWallet();
  const pubkey = await wallet.create(password);

  console.log(chalk.green('✅ Wallet created!'));
  console.log(chalk.bold('Public Key: ') + chalk.yellow(pubkey));

  // Unlock and airdrop
  await wallet.unlock(password);

  console.log(chalk.gray('\nRequesting 2 SOL airdrop from devnet faucet...'));
  
  try {
    const sig = await wallet.requestAirdrop(2);
    const balance = await wallet.getSolBalance();
    console.log(chalk.green(`✅ Airdrop confirmed! Balance: ${balance.toFixed(4)} SOL`));
    console.log(chalk.gray(`   TX: https://explorer.solana.com/tx/${sig}?cluster=devnet`));
  } catch (err) {
    console.log(chalk.yellow('⚠  Airdrop may have failed (rate limited). Try again in 30s.'));
    console.log(chalk.gray(`   Error: ${err}`));
  }

  wallet.lock();

  console.log(chalk.bold.green('\n═══════════════════════════════════════════'));
  console.log(chalk.bold.green('  Setup complete! Run: npm run dev'));
  console.log(chalk.bold.green('═══════════════════════════════════════════\n'));

  // Create .env template if it doesn't exist
  if (!fs.existsSync('.env')) {
    fs.writeFileSync('.env', `ANTHROPIC_API_KEY=\nVERBOSE=false\n`);
    console.log(chalk.gray('Created .env template. Add your ANTHROPIC_API_KEY.\n'));
  }
}

main().catch((err) => {
  console.error(chalk.red('Setup failed:'), err);
  process.exit(1);
});
