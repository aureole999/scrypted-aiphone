import { EventEmitter, once } from 'events';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import dgram from 'dgram';
import { randomInt } from 'crypto';
import { RtpHeader, RtpPacket } from 'werift';
import { AiphoneSession } from './media';
import { Deferred, withTimeout } from './protocol';
import { RtspServer, RtspMediaSession } from './rtsp';
import { OsdState, renderOsd } from './osd';
import { decodePoster, encodePoster, FRAME_BYTES, OSD_FPS, OSD_HEIGHT, OSD_WIDTH, RawFrames, SCALE_FILTER, stopProcess } from './video-frames';
import { safeAudioError } from './intercom';

export interface StatusVideoHost {
    ffmpeg(): Promise<string>;
    snapshot(): Buffer;
    state(): OsdState;
    source(): AiphoneSession | undefined;
    sourceUrl(): string;
    monitor(): Promise<AiphoneSession>;
    viewStarted?(active: () => boolean, path: string): void;
    viewOpened?(active: () => boolean, path: string): void;
    log(message: string): void;
}

/** One encoder and one RTP timeline shared by all viewers. Never opens a cloud
 * session for a status-only/background reader or a snapshot request. */
export class StatusVideo {
    private readonly rtsp: RtspServer;
    private listening?: Promise<string>;
    private session?: StatusVideoSession;
    private opening?: Promise<StatusVideoSession>;
    private closed = false;
    private picture?: { key: string; at: number; promise: Promise<Buffer> };
    constructor(private readonly host: StatusVideoHost) {
        this.rtsp = new RtspServer(() => this.getSession(), message => host.log(safeAudioError(message)), () => this.session,
            (_session, path, active) => { if (path.endsWith('/watch')) host.viewStarted?.(active, path); },
            (path, active) => host.viewOpened?.(active, path));
    }
    async getStream(monitor: boolean, intentId?: string) {
        if (this.closed) throw new Error('OSD output is closed. Reopen live video.');
        const url = await (this.listening ||= this.rtsp.listen());
        return url + (monitor ? (intentId ? `/intent/${intentId}/watch` : '/watch') : '/status');
    }
    private async getSession() {
        if (this.closed) throw new Error('OSD output is closed');
        if (this.opening) return this.opening;
        if (this.session && !this.session.closed) return this.session;
        this.opening = (async () => {
            const session = this.session = new StatusVideoSession(this.host);
            try { await session.start(); return session; }
            catch (error) { await session.close(); throw error; }
        })();
        try { return await this.opening; } finally { this.opening = undefined; }
    }
    async takePicture() {
        const state = this.host.state();
        const key = JSON.stringify(state);
        if (this.picture?.key === key && Date.now() - this.picture.at < 5000) return this.picture.promise;
        const promise = (async () => {
            const jpeg = this.host.snapshot();
            const ffmpeg = await this.host.ffmpeg();
            const frame = await decodePoster(ffmpeg, jpeg);
            return encodePoster(ffmpeg, renderOsd(frame, state, false));
        })();
        const entry = this.picture = { key, at: Date.now(), promise };
        void promise.catch(() => { if (this.picture === entry) this.picture = undefined; });
        return promise;
    }
    async close() {
        this.closed = true;
        await this.session?.close();
        await this.opening?.catch(() => {});
        await this.listening?.catch(() => {});
        await this.rtsp.close();
    }
}

export class StatusVideoSession extends EventEmitter implements RtspMediaSession {
    readonly tracks = [
        { kind: 'video' as const, payloadType: 96, rtpmap: 'a=rtpmap:96 H264/90000', fmtp: 'a=fmtp:96 packetization-mode=1', framerate: OSD_FPS },
        { kind: 'audio' as const, payloadType: 0, rtpmap: 'a=rtpmap:0 PCMU/8000' },
    ];
    closed = false;
    audioPacketsForwarded = 0;
    private viewers = 0;
    private everPlayed = false;
    private watchers = 0;
    private monitorPending = false;
    private source?: AiphoneSession;
    private sourceHeld = false;
    private sourceAudio?: (kind: string, data: Buffer) => void;
    private encoder?: ChildProcessWithoutNullStreams;
    private decoder?: ChildProcessWithoutNullStreams;
    private decoderPending = false;
    private decoderAttempts = 0;
    private decoderRetryAt = 0;
    private lastRecoveryRequestAt = 0;
    private ffmpeg = '';
    private liveFrame?: Buffer;
    private liveAt = 0;
    private poster = Buffer.alloc(FRAME_BYTES, 24);
    private posterAt?: number;
    private posterLoaded = false;
    private posterPending = false;
    private posterRetryAt = 0;
    private lastContent = '';
    private videoTimer?: NodeJS.Timeout;
    private audioTimer?: NodeJS.Timeout;
    private idleTimer?: NodeJS.Timeout;
    private readonly udp = dgram.createSocket('udp4');
    private readonly firstVideo = new Deferred<void>();
    private readonly audioQueue: Buffer[] = [];
    private audioSequence = randomInt(65536);
    private audioTimestamp = randomInt(0x100000000);
    private readonly audioSsrc = randomInt(1, 0xffffffff);
    constructor(private readonly host: StatusVideoHost) { super(); }

    async start() {
        this.ffmpeg = await this.host.ffmpeg();
        if (this.closed) throw new Error('OSD output is closed');
        const listening = once(this.udp, 'listening');
        this.udp.bind(0, '127.0.0.1'); await listening;
        try { this.udp.setRecvBufferSize(4 * 1024 * 1024); }
        catch { this.host.log('OSD RTP is using the default receive buffer'); }
        this.udp.on('error', error => { this.host.log(`OSD RTP: ${error.message}`); void this.close(); });
        this.udp.on('message', data => {
            if (this.closed) return;
            // FFmpeg writes RTCP to the adjacent port; this socket receives RTP only.
            this.firstVideo.resolve(); this.emit('rtp', 'video', data);
        });
        await this.updatePoster();
        if (this.closed) throw new Error('OSD output is closed');
        const address = this.udp.address();
        const child = this.encoder = spawn(this.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-threads', '1',
            '-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', `${OSD_WIDTH}x${OSD_HEIGHT}`, '-framerate', String(OSD_FPS), '-i', 'pipe:0',
            '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-profile:v', 'baseline', '-level:v', '3.1',
            '-pix_fmt', 'yuv420p', '-b:v', '800k', '-maxrate', '1000k', '-bufsize', '1000k', '-g', String(OSD_FPS),
            '-keyint_min', String(OSD_FPS), '-sc_threshold', '0', '-x264-params', 'repeat-headers=1', '-threads', '1',
            '-f', 'rtp', '-payload_type', '96', `rtp://127.0.0.1:${address.port}?pkt_size=1200`]);
        let error = '';
        child.stdout.resume(); child.stdin.on('error', () => {});
        child.stderr.on('data', data => { error = (error + data.toString()).slice(-2000); });
        child.once('error', err => { this.firstVideo.reject(err); void this.close(); });
        child.once('close', () => {
            if (!this.closed) { const message = safeAudioError(error) || 'OSD encoder exited'; this.host.log(message); this.firstVideo.reject(new Error(message)); void this.close(); }
        });
        this.videoTimer = setInterval(() => this.drawFrame(), 1000 / OSD_FPS);
        this.audioTimer = setInterval(() => this.sendAudio(), 20);
        this.drawFrame();
        this.scheduleIdle();
        await withTimeout(this.firstVideo.promise, 10000, 'OSD encoder startup timed out');
        this.host.log('Experimental OSD output ready: 640x480 / 10 fps');
    }
    private async updatePoster() {
        const capturedAt = this.host.state().capturedAt;
        if (this.posterPending || Date.now() < this.posterRetryAt || (this.posterLoaded && capturedAt === this.posterAt)) return;
        this.posterPending = true;
        try {
            const frame = await decodePoster(this.ffmpeg, this.host.snapshot());
            if (!this.closed) { this.poster = frame; this.posterAt = capturedAt; this.posterLoaded = true; }
        } catch (error) { this.posterRetryAt = Date.now() + 10000; this.host.log(`OSD cached image: ${safeAudioError((error as Error).message)}`); }
        finally { this.posterPending = false; }
    }
    private drawFrame() {
        if (this.closed) return;
        this.syncSource();
        // A brief decoder stall must not jump back to an older snapshot. Keep
        // the last complete live frame until this cloud session actually ends.
        const live = !!this.source && !this.source.closed && !!this.liveFrame;
        const videoStalled = live && Date.now() - this.liveAt >= 1500;
        const content = live ? 'Live video' : 'Cached snapshot';
        if (content !== this.lastContent) { this.lastContent = content; this.host.log(`OSD source: ${content}`); }
        if (!live) void this.updatePoster();
        const child = this.encoder;
        if (!child || child.stdin.destroyed || child.stdin.writableLength > FRAME_BYTES * 2) return;
        child.stdin.write(renderOsd(live ? this.liveFrame! : this.poster, { ...this.host.state(), videoStalled }, live,
            this.monitorPending || !!this.source && !live));
    }
    private syncSource() {
        const current = this.host.source();
        const source = current?.closed ? undefined : current;
        if (source !== this.source) {
            this.detachSource();
            this.source = source;
            if (source) {
                this.sourceAudio = (kind, data) => {
                    if (kind !== 'audio' || this.closed || source.closed) return;
                    try {
                        const payload = RtpPacket.deSerialize(data).payload;
                        if (payload.length > 8000) return;
                        for (let offset = 0; offset < payload.length; offset += 160) {
                            const frame = Buffer.alloc(160, 0xff); payload.copy(frame, 0, offset, Math.min(offset + 160, payload.length));
                            if (this.audioQueue.length >= 8) this.audioQueue.shift();
                            this.audioQueue.push(frame);
                        }
                    } catch { /* Discard invalid input; the output clock continues with silence. */ }
                };
                source.on('rtp', this.sourceAudio);
            }
        }
        if (this.source && this.watchers > 0 && !this.sourceHeld) { this.source.addViewer(); this.sourceHeld = true; }
        if (this.source && this.watchers === 0 && this.sourceHeld) { this.source.removeViewer(); this.sourceHeld = false; }
        if (this.source && !this.decoder && !this.decoderPending && this.decoderAttempts < 3 && Date.now() >= this.decoderRetryAt)
            void this.startDecoder(this.source);
    }
    private async startDecoder(source: AiphoneSession) {
        this.decoderPending = true;
        try {
            await source.ready.promise;
            if (this.closed || this.source !== source || source.closed) return;
            this.decoderAttempts++;
            const child = this.decoder = spawn(this.ffmpeg, ['-hide_banner', '-loglevel', 'warning', '-threads', '1',
                '-rtsp_transport', 'tcp', '-reorder_queue_size', '128', '-max_delay', '200000',
                '-fflags', '+discardcorrupt', '-err_detect', 'explode',
                '-analyzeduration', '100000', '-probesize', '32768', '-i', this.host.sourceUrl(),
                '-an', '-vf', `fps=${OSD_FPS},${SCALE_FILTER}`, '-threads', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
            const frames = new RawFrames(); let error = '', hadFrame = false, damaged = false;
            child.stdin.end(); child.stderr.on('data', data => {
                const message = data.toString(); error = (error + message).slice(-2000);
                if (this.decoder !== child || damaged || source.closed
                    || !/corrupt|concealing|reference picture missing|missing reference|non-existing PPS|error while decoding|error submitting|decode_slice_header|RTP: missed/i.test(message)) return;
                if (Date.now() - this.lastRecoveryRequestAt >= 1000) {
                    this.lastRecoveryRequestAt = Date.now(); source.requestKeyframe();
                }
                // A new RTSP reader may join between keyframes. Let that initial
                // decoder wait for SPS/PPS; do not restart it before its first frame.
                if (!hadFrame) return;
                damaged = true;
                this.host.log(`OSD damaged frame; holding last good frame and requesting keyframe: ${safeAudioError(message)}`);
                stopProcess(child);
            });
            child.stdout.on('data', data => frames.push(data, frame => {
                if (this.decoder !== child || source.closed || damaged) return;
                hadFrame = true; this.decoderAttempts = 0;
                this.liveFrame = frame; this.liveAt = Date.now();
            }));
            const ended = () => {
                if (this.decoder !== child) return;
                this.decoder = undefined; this.decoderRetryAt = Date.now() + (damaged ? 300 : 2000);
                if (!this.closed && !source.closed && !damaged) this.host.log(`OSD live decoder exited: ${safeAudioError(error) || 'Retry pending'}`);
            };
            child.once('error', ended); child.once('close', ended);
        } catch (error) {
            if (!source.closed && !this.closed) this.host.log(`OSD video setup: ${safeAudioError((error as Error).message)}`);
        } finally { this.decoderPending = false; }
    }
    private detachSource() {
        if (this.source && this.sourceAudio) this.source.off('rtp', this.sourceAudio);
        if (this.sourceHeld) this.source?.removeViewer();
        this.sourceHeld = false; this.source = undefined; this.sourceAudio = undefined;
        const decoder = this.decoder; this.decoder = undefined;
        if (decoder) stopProcess(decoder);
        this.liveFrame = undefined; this.audioQueue.length = 0;
        this.decoderAttempts = 0; this.decoderRetryAt = 0;
    }
    private sendAudio() {
        if (this.closed) return;
        const payload = this.audioQueue.shift() || Buffer.alloc(160, 0xff);
        const packet = new RtpPacket(new RtpHeader({ payloadType: 0, sequenceNumber: this.audioSequence,
            timestamp: this.audioTimestamp, ssrc: this.audioSsrc }), payload);
        this.audioSequence = (this.audioSequence + 1) & 0xffff;
        this.audioTimestamp = (this.audioTimestamp + 160) >>> 0;
        this.emit('rtp', 'audio', packet.serialize());
    }
    addViewer(path = '') {
        if (this.closed) return;
        this.everPlayed = true;
        this.viewers++;
        if (this.idleTimer) clearTimeout(this.idleTimer);
        if (path.endsWith('/watch')) { this.watchers++; void this.monitor(); }
        this.syncSource();
    }
    removeViewer(path = '') {
        this.viewers = Math.max(0, this.viewers - 1);
        if (path.endsWith('/watch')) this.watchers = Math.max(0, this.watchers - 1);
        this.syncSource(); this.scheduleIdle();
    }
    private async monitor() {
        if (this.monitorPending || this.closed || !this.host.state().online || this.host.source() && !this.host.source()!.closed) return;
        this.monitorPending = true;
        try { await this.host.monitor(); }
        catch (error) { this.host.log(`OSD background monitoring: ${safeAudioError((error as Error).message)}`); }
        finally { this.monitorPending = false; if (!this.closed) this.syncSource(); }
    }
    requestKeyframe() { /* Encoder repeats SPS/PPS and IDR every second. */ }
    private scheduleIdle() {
        if (this.idleTimer) clearTimeout(this.idleTimer);
        if (!this.viewers && !this.closed) this.idleTimer = setTimeout(() => void this.close(), this.everPlayed ? 5000 : 30000);
    }
    async close() {
        if (this.closed) return;
        this.closed = true; this.firstVideo.reject(new Error('OSD output is closed'));
        if (this.videoTimer) clearInterval(this.videoTimer);
        if (this.audioTimer) clearInterval(this.audioTimer);
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.detachSource();
        if (this.encoder) stopProcess(this.encoder);
        try { this.udp.close(); } catch { /* Socket may not have bound. */ }
        this.emit('close'); this.removeAllListeners();
        this.host.log('Experimental OSD output stopped');
    }
}
