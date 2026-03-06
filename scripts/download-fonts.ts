import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

const ASSETS = path.resolve(__dirname, '..', 'assets');

async function downloadFont(weight: number, filename: string) {
    // Use an old IE user-agent to force Google Fonts to return raw .ttf files
    const cssUrl = `https://fonts.googleapis.com/css2?family=Inter:wght@${weight}&display=swap`;
    const cssRes = await axios.get(cssUrl, {
        headers: {
            'User-Agent': 'Mozilla/4.0 (compatible; MSIE 8.0; Windows NT 6.1; Trident/4.0)'
        }
    });

    // With IE user-agent, Google returns truetype format URLs
    const match = cssRes.data.match(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/);
    if (!match) {
        console.log('CSS response:', cssRes.data.substring(0, 500));
        throw new Error(`Could not find font URL for weight ${weight}`);
    }

    const fontUrl = match[1];
    console.log(`Downloading ${filename}...`);

    const fontRes = await axios.get(fontUrl, { responseType: 'arraybuffer' });
    const outPath = path.join(ASSETS, filename);
    fs.writeFileSync(outPath, Buffer.from(fontRes.data));

    const header = fs.readFileSync(outPath).slice(0, 4).toString('hex');
    const size = fs.statSync(outPath).size;
    const isTTF = header === '00010000' || header === '74727565';
    const isWOFF = header === '774f4646';
    console.log(`  ${isTTF ? '✅ TTF' : isWOFF ? '⚠️ WOFF (not TTF!)' : '❓ Unknown'} - ${filename} (${size} bytes, header: ${header})`);
}

async function main() {
    console.log(`Assets dir: ${ASSETS}`);
    if (!fs.existsSync(ASSETS)) fs.mkdirSync(ASSETS, { recursive: true });

    await downloadFont(400, 'Inter-Regular.ttf');
    await downloadFont(500, 'Inter-Medium.ttf');
    await downloadFont(700, 'Inter-Bold.ttf');
    console.log('\nDone!');
}

main().catch(console.error);
