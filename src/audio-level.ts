/** Measure G.711 mu-law without retaining or recording the audio. */
export function pcmuLevelDb(payload: Buffer): number {
    if (!payload.length) return -96;
    let squares = 0;
    for (const byte of payload) {
        const value = (~byte) & 0xff;
        const magnitude = (((value & 15) << 3) + 132) * (1 << ((value >> 4) & 7)) - 132;
        squares += magnitude * magnitude;
    }
    const rms = Math.sqrt(squares / payload.length);
    return Math.max(-96, Math.round(20 * Math.log10(rms / 32768 || 1e-6))) || 0;
}
