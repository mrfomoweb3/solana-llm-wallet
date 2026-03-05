/**
 * price-feed.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Price feed module. Fetches SOL/USD price and 24h change from CoinGecko's
 * free API (no API key required).
 *
 * Falls back to a mock price generator when offline (useful for CI/testing).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import axios from 'axios';
import { logger } from './logger';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PriceData {
  solPriceUSD: number;
  priceChange24h: number; // percent, can be negative
  source: 'coingecko' | 'mock';
  fetchedAt: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

// CoinGecko free API — no key required, 30 calls/min
const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price';

// ─── Price State ──────────────────────────────────────────────────────────────

let _lastPrice: PriceData | null = null;
let _mockBasePrice = 145.0;

// ─── Core Functions ───────────────────────────────────────────────────────────

/**
 * Fetch live SOL price from CoinGecko.
 * Returns cached value if called within 15s of last fetch (respect rate limits).
 */
export async function getSOLPrice(): Promise<PriceData> {
  // Use cache if fresh enough (15s — CoinGecko rate limit is 30/min)
  if (_lastPrice && _lastPrice.source === 'coingecko' &&
    Date.now() - new Date(_lastPrice.fetchedAt).getTime() < 15_000) {
    return _lastPrice;
  }

  try {
    const res = await axios.get(COINGECKO_URL, {
      params: {
        ids: 'solana',
        vs_currencies: 'usd',
        include_24hr_change: 'true',
      },
      timeout: 8000,
    });

    const solData = res.data?.solana;
    if (!solData || typeof solData.usd !== 'number') {
      throw new Error('No SOL price data in CoinGecko response');
    }

    const price: PriceData = {
      solPriceUSD: solData.usd,
      priceChange24h: solData.usd_24h_change ?? 0,
      source: 'coingecko',
      fetchedAt: new Date().toISOString(),
    };

    _lastPrice = price;
    logger.audit('PRICE_CONDITION_CHECK', `SOL: $${price.solPriceUSD.toFixed(2)} (${price.priceChange24h >= 0 ? '+' : ''}${price.priceChange24h.toFixed(2)}% 24h)`, { price });
    return price;

  } catch (err) {
    logger.warn('CoinGecko price feed unreachable, using mock price', { error: String(err) });
    return getMockPrice();
  }
}

/**
 * Deterministic mock price for testing/offline use.
 * Simulates realistic price movement with a random walk.
 */
export function getMockPrice(): PriceData {
  const delta = (_mockBasePrice * 0.02 * (Math.random() - 0.5));
  _mockBasePrice = Math.max(50, _mockBasePrice + delta);

  const change24h = ((Math.random() - 0.5) * 10);

  const price: PriceData = {
    solPriceUSD: parseFloat(_mockBasePrice.toFixed(2)),
    priceChange24h: parseFloat(change24h.toFixed(2)),
    source: 'mock',
    fetchedAt: new Date().toISOString(),
  };

  _lastPrice = price;
  return price;
}

/**
 * Monitor price continuously and emit when a condition is met.
 * Returns an async generator that yields prices.
 */
export async function* priceFeedGenerator(
  intervalMs: number = 15_000
): AsyncGenerator<PriceData> {
  while (true) {
    const price = await getSOLPrice();
    yield price;
    await sleep(intervalMs);
  }
}

/**
 * Check whether a price-based condition is currently satisfied.
 * Used by the agent to decide whether to execute a deferred instruction.
 */
export function checkPriceCondition(
  instruction: string,
  price: PriceData
): { conditionMet: boolean; description: string } {
  const lower = instruction.toLowerCase();

  // "if price drops 5%" or "if down 5%"
  const dropMatch = lower.match(/(?:drops?|down|falls?|decreases?)\s+(\d+(?:\.\d+)?)\s*%/);
  if (dropMatch) {
    const threshold = parseFloat(dropMatch[1]);
    const conditionMet = price.priceChange24h <= -threshold;
    return {
      conditionMet,
      description: `Price drop ${Math.abs(price.priceChange24h).toFixed(2)}% vs threshold ${threshold}%`,
    };
  }

  // "if price rises 5%" or "if up 5%"
  const riseMatch = lower.match(/(?:rises?|up|gains?|increases?)\s+(\d+(?:\.\d+)?)\s*%/);
  if (riseMatch) {
    const threshold = parseFloat(riseMatch[1]);
    const conditionMet = price.priceChange24h >= threshold;
    return {
      conditionMet,
      description: `Price rise ${price.priceChange24h.toFixed(2)}% vs threshold ${threshold}%`,
    };
  }

  // "if price below $X"
  const belowMatch = lower.match(/(?:below|under|less than)\s+\$?(\d+(?:\.\d+)?)/);
  if (belowMatch) {
    const threshold = parseFloat(belowMatch[1]);
    const conditionMet = price.solPriceUSD < threshold;
    return {
      conditionMet,
      description: `Price $${price.solPriceUSD} vs below threshold $${threshold}`,
    };
  }

  // "if price above $X"
  const aboveMatch = lower.match(/(?:above|over|more than)\s+\$?(\d+(?:\.\d+)?)/);
  if (aboveMatch) {
    const threshold = parseFloat(aboveMatch[1]);
    const conditionMet = price.solPriceUSD > threshold;
    return {
      conditionMet,
      description: `Price $${price.solPriceUSD} vs above threshold $${threshold}`,
    };
  }

  // No condition found — treat as "execute now"
  return { conditionMet: true, description: 'No price condition detected — execute immediately' };
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
