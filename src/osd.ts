import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { OSD_HEIGHT, OSD_WIDTH, FRAME_BYTES } from './video-frames';

export const DIRECT_MODE = 'Direct';
export const STATUS_MODE = 'Status + OSD (Experimental)';
export interface OsdState {
    online: boolean;
    call: string;
    capturedAt?: number;
    videoStalled?: boolean;
}
const timeFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
type Glyph = { width: number; alpha: Buffer };
let font: { height: number; glyphs: Map<string, Glyph> } | undefined;
function loadFont() {
    if (font) return font;
    const path = [resolve(__dirname, 'fs/osd/glyphs.json'), resolve(__dirname, '../fs/osd/glyphs.json')].find(existsSync);
    if (!path) throw new Error('OSD font is missing. Reinstall the plugin.');
    const saved = JSON.parse(readFileSync(path, 'utf8')) as { height: number; glyphs: Record<string, { width: number; alpha: string }> };
    font = { height: saved.height, glyphs: new Map(Object.entries(saved.glyphs).map(([char, glyph]) =>
        [char, { width: glyph.width, alpha: Buffer.from(glyph.alpha, 'base64') }])) };
    return font;
}
export function osdTime(time: number) {
    const parts = timeFormat.formatToParts(time);
    const p = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}
function text(frame: Buffer, value: string, x: number, y: number, color = [245, 248, 252]) {
    const font = loadFont();
    for (const char of value) {
        const glyph = font.glyphs.get(char) || font.glyphs.get('?')!;
        if (x + glyph.width > OSD_WIDTH - 8) break;
        for (let row = 0; row < font.height && y + row < OSD_HEIGHT; row++) {
            for (let col = 0; col < glyph.width; col++) {
                const alpha = glyph.alpha[row * glyph.width + col];
                if (!alpha) continue;
                const pos = ((y + row) * OSD_WIDTH + x + col) * 3;
                for (let c = 0; c < 3; c++) frame[pos + c] = Math.round((frame[pos + c] * (255 - alpha) + color[c] * alpha) / 255);
            }
        }
        x += glyph.width + 1;
    }
}
export function renderOsd(image: Buffer, state: OsdState, live: boolean, connecting = false, now = Date.now()) {
    if (image.length !== FRAME_BYTES) throw new Error('Invalid OSD input dimensions');
    const output = Buffer.from(image);
    // Opaque enough for legibility while preserving the view underneath.
    for (let y = 0; y < OSD_HEIGHT; y++) {
        if (y >= 70 && y < OSD_HEIGHT - 36) continue;
        for (let x = 0; x < OSD_WIDTH; x++) {
            const pos = (y * OSD_WIDTH + x) * 3;
            for (let c = 0; c < 3; c++) output[pos + c] = Math.round(output[pos + c] * 0.2 + [12, 17, 25][c] * 0.8);
        }
    }
    text(output, 'AIPHONE   EXPERIMENTAL', 14, 8, [160, 181, 205]);
    const connection = state.online ? 'Connected' : 'Offline';
    const call = connecting && state.online && state.call === 'Idle' ? 'Connecting' : state.call;
    text(output, `${connection} | ${call}`, 14, 39,
        !state.online ? [255, 138, 138]
            : /Ringing|Requesting|Connecting|Preparing|mic off/.test(call) ? [255, 211, 113] : [143, 231, 189]);
    const footer = live ? state.videoStalled ? 'Live | Waiting for video' : `Live | ${osdTime(now)} JST`
        : state.capturedAt ? `Snapshot | ${osdTime(state.capturedAt)} JST` : 'Snapshot | No image available';
    text(output, footer, 14, OSD_HEIGHT - 29, state.videoStalled ? [255, 211, 113] : [180, 194, 211]);
    return output;
}
