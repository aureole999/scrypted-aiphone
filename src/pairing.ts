import dgram from 'dgram';
import tls from 'tls';
import net from 'net';
import os from 'os';
import { constants } from 'crypto';
import { once } from 'events';
import { API_BASE, Credentials, DEFAULT_IOT_HOST, flatMessage, newClientId, packet, parseSignal, requireSuccess, withTimeout } from './protocol';

export interface PairingOptions { termname: string; address?: string; bindAddress?: string; diagnostics?: (message: string) => void; timeoutMs?: number; }
export function pairingNetworkSummary(): string {
    return Object.entries(os.networkInterfaces()).flatMap(([name, addresses]) =>
        (addresses || []).filter(a => a.family === 'IPv4' && !a.internal).map(a => `${name}: ${a.address}/${a.netmask}`)).join('; ') || 'No external IPv4 interface';
}
export function subnetBroadcast(address: string, netmask: string): string | undefined {
    if (!net.isIPv4(address) || !net.isIPv4(netmask)) return;
    const number = (value: string) => value.split('.').reduce((n, octet) => ((n << 8) | Number(octet)) >>> 0, 0);
    const mask = number(netmask);
    if (mask >= 0xfffffffe || mask === 0) return;
    const broadcast = (number(address) | (~mask >>> 0)) >>> 0;
    return [24, 16, 8, 0].map(shift => (broadcast >>> shift) & 255).join('.');
}
export function discoveryTargets(options: PairingOptions): string[] {
    if (options.address) {
        if (!net.isIPv4(options.address)) throw new Error('Discovery address must be an IPv4 address');
        return [options.address];
    }
    const targets = new Set(['255.255.255.255']);
    for (const addresses of Object.values(os.networkInterfaces())) for (const info of addresses || []) {
        if (info.family !== 'IPv4' || info.internal || (options.bindAddress && options.bindAddress !== info.address)) continue;
        const broadcast = subnetBroadcast(info.address, info.netmask);
        if (broadcast) targets.add(broadcast);
    }
    return [...targets];
}
export async function probePairingNetwork(options: PairingOptions): Promise<void> {
    const log = options.diagnostics || (() => {});
    log(`Interfaces: ${pairingNetworkSummary()}`);
    await discover(options).then(result => log(`Discovered ${result.host}:${result.port}`)).catch(err => log(err.message));
}

export async function discover(options: PairingOptions): Promise<{ host: string; port: number }> {
    const targets = discoveryTargets(options);
    options.diagnostics?.(`UDP targets: ${targets.join(', ')}; source ${options.bindAddress || 'automatic'}; listen 0.0.0.0:51712`);
    const receiver = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const sender = dgram.createSocket('udp4');
    let interval: NodeJS.Timeout | undefined;
    let rejected: { host: string; result: string } | undefined;
    try {
        const ready = once(receiver, 'listening');
        receiver.bind(51712, '0.0.0.0');
        await ready;
        const sending = once(sender, 'listening');
        sender.bind(0, options.bindAddress || '0.0.0.0');
        await sending;
        sender.setBroadcast(true);
        const response = new Promise<{ host: string; port: number }>((resolve, reject) => {
            receiver.on('error', reject);
            sender.on('error', reject);
            const received = (data: Buffer, remote: dgram.RemoteInfo) => {
                try {
                    const msg = flatMessage(parseSignal(data));
                    const port = Number(msg.PORT);
                    options.diagnostics?.(`UDP reply from ${remote.address}:${remote.port}, MID=${String(msg.MID).slice(0, 12)}, RSLT=${String(msg.RSLT).slice(0, 12)}, PORT=${port}`);
                    if (msg.MID === '11001' && Number.isInteger(port) && port > 0 && port < 65536) {
                        if (Number(msg.RSLT ?? 0) === 0) resolve({ host: remote.address, port });
                        else rejected = { host: remote.address, result: String(msg.RSLT).slice(0, 12) };
                    }
                } catch { /* Ignore unrelated UDP datagrams. */ }
            };
            receiver.on('message', received);
            sender.on('message', received);
            // Match the known-good HA discovery datagram byte-for-byte.
            const discovery = Buffer.from('{"HEADER": {"MID": "01001", "VER": "1.0"}}\n');
            const send = () => { for (const target of targets) sender.send(discovery, 51711, target, err => { if (err) reject(err); }); };
            send();
            interval = setInterval(send, 500);
        });
        const timeoutMessage = 'No UDP response from the indoor station. Check pairing mode, the discovery address, and UDP ports 51711/51712. See the plugin console for network details.';
        try { return await withTimeout(response, options.timeoutMs ?? 15000, timeoutMessage); }
        catch (error) {
            if (error instanceof Error && error.message === timeoutMessage && rejected)
                throw new Error(`Indoor station ${rejected.host} rejected discovery (RSLT=${rejected.result}). Re-enter Add Terminal mode and stop other pairing attempts.`);
            throw error;
        }
    } finally {
        if (interval) clearInterval(interval);
        for (const socket of [receiver, sender]) { try { socket.close(); } catch { /* Not bound. */ } }
    }
}

export class PairingConnection {
    private buffer = '';
    private messages: Record<string, any>[] = [];
    private waiter?: { resolve: (msg: Record<string, any>) => void; reject: (err: Error) => void };
    private error?: Error;
    constructor(private socket: tls.TLSSocket) {
        socket.on('data', chunk => {
            this.buffer += chunk.toString('utf8');
            if (this.buffer.length > 1024 * 1024) return socket.destroy(new Error('Pairing response too large'));
            while (this.buffer.includes('\n')) {
                const end = this.buffer.indexOf('\n');
                const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
                if (line.trim()) this.accept(line);
            }
            // Some firmware sends a complete JSON object without a trailing newline.
            if (this.buffer.trim()) {
                try { JSON.parse(this.buffer); } catch { return; }
                const message = this.buffer; this.buffer = ''; this.accept(message);
            }
        });
        const fail = (error: Error) => { this.error = error; this.waiter?.reject(error); this.waiter = undefined; };
        socket.on('error', fail);
        socket.on('close', () => fail(new Error('Doorbell closed the pairing connection')));
    }
    private accept(line: string) {
        try {
            const msg = flatMessage(parseSignal(line));
            if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; waiter.resolve(msg); }
            else this.messages.push(msg);
        } catch { this.socket.destroy(new Error('Invalid pairing JSON')); }
    }
    async request(mid: string, expected: string, body: Record<string, any>): Promise<Record<string, any>> {
        if (this.error) throw this.error;
        const response = this.messages.length ? Promise.resolve(this.messages.shift()!) : new Promise<Record<string, any>>((resolve, reject) => { this.waiter = { resolve, reject }; });
        this.socket.write(packet(mid, body));
        try {
            const msg = await withTimeout(response, 10000, `Pairing timeout waiting for ${expected}`);
            requireSuccess(msg, expected);
            return msg;
        } finally { this.waiter = undefined; }
    }
}

export async function pairAiphone(options: PairingOptions, progress: (text: string) => void = () => {}): Promise<Credentials> {
    const termname = options.termname.trim();
    if (!termname || termname.length > 32) throw new Error('Terminal name must contain 1-32 characters');
    progress('Discovering indoor station');
    const { host, port } = await discover(options);
    const socket = tls.connect({
        host, port, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2',
        // Only local pairing uses the unit's legacy, self-signed wolfSSL server.
        rejectUnauthorized: false, ciphers: 'ALL:@SECLEVEL=0',
        secureOptions: constants.SSL_OP_LEGACY_SERVER_CONNECT,
    });
    const connection = new PairingConnection(socket);
    try {
        await withTimeout(once(socket, 'secureConnect'), 15000, 'Timed out connecting to the indoor station');
        const clientId = newClientId();
        progress('Verifying pairing code');
        const otpMessage = await connection.request('01002', '11002', { CLIID: clientId });
        const otp = otpMessage.OTPASS;
        if (typeof otp !== 'string' || otp.length < 4) throw new Error('Indoor station did not return a valid pairing code');
        await connection.request('01003', '11003', { OTPASS: otp.slice(-4) });
        progress('Registering Aiphone cloud certificate');
        const response = await fetch(`${API_BASE}/registClient`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'AIPHONE IP/3.08' },
            body: JSON.stringify({ BODY: { OTPASS: otp, OSKIND: 1, CLIID: clientId, SYSVER: '3.08', RCVTPC: '', SNDTPC: '', SRVROOTCA: '', SRVURL: '', SEQID: 1, SYS: '2' } }),
            signal: AbortSignal.timeout(20000),
        });
        if (!response.ok) throw new Error(`Aiphone registration failed: HTTP ${response.status}`);
        const cloud = (await response.json() as any).BODY;
        if (!cloud?.CERT || !(cloud.SECKEY || cloud.DVCKEY) || !cloud.CLIID || !cloud.RCVTPC || !cloud.SNDTPC)
            throw new Error('Aiphone registration response is missing certificate or MQTT details');
        progress('Registering terminal name');
        await connection.request('01005', '11005', { CLIID: cloud.CLIID, TERMNM: termname, TERMTPC: cloud.RCVTPC });
        return {
            cliid: cloud.CLIID, iot_host: cloud.URL || DEFAULT_IOT_HOST, sndtpc: cloud.SNDTPC,
            rcvtpc: cloud.RCVTPC, cert_pem: cloud.CERT, seckey_pem: cloud.SECKEY || cloud.DVCKEY,
            termname, unit_mac: cloud.RCVTPC.split('/')[0],
        };
    } finally { socket.destroy(); }
}
