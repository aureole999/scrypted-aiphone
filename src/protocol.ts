import { randomUUID } from 'crypto';

export interface Credentials {
    cliid: string; unit_mac: string; iot_host: string; sndtpc: string;
    rcvtpc: string; cert_pem: string; seckey_pem: string; termname: string;
}
export interface Signal { HEADER: Record<string, any>; BODY?: Record<string, any>; }
export const DEFAULT_IOT_HOST = 'a51k9cd2jjxpf-ats.iot.ap-northeast-1.amazonaws.com';
export const API_BASE = 'https://api.aiphone-app.net';
export function sid(): string {
    const d = new Date();
    const pad = (n: number, size = 2) => String(n).padStart(size, '0');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${pad(d.getMilliseconds(), 3)}000`;
}
export function newClientId(): string { return randomUUID().toUpperCase(); }
export function packet(mid: string, body?: Record<string, any>): string {
    return JSON.stringify({ HEADER: { MID: mid, VER: '1.0' }, ...(body ? { BODY: body } : {}) }) + '\n';
}
export function parseSignal(data: string | Buffer): Signal {
    const parsed = JSON.parse(data.toString().trim());
    if (!parsed || typeof parsed.HEADER !== 'object' || parsed.HEADER === null || Array.isArray(parsed.HEADER))
        throw new Error('Invalid Aiphone message');
    return parsed;
}
export function flatMessage(msg: Signal): Record<string, any> { return { ...msg.HEADER, ...msg.BODY }; }
export function credentialsFromJSON(raw: string | object): Credentials {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const data = (parsed as any)?.data ?? parsed;
    const result: Credentials = { ...data, termname: data?.termname || 'Scrypted' };
    for (const field of ['cliid', 'unit_mac', 'iot_host', 'sndtpc', 'rcvtpc', 'cert_pem', 'seckey_pem'] as const) {
        if (typeof result[field] !== 'string' || !result[field].trim()) throw new Error(`Missing credential field: ${field}`);
    }
    if (!result.cert_pem.includes('BEGIN CERTIFICATE') || !/BEGIN (?:RSA |EC )?PRIVATE KEY/.test(result.seckey_pem))
        throw new Error('Invalid client certificate or private key PEM');
    if (!/^[a-zA-Z0-9.-]+$/.test(result.iot_host)) throw new Error('iot_host must be a hostname, without a scheme or port');
    if (result.rcvtpc.split('/')[0] !== result.unit_mac || result.sndtpc.split('/')[0] !== result.unit_mac)
        throw new Error('MQTT topics do not match unit_mac');
    return result;
}
export function stripExtraFingerprints(sdp: string): string {
    return sdp.split(/\r?\n/).filter(l => !l.startsWith('a=fingerprint:') || l.startsWith('a=fingerprint:sha-256 ')).join('\r\n');
}
export function janusOffer(sdp: string): string {
    // WP-2MED's Janus side initiates DTLS. The answerer must be passive.
    return sdp.replace(/a=setup:actpass/g, 'a=setup:active');
}
export function requireSuccess(msg: Record<string, any>, expected: string): void {
    if (msg.MID !== expected) throw new Error(`Unexpected pairing response; expected ${expected}`);
    if (Number(msg.RSLT ?? 1) !== 0) throw new Error(`Aiphone rejected ${expected} (RSLT=${msg.RSLT})`);
}

export class Deferred<T> {
    promise: Promise<T>;
    resolve!: (value: T) => void;
    reject!: (error: Error) => void;
    constructor() {
        this.promise = new Promise<T>((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
        // Handlers can be installed before the operation starts without an unhandled rejection.
        void this.promise.catch(() => {});
    }
}
export async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
    finally { if (timer) clearTimeout(timer); }
}
