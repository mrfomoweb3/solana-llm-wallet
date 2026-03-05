/**
 * receipt.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Transaction receipt image generator.
 * Creates beautiful receipt images for completed transactions.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createCanvas, loadImage, registerFont } from 'canvas';
import * as path from 'path';
import * as fs from 'fs';

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
    // Extra fields
    recipient?: string;
    numOrders?: number;
    intervalDays?: number;
    mintAddress?: string;
}

// ─── Colors ─────────────────────────────────────────────────────────────────

const COLORS = {
    bg: '#FFFFFF',
    cardBg: '#FAFBFC',
    primary: '#7C3AED',     // Purple (from logo)
    secondary: '#10B981',   // Green (from logo)
    textDark: '#1A1A2E',
    textMedium: '#4A5568',
    textLight: '#A0AEC0',
    border: '#E2E8F0',
    success: '#10B981',
    divider: '#CBD5E0',
    labelBg: '#F1F5F9',
};

// ─── Receipt Generator ─────────────────────────────────────────────────────

const RECEIPT_W = 600;
const RECEIPT_H = 750;
const LOGO_SIZE = 70;

function getTypeLabel(type: ReceiptData['type']): string {
    switch (type) {
        case 'swap': return 'Token Swap';
        case 'transfer': return 'SOL Transfer';
        case 'stake': return 'SOL Staked';
        case 'dca': return 'DCA Position';
        case 'pump_buy': return 'Pump.fun Buy';
        case 'pump_sell': return 'Pump.fun Sell';
        case 'swap_to_naira': return 'Naira Off-Ramp';
        default: return 'Transaction';
    }
}

function getTypeEmoji(type: ReceiptData['type']): string {
    switch (type) {
        case 'swap': return '🔄';
        case 'transfer': return '📤';
        case 'stake': return '🪨';
        case 'dca': return '📈';
        case 'pump_buy': return '🚀';
        case 'pump_sell': return '💰';
        case 'swap_to_naira': return '🏦';
        default: return '✅';
    }
}

export async function generateReceipt(data: ReceiptData): Promise<Buffer> {
    const canvas = createCanvas(RECEIPT_W, RECEIPT_H);
    const ctx = canvas.getContext('2d');

    // ── Background ────────────────────────────────────────────────────────
    // Rounded card with shadow effect
    ctx.fillStyle = '#F0F0F5';
    ctx.fillRect(0, 0, RECEIPT_W, RECEIPT_H);

    // White card
    const cardX = 20, cardY = 20;
    const cardW = RECEIPT_W - 40, cardH = RECEIPT_H - 40;
    roundedRect(ctx, cardX, cardY, cardW, cardH, 20);
    ctx.fillStyle = COLORS.bg;
    ctx.fill();

    // Subtle shadow
    ctx.shadowColor = 'rgba(0,0,0,0.08)';
    ctx.shadowBlur = 20;
    ctx.shadowOffsetY = 4;
    roundedRect(ctx, cardX, cardY, cardW, cardH, 20);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;

    let y = 50;

    // ── Logo ──────────────────────────────────────────────────────────────
    try {
        const logoPath = path.resolve(process.cwd(), 'assets', 'logo.png');
        if (fs.existsSync(logoPath)) {
            const logo = await loadImage(logoPath);
            const logoX = (RECEIPT_W - LOGO_SIZE) / 2;
            ctx.drawImage(logo, logoX, y, LOGO_SIZE, LOGO_SIZE);
        }
    } catch { }
    y += LOGO_SIZE + 10;

    // ── Title ─────────────────────────────────────────────────────────────
    ctx.fillStyle = COLORS.textDark;
    ctx.font = 'bold 22px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Transaction Successful', RECEIPT_W / 2, y + 20);
    y += 30;

    ctx.fillStyle = COLORS.textMedium;
    ctx.font = '14px Arial, sans-serif';
    ctx.fillText(`${getTypeLabel(data.type)} on ${data.network === 'devnet' ? 'Devnet' : 'Mainnet'}`, RECEIPT_W / 2, y + 15);
    y += 30;

    // ── Dashed divider ────────────────────────────────────────────────────
    drawDashedLine(ctx, 50, y + 5, RECEIPT_W - 50, y + 5, COLORS.divider);
    y += 25;

    // ── Transaction details ───────────────────────────────────────────────
    const leftX = 60;
    const rightX = RECEIPT_W - 60;

    // TX ID
    drawLabel(ctx, 'TX SIGNATURE', leftX, y);
    drawValue(ctx, data.signature.substring(0, 24) + '...', leftX, y + 20);

    // Amount
    drawLabel(ctx, 'AMOUNT', rightX, y, 'right');
    const amountStr = data.type === 'swap_to_naira'
        ? `${data.amount} ${data.fromToken ?? 'SOL'}`
        : `${data.amount} ${data.fromToken ?? 'SOL'}`;
    drawValue(ctx, amountStr, rightX, y + 20, 'right');
    y += 55;

    // Date & Time
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase();
    const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });

    drawLabel(ctx, 'DATE & TIME', leftX, y);
    drawValue(ctx, `${dateStr} | ${timeStr}`, leftX, y + 20);

    // USD Value
    if (data.amountUSD) {
        drawLabel(ctx, 'USD VALUE', rightX, y, 'right');
        drawValue(ctx, `~$${data.amountUSD.toFixed(2)}`, rightX, y + 20, 'right');
    }
    y += 55;

    // ── Type-specific details ─────────────────────────────────────────────

    // Detail row with colored background
    const detailY = y;
    roundedRect(ctx, 50, detailY, RECEIPT_W - 100, 50, 10);
    ctx.fillStyle = COLORS.labelBg;
    ctx.fill();

    ctx.fillStyle = COLORS.primary;
    ctx.font = 'bold 14px Arial, sans-serif';
    ctx.textAlign = 'left';

    switch (data.type) {
        case 'swap':
            ctx.fillText(`${data.fromToken ?? 'SOL'} → ${data.toToken ?? 'USDC'}`, 70, detailY + 22);
            ctx.fillStyle = COLORS.textMedium;
            ctx.font = '12px Arial, sans-serif';
            ctx.fillText('Token Swap via Jupiter', 70, detailY + 40);
            break;
        case 'stake':
            ctx.fillText(`${data.amount} SOL Staked`, 70, detailY + 22);
            ctx.fillStyle = COLORS.textMedium;
            ctx.font = '12px Arial, sans-serif';
            ctx.fillText('Native Solana Staking', 70, detailY + 40);
            break;
        case 'dca':
            ctx.fillText(`DCA: ${data.fromToken ?? 'SOL'} → ${data.toToken ?? 'USDC'}`, 70, detailY + 22);
            ctx.fillStyle = COLORS.textMedium;
            ctx.font = '12px Arial, sans-serif';
            ctx.fillText(`${data.numOrders ?? '?'} orders over ${data.intervalDays ?? '?'} days`, 70, detailY + 40);
            break;
        case 'swap_to_naira':
            ctx.fillText(`${data.amount} ${data.fromToken ?? 'SOL'} → Naira`, 70, detailY + 22);
            ctx.fillStyle = COLORS.textMedium;
            ctx.font = '12px Arial, sans-serif';
            ctx.fillText('PAJ TX Pool Off-Ramp', 70, detailY + 40);
            break;
        case 'pump_buy':
        case 'pump_sell':
            ctx.fillText(`Pump.fun ${data.type === 'pump_buy' ? 'Buy' : 'Sell'}`, 70, detailY + 22);
            ctx.fillStyle = COLORS.textMedium;
            ctx.font = '12px Arial, sans-serif';
            ctx.fillText(`Mint: ${(data.mintAddress ?? '').substring(0, 20)}...`, 70, detailY + 40);
            break;
        case 'transfer':
            ctx.fillText(`${data.amount} SOL Sent`, 70, detailY + 22);
            ctx.fillStyle = COLORS.textMedium;
            ctx.font = '12px Arial, sans-serif';
            ctx.fillText(`To: ${(data.recipient ?? '').substring(0, 24)}...`, 70, detailY + 40);
            break;
    }
    y += 70;

    // ── Wallet info ───────────────────────────────────────────────────────
    drawLabel(ctx, 'WALLET', leftX, y);
    drawValue(ctx, data.walletAddress.substring(0, 20) + '...', leftX, y + 20);

    drawLabel(ctx, 'NETWORK', rightX, y, 'right');
    drawValue(ctx, data.network === 'devnet' ? 'Devnet' : 'Mainnet', rightX, y + 20, 'right');
    y += 55;

    // ── Dashed divider ────────────────────────────────────────────────────
    drawDashedLine(ctx, 50, y, RECEIPT_W - 50, y, COLORS.divider);
    y += 25;

    // ── Footer ────────────────────────────────────────────────────────────
    ctx.fillStyle = COLORS.textLight;
    ctx.font = '11px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Powered by ORE AI • Autonomous Solana Wallet Agent', RECEIPT_W / 2, y + 5);
    y += 20;
    ctx.fillText(`solscan.io/tx/${data.signature.substring(0, 16)}...`, RECEIPT_W / 2, y + 5);

    // ── Decorative accent bar at top ──────────────────────────────────────
    const gradient = ctx.createLinearGradient(0, 0, RECEIPT_W, 0);
    gradient.addColorStop(0, COLORS.primary);
    gradient.addColorStop(1, COLORS.secondary);
    roundedRectTop(ctx, cardX, cardY, cardW, 6, 20);
    ctx.fillStyle = gradient;
    ctx.fill();

    return canvas.toBuffer('image/png');
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function drawLabel(ctx: any, text: string, x: number, y: number, align: string = 'left') {
    ctx.fillStyle = COLORS.textLight;
    ctx.font = 'bold 10px Arial, sans-serif';
    ctx.textAlign = align;
    ctx.fillText(text, x, y);
}

function drawValue(ctx: any, text: string, x: number, y: number, align: string = 'left') {
    ctx.fillStyle = COLORS.textDark;
    ctx.font = 'bold 15px Arial, sans-serif';
    ctx.textAlign = align;
    ctx.fillText(text, x, y);
}

function drawDashedLine(ctx: any, x1: number, y1: number, x2: number, y2: number, color: string) {
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.setLineDash([]);
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

function roundedRectTop(ctx: any, x: number, y: number, w: number, h: number, r: number) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x, y + h);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}
