import { EventEmitter } from 'events';
import mqtt, { MqttClient } from 'mqtt';
import { AiphoneSession, Signaling } from './media';
import { Credentials, Deferred, parseSignal, sid, Signal, withTimeout } from './protocol';

type Pending = { deferred: Deferred<Signal>; timer: NodeJS.Timeout };
export class AiphoneController extends EventEmitter implements Signaling {
    online = false;
    state: 'idle' | 'ringing' | 'answered' = 'idle';
    caller = '';
    session?: AiphoneSession;
    private client?: MqttClient;
    private pending = new Map<string, Pending>();
    private ringTimer?: NodeJS.Timeout;
    private ringId?: string;
    private seenRings = new Set<string>();
    private opening?: Promise<AiphoneSession>;
    private ringing?: Promise<void>;
    private stopped = false;
    constructor(readonly credentials: Credentials, readonly log: (message: string) => void) { super(); }
    start() {
        if (this.client) return;
        this.client = mqtt.connect({
            protocol: 'mqtts', host: this.credentials.iot_host, port: 8883,
            clientId: this.credentials.cliid, clean: false, protocolVersion: 4,
            cert: this.credentials.cert_pem, key: this.credentials.seckey_pem,
            ALPNProtocols: ['x-amzn-mqtt-ca'], rejectUnauthorized: true,
            keepalive: 60, reconnectPeriod: 5000, connectTimeout: 20000,
        });
        this.client.on('connect', () => {
            this.client!.subscribe(`${this.credentials.unit_mac}/#`, { qos: 1 }, (err, grants) => {
                if (err || grants?.some(g => g.qos === 128)) { this.log('MQTT subscription failed'); return; }
                this.online = true; this.emit('state'); this.log('Aiphone MQTT connected');
            });
        });
        this.client.on('offline', () => this.disconnected());
        this.client.on('close', () => this.disconnected());
        this.client.on('error', err => this.log(`MQTT: ${err.message}`));
        this.client.on('message', (_topic, payload) => {
            if (payload.length > 256 * 1024) return;
            try { this.receive(parseSignal(payload)); }
            catch (err) { this.log(`Signal handling failed: ${(err as Error).message}`); }
        });
    }
    private disconnected() {
        if (this.ringTimer) clearTimeout(this.ringTimer);
        this.ringId = undefined; this.state = 'idle';
        if (this.online) { this.online = false; this.emit('state'); }
        for (const { deferred, timer } of this.pending.values()) { clearTimeout(timer); deferred.reject(new Error('Aiphone MQTT disconnected')); }
        this.pending.clear();
        if (this.session && !this.session.closed) void this.session.close(true).catch(() => {});
    }
    send(mid: string, cid: string, body: Record<string, any> = {}, fields: Record<string, any> = {}) {
        if (!this.online || !this.client?.connected) throw new Error('Aiphone MQTT is not connected');
        const c = this.credentials;
        const msg: Signal = { HEADER: {
            MID: mid, VER: '1.0', SYS: '2', CLIID: c.cliid, PCLIID: c.sndtpc.split('/').pop(),
            RCVTPC: c.rcvtpc, SNDTPC: c.sndtpc, SID: sid(), ...(cid ? { CID: cid } : {}),
            RSLT: 0, LEN: body.SDP?.length || 0, ...fields,
        }, BODY: body };
        this.client.publish(c.sndtpc, JSON.stringify(msg) + '\n', { qos: 1 }, err => {
            if (err) this.log(`MQTT publish ${mid} failed`);
        });
    }
    async request(mid: string, reply: string, cid: string, body?: Record<string, any>, fields?: Record<string, any>, timeout = 13000): Promise<Signal> {
        const key = `${cid}:${reply}`;
        if (this.pending.has(key)) throw new Error(`Aiphone request ${reply} is already pending`);
        const deferred = new Deferred<Signal>();
        const timer = setTimeout(() => deferred.reject(new Error(`Timed out waiting for Aiphone ${reply}`)), timeout);
        this.pending.set(key, { deferred, timer });
        try {
            this.send(mid, cid, body, fields);
            const result = await deferred.promise;
            const code = Number(result.HEADER.RSLT ?? 0);
            if (code !== 0 && code !== 200) throw new Error(`Aiphone rejected ${mid} (RSLT=${code})`);
            return result;
        } finally { clearTimeout(timer); this.pending.delete(key); }
    }
    receive(msg: Signal) {
        const head = msg.HEADER;
        const mid = String(head.MID || '');
        const cid = head.CID;
        const sender = head.CLIID;
        if (mid.startsWith('31') && sender && sender !== this.credentials.cliid) return;
        this.pending.get(`${cid}:${mid}`)?.deferred.resolve(msg);
        if (mid === '23001' && typeof cid === 'string' && cid) {
            if (this.seenRings.has(cid) || this.stopped) return;
            if (this.seenRings.size > 128) this.seenRings.clear();
            this.seenRings.add(cid);
            this.ringId = cid;
            this.state = 'ringing'; this.caller = head.DSP1 || msg.BODY?.DSP1 || 'Entrance';
            this.emit('ring'); this.emit('state');
            const callKind = Number(head.CKIND ?? msg.BODY?.CKIND ?? 1);
            this.send('24000', cid, undefined, { CKIND: callKind, RSLT: 200, TMKIND: head.TMKIND ?? msg.BODY?.TMKIND ?? 5, TMID: head.TMID ?? msg.BODY?.TMID ?? 1281 });
            if (this.ringTimer) clearTimeout(this.ringTimer);
            this.ringTimer = setTimeout(() => {
                if (this.ringId === cid && this.state === 'ringing') {
                    this.ringId = undefined; this.state = 'idle'; this.emit('state');
                    if (this.session?.cid === cid) void this.session.close(true).catch(() => {});
                }
            }, 45000);
            const previous = this.ringing;
            const interrupted = this.session?.close(true);
            this.ringing = (async () => {
                await previous?.catch(() => {});
                await interrupted;
                await this.opening?.catch(() => {});
                if (this.ringId !== cid || this.stopped) return;
                await this.session?.close(true);
                if (this.ringId !== cid || this.stopped) return;
                const session = this.session = new AiphoneSession(this, cid, 'ring', callKind);
                await session.start();
                if (!session.closed) this.emit('video', session);
            })();
            void this.ringing.catch(err => this.log(`Incoming video: ${err.message}`));
            return;
        }
        const session = this.session;
        if (cid === this.ringId && (!session || session.cid !== cid) && sender !== this.credentials.cliid
            && (mid === '23003' || mid === '23004' || mid === '24002' && Number(head.RSLT) === 200 && sender)) {
            if (mid !== '24002') this.send(mid === '23003' ? '24003' : '24004', cid, undefined, { RSLT: 200, REASON: head.REASON ?? 16 });
            this.clearRinging(cid); return;
        }
        if (!session || cid !== session.cid || sender === this.credentials.cliid) return;
        if (mid === '23003' || mid === '23004') {
            if (mid === '23004' && session.isOwnCancel(head)) return;
            this.send(mid === '23003' ? '24003' : '24004', cid, undefined, { CKIND: session.callKind, RSLT: 200, REASON: head.REASON ?? 16 });
            const closing = session.close(true);
            this.clearRinging(cid);
            void closing.catch(err => this.log(err.message));
        } else if (mid === '24002' && Number(head.RSLT) === 200 && sender) {
            const closing = session.close(true);
            this.clearRinging(cid);
            void closing.catch(() => {});
        }
    }
    private clearRinging(cid: string) {
        if (this.ringId !== cid || this.state !== 'ringing') return;
        this.ringId = undefined; this.state = 'idle';
        if (this.ringTimer) clearTimeout(this.ringTimer);
        this.emit('state');
    }
    get ringingCallId() { return this.state === 'ringing' ? this.ringId : undefined; }
    async ringingSession(cid: string): Promise<AiphoneSession | undefined> {
        if (this.stopped || !this.online || this.ringingCallId !== cid) return;
        await this.ringing;
        const session = this.session;
        if (this.stopped || !this.online || this.ringingCallId !== cid || !session || session.closed
            || session.kind !== 'ring' || session.cid !== cid) return;
        return session;
    }
    async ensureVideo(): Promise<AiphoneSession> {
        if (this.stopped || !this.online) throw new Error('Aiphone MQTT is not connected');
        if (this.state === 'ringing' && this.ringing) await this.ringing;
        if (this.session && !this.session.closed) {
            await withTimeout(this.session.ready.promise, 40000, 'Doorbell video setup timed out');
            return this.session;
        }
        if (this.opening) return this.opening;
        this.opening = (async () => {
            if (this.session) await this.session.close();
            if (this.stopped) throw new Error('Aiphone controller stopped');
            const session = this.session = new AiphoneSession(this, this.credentials.cliid + sid(), 'monitor');
            await session.start();
            if (!session.closed) this.emit('video', session);
            return session;
        })();
        try { return await this.opening; } finally { this.opening = undefined; }
    }
    answered(session: AiphoneSession) {
        if (this.session !== session) return;
        if (this.ringTimer) clearTimeout(this.ringTimer);
        this.state = 'answered'; this.emit('state');
    }
    ended(session: AiphoneSession) {
        if (this.session !== session) return;
        this.session = undefined;
        if (this.ringId && this.ringId !== session.cid) return;
        this.ringId = undefined;
        if (this.ringTimer) clearTimeout(this.ringTimer);
        this.state = 'idle'; this.emit('state');
    }
    cancel(cid: string) {
        for (const [key, { deferred }] of this.pending) {
            if (key.startsWith(`${cid}:`)) deferred.reject(new Error('Doorbell session ended'));
        }
    }
    async hangup() { await this.session?.close(); }
    unlock() { this.send('26021', '', {}, { RLS: '0', AVID: 0 }); }
    async close() {
        this.stopped = true;
        if (this.ringTimer) clearTimeout(this.ringTimer);
        await this.session?.close();
        this.disconnected();
        if (this.client) await this.client.endAsync(true);
        this.client = undefined;
        this.removeAllListeners();
    }
}
