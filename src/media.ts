import { EventEmitter } from 'events';
import { randomInt } from 'crypto';
import { MediaStreamTrack, RTCPeerConnection, RtpHeader, RtpPacket, useH264, usePCMU } from 'werift';
import { Credentials, Deferred, janusOffer, Signal, stripExtraFingerprints, withTimeout } from './protocol';
import { pcmuLevelDb } from './audio-level';

export interface Signaling {
    credentials: Credentials;
    send(mid: string, cid: string, body?: Record<string, any>, fields?: Record<string, any>): void;
    request(mid: string, reply: string, cid: string, body?: Record<string, any>, fields?: Record<string, any>, timeout?: number): Promise<Signal>;
    cancel?(cid: string): void;
    ended(session: AiphoneSession): void;
    answered(session: AiphoneSession): void;
    log(message: string): void;
}
export interface StreamTrack { kind: 'video' | 'audio'; payloadType: number; rtpmap: string; fmtp?: string; framerate?: number; }
export function extractTracks(sdp: string): StreamTrack[] {
    const result: StreamTrack[] = [];
    for (const section of sdp.split(/(?=^m=)/m)) {
        const kind = section.startsWith('m=video') ? 'video' : section.startsWith('m=audio') ? 'audio' : undefined;
        if (!kind) continue;
        const codec = kind === 'video' ? 'H264/90000' : 'PCMU/8000';
        const line = section.split(/\r?\n/).find(l => l.toUpperCase().endsWith(` ${codec}`.toUpperCase()) || l.toUpperCase().endsWith(` ${codec}/1`.toUpperCase()));
        if (!line) continue;
        const pt = Number(line.match(/^a=rtpmap:(\d+) /)?.[1]);
        if (!Number.isFinite(pt)) continue;
        const fmtp = section.split(/\r?\n/).find(l => l.startsWith(`a=fmtp:${pt} `));
        result.push({ kind, payloadType: pt, rtpmap: line, fmtp });
    }
    if (!result.some(t => t.kind === 'video')) throw new Error('Doorbell did not offer H.264 video');
    return result;
}

/** One clocked 8 kHz PCMU uplink. Only explicit Answer enables microphone audio. */
export class AudioUplink {
    readonly track = new MediaStreamTrack({ kind: 'audio' });
    enabled = false;
    framesReceived = 0;
    framesSent = 0;
    lastFrameSentAt?: number;
    maxBufferedFrames = 8;
    private queue: Buffer[] = [];
    private sequence = randomInt(65536);
    private timestamp = randomInt(0x100000000);
    private readonly ssrc = randomInt(1, 0xffffffff);
    private readonly timer: NodeJS.Timeout;
    constructor() {
        this.timer = setInterval(() => {
            const queued = this.enabled && this.queue.length ? this.queue.shift() : undefined;
            if (queued) this.framesSent++;
            const payload = queued || Buffer.alloc(160, 0xff);
            this.track.writeRtp(new RtpPacket(new RtpHeader({ payloadType: 0, sequenceNumber: this.sequence, timestamp: this.timestamp, ssrc: this.ssrc }), payload));
            if (queued) this.lastFrameSentAt = Date.now();
            this.sequence = (this.sequence + 1) & 0xffff;
            this.timestamp = (this.timestamp + 160) >>> 0;
        }, 20);
    }
    push(frame: Buffer) {
        if (!this.enabled || frame.length !== 160) return;
        this.framesReceived++;
        if (this.queue.length >= this.maxBufferedFrames) this.queue.shift();
        this.queue.push(Buffer.from(frame));
    }
    async drain() {
        const deadline = Date.now() + 3000;
        while (this.enabled && this.queue.length) {
            if (Date.now() > deadline) throw new Error('Timed out sending reply audio');
            await new Promise(resolve => setTimeout(resolve, 20));
        }
    }
    clear() { this.queue = []; }
    close() { clearInterval(this.timer); this.enabled = false; this.clear(); this.track.stop(); }
}

/** Owns the cloud publisher/subscriber peers for exactly one monitor or ring call. */
export class AiphoneSession extends EventEmitter {
    readonly ready = new Deferred<void>();
    tracks: StreamTrack[] = [];
    accepted = false;
    answerRequested = false;
    closed = false;
    uplink?: AudioUplink;
    viewers = 0;
    audioPacketsReceived = 0;
    audioPeakDb = -96;
    audioLevelDb = -96;
    audioPayloadType?: number;
    audioLastReceivedAt?: number;
    audioPacketsForwarded = 0;
    videoPacketsReceived = 0;
    talkState = 'Not requested';
    private publisher?: RTCPeerConnection;
    private subscriber?: RTCPeerConnection;
    private closePromise?: Promise<void>;
    private answerPromise?: Promise<void>;
    private manualAnswer = false;
    private readonly answerGuards = new Set<() => boolean>();
    private acceptedAt = 0;
    private talkAudioReadySince?: number;
    private idleTimer?: NodeJS.Timeout;
    private pliTimer?: NodeJS.Timeout;
    private cleanup: (() => void)[] = [];
    constructor(readonly signaling: Signaling, readonly cid: string, readonly kind: 'monitor' | 'ring', readonly callKind = 1) {
        super();
    }
    private assertOpen() { if (this.closed) throw new Error('Doorbell session has ended'); }
    private peer(): RTCPeerConnection {
        const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle', iceUseIpv6: false, codecs: { audio: [usePCMU()], video: [useH264()] } });
        pc.connectionStateChange.subscribe(state => {
            if (state === 'failed') void this.close().catch(err => this.signaling.log(`Media close: ${err.message}`));
        });
        return pc;
    }
    private async createPublisher(mid: '30001' | '30021', reply: '31001' | '31021') {
        this.assertOpen();
        const pc = this.publisher = this.peer();
        this.uplink = new AudioUplink();
        pc.addTransceiver(this.uplink.track, { direction: 'sendonly' });
        await withTimeout(pc.setLocalDescription(await pc.createOffer()), 10000, 'Publisher ICE gathering timed out');
        this.assertOpen();
        const response = await this.signaling.request(mid, reply, this.cid, { SDP: stripExtraFingerprints(pc.localDescription!.sdp) }, { RLS: '0' });
        if (!response.BODY?.SDP) throw new Error(`${reply} did not contain SDP`);
        this.assertOpen();
        await pc.setRemoteDescription({ sdp: response.BODY.SDP, type: 'answer' });
        const direction = pc.getTransceivers()[0].currentDirection;
        if (direction !== 'sendonly' && direction !== 'sendrecv') throw new Error('Doorbell did not negotiate microphone audio');
        if (this.kind === 'ring') await this.waitConnected(pc);
    }
    private async waitConnected(pc: RTCPeerConnection) {
        if (pc.connectionState === 'connected') return;
        await withTimeout(new Promise<void>((resolve, reject) => {
            const subscription = pc.connectionStateChange.subscribe(state => {
                if (state === 'connected') { subscription.unSubscribe(); resolve(); }
                else if (state === 'closed' || state === 'failed') { subscription.unSubscribe(); reject(new Error('Doorbell media connection failed')); }
            });
            this.cleanup.push(() => subscription.unSubscribe());
        }), 15000, 'Doorbell media connection timed out');
        this.assertOpen();
    }
    async start(): Promise<void> {
        try {
            if (this.kind === 'monitor') {
                await this.createPublisher('30001', '31001');
                const monitor = await this.signaling.request('23021', '24021', this.cid, undefined, {
                    DSP1: this.signaling.credentials.termname, DSP2: '@', CKIND: 0,
                    RECKIND: 0, AVID: 0, REASON: 0, TMKIND: 5, TMID: 1281,
                });
                if (Number(monitor.HEADER.RSLT) !== 200) throw new Error('Monitor was not accepted (24021)');
            }
            this.assertOpen();
            const pc = this.subscriber = this.peer();
            pc.addTransceiver('audio', { direction: 'recvonly' });
            pc.addTransceiver('video', { direction: 'recvonly' });
            pc.onTrack.subscribe(track => {
                const sub = track.onReceiveRtp.subscribe(rtp => {
                    if (this.closed) return;
                    if (track.kind === 'audio') {
                        this.audioPacketsReceived++;
                        this.audioPayloadType = rtp.header.payloadType;
                        this.audioLastReceivedAt = Date.now();
                        this.audioLevelDb = pcmuLevelDb(rtp.payload);
                        this.audioPeakDb = Math.max(this.audioPeakDb, this.audioLevelDb);
                    }
                    else this.videoPacketsReceived++;
                    this.emit('rtp', track.kind, rtp.serialize());
                });
                this.cleanup.push(() => sub.unSubscribe());
                const rtcp = track.onReceiveRtcp.subscribe(packet => {
                    if (!this.closed) this.emit('rtcp', track.kind, packet.serialize());
                });
                this.cleanup.push(() => rtcp.unSubscribe());
            });
            const response = await this.signaling.request('30011', '31011', this.cid, {}, { RLS: '0' });
            const sdp = response.BODY?.SDP;
            if (!sdp) throw new Error('Doorbell did not return subscriber SDP');
            this.assertOpen();
            await pc.setRemoteDescription({ sdp: janusOffer(sdp), type: 'offer' });
            await withTimeout(pc.setLocalDescription(await pc.createAnswer()), 10000, 'Subscriber ICE gathering timed out');
            this.assertOpen();
            // Build the RTSP description from the codecs we actually accepted.
            this.tracks = extractTracks(pc.localDescription!.sdp);
            const body = { SDP: stripExtraFingerprints(pc.localDescription!.sdp) };
            if (this.kind === 'monitor') {
                await this.signaling.request('30012', '31012', this.cid, body, { RLS: '0' }, 6000).catch(err => {
                    if (err.message.startsWith('Timed out')) this.signaling.log('31012 acknowledgement timed out; waiting for media');
                    else throw err;
                });
            } else {
                this.signaling.send('30012', this.cid, body, { RLS: '0' });
                this.signaling.send('24001', this.cid, undefined, { CKIND: this.callKind, RSLT: 200 });
            }
            await this.waitConnected(pc);
            this.ready.resolve();
            this.pliTimer = setInterval(() => this.requestKeyframe(), 5000);
            this.scheduleIdle(40000);
        } catch (err) {
            this.ready.reject(err as Error);
            await this.close(this.kind === 'ring');
            throw err;
        }
    }
    requestKeyframe() {
        if (this.closed) return;
        const receiver = this.subscriber?.getTransceivers().find(t => t.kind === 'video')?.receiver;
        const track = receiver?.track;
        if (receiver && track?.ssrc) void receiver.sendRtcpPLI(track.ssrc).catch(() => {});
    }
    addViewer() { this.assertOpen(); this.viewers++; if (this.idleTimer) clearTimeout(this.idleTimer); this.requestKeyframe(); }
    removeViewer() { this.viewers = Math.max(0, this.viewers - 1); this.scheduleIdle(15000); }
    private scheduleIdle(delay: number) {
        if (this.idleTimer) clearTimeout(this.idleTimer);
        if (this.closed || this.kind !== 'monitor' || this.viewers || this.accepted) return;
        this.idleTimer = setTimeout(() => void this.close().catch(() => {}), delay);
    }
    get audioDiagnostics() {
        return { kind: this.kind, accepted: this.accepted, talk: this.talkState,
            publisher: this.publisher?.connectionState || 'none', subscriber: this.subscriber?.connectionState || 'none',
            audioReceived: this.audioPacketsReceived, audioForwarded: this.audioPacketsForwarded,
            audioPayloadType: this.audioPayloadType, audioLevelDb: this.audioLevelDb, audioPeakDb: this.audioPeakDb,
            audioLastReceivedAt: this.audioLastReceivedAt, microphoneFrames: this.uplink?.framesReceived || 0,
            microphoneSent: this.uplink?.framesSent || 0, microphoneLastSentAt: this.uplink?.lastFrameSentAt };
    }
    async answer(continueIf?: () => boolean) {
        if (this.accepted) return;
        if (continueIf) this.answerGuards.add(continueIf); else this.manualAnswer = true;
        if (this.answerPromise) return this.answerPromise;
        this.answerPromise = this.doAnswer().finally(() => {
            this.answerPromise = undefined; this.manualAnswer = false; this.answerGuards.clear();
        });
        return this.answerPromise;
    }
    private shouldAnswer() { return this.manualAnswer || [...this.answerGuards].some(guard => guard()); }
    get answering() { return !!this.answerPromise && !this.accepted && !this.closed; }
    /** UI readiness concerns packets, including silence, rather than sound level.
     * A little hysteresis keeps the status readable across network jitter. */
    get talkAudioReady() {
        const now = Date.now();
        const ready = !this.closed && this.accepted && this.uplink?.enabled
            && this.publisher?.connectionState === 'connected' && this.subscriber?.connectionState === 'connected'
            && this.audioLastReceivedAt !== undefined && this.audioLastReceivedAt >= this.acceptedAt
            && now - this.audioLastReceivedAt <= 1500;
        if (!ready) { this.talkAudioReadySince = undefined; return false; }
        this.talkAudioReadySince ??= now;
        return now - this.talkAudioReadySince >= 300;
    }
    /** Signaling acceptance can precede the door station's audio path by seconds. */
    async waitForReplyAudio(signal?: AbortSignal, timeoutMs = 15000) {
        this.assertOpen();
        if (!this.accepted || !this.uplink?.enabled) throw new Error('Call has not been accepted; cannot play quick reply');
        const started = Date.now();
        let readySince: number | undefined;
        this.signaling.log('Quick reply: Waiting for accepted call, connected media, and doorbell audio');
        while (true) {
            if (signal?.aborted) throw new Error('Intercom was cancelled');
            this.assertOpen();
            const now = Date.now();
            const freshAudio = this.audioLastReceivedAt !== undefined
                && this.audioLastReceivedAt >= this.acceptedAt && now - this.audioLastReceivedAt <= 500;
            if (this.publisher?.connectionState === 'connected' && this.subscriber?.connectionState === 'connected' && freshAudio) {
                readySince ??= now;
                // Let the new audio route settle while the uplink sends silence.
                if (now - readySince >= 300) break;
            } else readySince = undefined;
            if (now - started >= timeoutMs)
                throw new Error(`Timed out waiting for call audio; reply not played: ${JSON.stringify(this.audioDiagnostics)}`);
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        this.signaling.log(`Quick reply: Call audio ready after ${Date.now() - started} ms; starting playback`);
    }
    private async doAnswer() {
        await withTimeout(this.ready.promise, 35000, 'Waiting for doorbell video timed out');
        this.assertOpen();
        try {
            if (!this.shouldAnswer()) return;
            if (this.kind === 'monitor') {
                this.talkState = 'Waiting for 24022';
                this.signaling.log('Monitor talk: sending 23022');
                const reply = await this.signaling.request('23022', '24022', this.cid, {}, { CKIND: 0, RECKIND: 0, AVID: 0, REASON: 0 }, 13000);
                if (Number(reply.HEADER.RSLT) !== 200) throw new Error('Monitor talk was not accepted (24022)');
            } else {
                this.talkState = 'Waiting for call acceptance';
                if (!this.publisher || this.publisher.connectionState === 'closed' || this.publisher.connectionState === 'failed')
                    await this.createPublisher('30021', '31021');
                else await this.waitConnected(this.publisher);
                if (!this.shouldAnswer()) { this.talkState = 'Waiting for answer'; return; }
                this.answerRequested = true;
                await this.signaling.request('24002', '25001', this.cid, undefined, { CKIND: this.callKind, RECKIND: 0, AVID: 0, RSLT: 200, REASON: 0 }, 17000);
            }
            this.assertOpen();
            this.acceptedAt = Date.now();
            this.accepted = true;
            this.talkState = 'Call accepted';
            this.signaling.log('Doorbell accepted talk; microphone uplink enabled');
            this.uplink!.enabled = true;
            this.signaling.answered(this);
            // Lost remote hangups must never leave an unlimited microphone session.
            if (this.idleTimer) clearTimeout(this.idleTimer);
            this.idleTimer = setTimeout(() => void this.close().catch(() => {}), 300000);
        } catch (err) { this.talkState = `Failed: ${(err as Error).message}`; await this.close(); throw err; }
    }
    isOwnCancel(head: Record<string, any>) {
        const target = head.NCID || head.NCLIID;
        return target ? target === this.signaling.credentials.cliid : this.answerRequested || this.accepted;
    }
    close(remote = false): Promise<void> {
        if (this.closePromise) return this.closePromise;
        this.closed = true;
        this.closePromise = this.doClose(remote);
        return this.closePromise;
    }
    private async doClose(remote: boolean) {
        this.ready.reject(new Error('Doorbell session ended'));
        this.signaling.cancel?.(this.cid);
        if (this.idleTimer) clearTimeout(this.idleTimer);
        if (this.pliTimer) clearInterval(this.pliTimer);
        this.uplink?.close();
        this.emit('close');
        try {
            if (!remote && this.kind === 'ring' && !this.accepted && !this.answerRequested)
                this.signaling.send('24002', this.cid, undefined, { CKIND: this.callKind, RSLT: 603 });
            await this.signaling.request('30031', '31031', this.cid, undefined, { RLS: '0' }, 2000).catch(() => {});
            if (!remote && (this.kind === 'monitor' || this.accepted || this.answerRequested))
                await this.signaling.request('23003', '24003', this.cid, undefined, { CKIND: this.kind === 'monitor' ? 0 : this.callKind, REASON: 16, RECKIND: 0, AVID: 0 }, 3000).catch(() => {});
        } finally {
            for (const cleanup of this.cleanup) cleanup();
            await Promise.allSettled([this.publisher?.close(), this.subscriber?.close()]);
            this.signaling.ended(this);
            this.removeAllListeners();
        }
    }
}
