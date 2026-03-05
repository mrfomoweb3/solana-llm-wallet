/**
 * receipt.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * High-quality transaction receipt image generator.
 * Ticket-style receipt with Inter font, semi-circle notches, barcode.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createCanvas, loadImage, registerFont } from 'canvas';
import * as path from 'path';
import * as fs from 'fs';

// ─── Register Inter Font ────────────────────────────────────────────────────

const ASSETS = path.resolve(process.cwd(), 'assets');

try {
    registerFont(path.join(ASSETS, 'Inter-Regular.ttf'), { family: 'Inter', weight: 'normal' });
    registerFont(path.join(ASSETS, 'Inter-Medium.ttf'), { family: 'Inter', weight: '500' });
    registerFont(path.join(ASSETS, 'Inter-Bold.ttf'), { family: 'Inter', weight: 'bold' });
} catch { }

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ReceiptData {
    type: 'swap' | 'transfer' | 'stake' | 'dca' | 'pump_buy' | 'pump_sell' | 'swap_to_naira';
    fromToken?: string;
    toToken?: string;
    amount: number;
    amountUSD?: number;
    signature: string;
    network: string;
    walletAddress: string;
    explorerUrl?: string;
    recipient?: string;
    numOrders?: number;
    intervalDays?: number;
    mintAddress?: string;
}

// ─── Design Tokens ──────────────────────────────────────────────────────────

// Canvas at 2x for retina sharpness
const SCALE = 2;
const W = 420 * SCALE;
const H = 580 * SCALE;
const CARD_MARGIN = 30 * SCALE;
const CARD_X = CARD_MARGIN;
const CARD_Y = 20 * SCALE;
const CARD_W = W - CARD_MARGIN * 2;
const CARD_H = H - 40 * SCALE;
const CARD_R = 16 * SCALE;
const NOTCH_R = 18 * SCALE;

const COL = {
    bg: '#EFEFF4',
    card: '#FFFFFF',
    heading: '#111827',
    sub: '#6B7280',
    label: '#9CA3AF',
    value: '#1F2937',
    divider: '#10B981',
    detailBg: '#F0F2FF',
    detailText: '#374151',
    detailSub: '#6B7280',
    dot: '#D1D5DB',
    bar: '#111827',
};

const s = (px: number) => px * SCALE; // Scale helper

// ─── Main Generator ─────────────────────────────────────────────────────────

export async function generateReceipt(data: ReceiptData): Promise<Buffer> {
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');

    // Anti-alias
    (ctx as any).quality = 'best';
    (ctx as any).patternQuality = 'best';

    // ── Background ────────────────────────────────────────────────────────
    ctx.fillStyle = COL.bg;
    ctx.fillRect(0, 0, W, H);

    const notchY = CARD_Y + s(230);

    // ── Ticket shape ──────────────────────────────────────────────────────
    drawTicket(ctx, CARD_X, CARD_Y, CARD_W, CARD_H, CARD_R, notchY, NOTCH_R);
    ctx.fillStyle = COL.card;
    ctx.fill();

    let y = CARD_Y + s(40);
    const cX = W / 2;           // center X
    const lX = CARD_X + s(40);  // left
    const rX = CARD_X + CARD_W - s(40); // right

    // ── Logo ──────────────────────────────────────────────────────────────
    try {
        const logoPath = path.join(ASSETS, 'logo.png');
        if (fs.existsSync(logoPath)) {
            const logo = await loadImage(logoPath);
            const sz = s(52);
            ctx.drawImage(logo, cX - sz / 2, y, sz, sz);
            y += sz + s(16);
        }
    } catch {
        y += s(68);
    }

    // ── Heading ───────────────────────────────────────────────────────────
    ctx.fillStyle = COL.heading;
    ctx.font = `bold ${s(18)}px Inter, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('Transaction Successful', cX, y);
    y += s(20);

    ctx.fillStyle = COL.sub;
    ctx.font = `${s(11)}px Inter, sans-serif`;
    ctx.fillText(getSubtitle(data.type), cX, y);
    ctx.fillText('has been processed successfully.', cX, y + s(16));
    y += s(42);

    // ── Green dashed divider (at notch line) ──────────────────────────────
    ctx.setLineDash([s(7), s(5)]);
    ctx.strokeStyle = COL.divider;
    ctx.lineWidth = s(1.5);
    ctx.beginPath();
    ctx.moveTo(CARD_X + NOTCH_R + s(8), notchY);
    ctx.lineTo(CARD_X + CARD_W - NOTCH_R - s(8), notchY);
    ctx.stroke();
    ctx.setLineDash([]);

    y = notchY + s(30);

    // ── TX SIGNATURE / AMOUNT ─────────────────────────────────────────────
    drawLabel(ctx, 'TX SIGNATURE', lX, y);
    drawLabel(ctx, 'AMOUNT', rX, y, 'right');
    y += s(18);
    drawVal(ctx, data.signature.substring(0, 16) + '...', lX, y);
    drawVal(ctx, `${data.amount} ${data.fromToken ?? 'SOL'}`, rX, y, 'right');
    y += s(32);

    // ── DATE & TIME / USD VALUE ───────────────────────────────────────────
    drawLabel(ctx, 'DATE & TIME', lX, y);
    if (data.amountUSD) drawLabel(ctx, 'USD VALUE', rX, y, 'right');
    y += s(18);

    const now = new Date();
    const mo = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    const dateStr = `${String(now.getDate()).padStart(2, '0')} ${mo[now.getMonth()]}, ${now.getFullYear()} | ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    drawVal(ctx, dateStr, lX, y);
    if (data.amountUSD) drawVal(ctx, `~$${data.amountUSD.toFixed(2)}`, rX, y, 'right');
    y += s(30);

    // ── Detail card ───────────────────────────────────────────────────────
    const dX = CARD_X + s(30);
    const dW = CARD_W - s(60);
    const dH = s(46);

    roundedRect(ctx, dX, y, dW, dH, s(10));
    ctx.fillStyle = COL.detailBg;
    ctx.fill();

    // Colored dot
    const dotCX = dX + s(22);
    const dotCY = y + dH / 2;
    ctx.beginPath();
    ctx.arc(dotCX, dotCY, s(12), 0, Math.PI * 2);
    ctx.fillStyle = getTypeColor(data.type);
    ctx.fill();

    ctx.fillStyle = '#FFF';
    ctx.font = `bold ${s(11)}px Inter, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(getTypeIcon(data.type), dotCX, dotCY + s(4));

    // Detail text
    ctx.fillStyle = COL.detailText;
    ctx.font = `bold ${s(11)}px Inter, sans-serif`;
    ctx.textAlign = 'left';
    ctx.fillText(getDetailTitle(data), dX + s(42), y + s(18));
    ctx.fillStyle = COL.detailSub;
    ctx.font = `${s(9)}px Inter, sans-serif`;
    ctx.fillText(getDetailSubtitle(data), dX + s(42), y + s(34));
    y += dH + s(24);

    // ── WALLET / NETWORK ──────────────────────────────────────────────────
    drawLabel(ctx, 'WALLET', lX, y);
    drawLabel(ctx, 'NETWORK', rX, y, 'right');
    y += s(18);
    drawVal(ctx, data.walletAddress.substring(0, 14) + '...', lX, y);
    drawVal(ctx, data.network === 'devnet' ? 'Devnet' : 'Mainnet', rX, y, 'right');
    y += s(30);

    // ── Barcode ───────────────────────────────────────────────────────────
    const barcodeW = s(150);
    const barcodeH = s(38);
    drawBarcode(ctx, cX - barcodeW / 2, y, barcodeW, barcodeH, data.signature);
    y += barcodeH + s(8);

    ctx.fillStyle = COL.label;
    ctx.font = `${s(7)}px Inter, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(data.signature.substring(0, 30), cX, y);
    y += s(20);

    // ── Three dots ────────────────────────────────────────────────────────
    const footY = CARD_Y + CARD_H - s(22);
    for (let i = -1; i <= 1; i++) {
        ctx.beginPath();
        ctx.arc(cX + i * s(18), footY, s(5), 0, Math.PI * 2);
        ctx.fillStyle = COL.dot;
        ctx.fill();
    }

    return canvas.toBuffer('image/png');
}

// ─── Ticket Shape ───────────────────────────────────────────────────────────

function drawTicket(
    ctx: any, x: number, y: number, w: number, h: number,
    r: number, notchY: number, nr: number
) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, notchY - nr);
    ctx.arc(x + w, notchY, nr, -Math.PI / 2, Math.PI / 2, true);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, notchY + nr);
    ctx.arc(x, notchY, nr, Math.PI / 2, -Math.PI / 2, true);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}

// ─── Barcode ────────────────────────────────────────────────────────────────

function drawBarcode(ctx: any, x: number, y: number, w: number, h: number, seed: string) {
    const bars: number[] = [];
    for (let i = 0; i < seed.length && bars.length < 50; i++) {
        bars.push((seed.charCodeAt(i) % 3) + 1);
    }
    while (bars.length < 50) bars.push(2);

    const total = bars.reduce((a, b) => a + b, 0);
    const unit = w / total;
    let bx = x;

    for (let i = 0; i < bars.length; i++) {
        const bw = bars[i] * unit;
        if (i % 2 === 0) {
            ctx.fillStyle = COL.bar;
            ctx.fillRect(bx, y, bw, h);
        }
        bx += bw;
    }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function drawLabel(ctx: any, text: string, x: number, y: number, align: string = 'left') {
    ctx.fillStyle = COL.label;
    ctx.font = `bold ${s(8)}px Inter, sans-serif`;
    ctx.textAlign = align;
    ctx.fillText(text, x, y);
}

function drawVal(ctx: any, text: string, x: number, y: number, align: string = 'left') {
    ctx.fillStyle = COL.value;
    ctx.font = `bold ${s(11)}px Inter, sans-serif`;
    ctx.textAlign = align;
    ctx.fillText(text, x, y);
}

function roundedRect(ctx: any, x: number, y: number, w: number, h: number, r: number) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}

function getSubtitle(type: ReceiptData['type']): string {
    const m: Record<string, string> = {
        swap: 'Your token swap', transfer: 'Your SOL transfer',
        stake: 'Your SOL stake', dca: 'Your DCA position',
        pump_buy: 'Your Pump.fun purchase', pump_sell: 'Your Pump.fun sale',
        swap_to_naira: 'Your naira off-ramp',
    };
    return m[type] ?? 'Your transaction';
}

function getTypeColor(type: ReceiptData['type']): string {
    const m: Record<string, string> = {
        swap: '#3B82F6', transfer: '#8B5CF6', stake: '#10B981',
        dca: '#F59E0B', pump_buy: '#EF4444', pump_sell: '#EF4444',
        swap_to_naira: '#059669',
    };
    return m[type] ?? '#6366F1';
}

function getTypeIcon(type: ReceiptData['type']): string {
    const m: Record<string, string> = {
        swap: '⇄', transfer: '↗', stake: '◆', dca: '↺',
        pump_buy: '🚀', pump_sell: '💰', swap_to_naira: '₦',
    };
    return m[type] ?? '✓';
}

function getDetailTitle(data: ReceiptData): string {
    const m: Record<string, string> = {
        swap: `${data.fromToken ?? 'SOL'} → ${data.toToken ?? 'USDC'} Swap`,
        transfer: `Sent to ${(data.recipient ?? '').substring(0, 12)}...`,
        stake: `${data.amount} SOL Staked`,
        dca: `DCA: ${data.fromToken ?? 'SOL'} → ${data.toToken ?? 'USDC'}`,
        pump_buy: 'Bought on Pump.fun',
        pump_sell: 'Sold on Pump.fun',
        swap_to_naira: `${data.fromToken ?? 'SOL'} → Naira`,
    };
    return m[data.type] ?? 'Transaction';
}

function getDetailSubtitle(data: ReceiptData): string {
    const m: Record<string, string> = {
        swap: 'via Jupiter Aggregator',
        transfer: 'Native SOL Transfer',
        stake: 'Native Solana Staking',
        dca: `${data.numOrders ?? '?'} orders over ${data.intervalDays ?? '?'} days`,
        pump_buy: `Mint: ${(data.mintAddress ?? '').substring(0, 16)}...`,
        pump_sell: `Mint: ${(data.mintAddress ?? '').substring(0, 16)}...`,
        swap_to_naira: 'PAJ TX Pool Off-Ramp',
    };
    return m[data.type] ?? '';
}
