import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter, once } from 'node:events';
import { spawn, ChildProcess } from 'node:child_process';
import dgram from 'node:dgram';
import { RtpHeader, RtpPacket } from 'werift';
import { writeFileSync } from 'node:fs';
import { StatusVideo, StatusVideoHost } from '../src/status-video';
import { encodePoster, FRAME_BYTES, OSD_HEIGHT, OSD_WIDTH, RawFrames, stopProcess } from '../src/video-frames';
import { renderOsd } from '../src/osd';
import { Deferred, withTimeout } from '../src/protocol';
import { RtspServer } from '../src/rtsp';
import { AiphoneSession } from '../src/media';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const blue = Buffer.alloc(FRAME_BYTES);
for (let i = 2; i < blue.length; i += 3) blue[i] = 210;
const state = { online: true, call: 'Idle', capturedAt: Date.UTC(2026, 9, 27, 0, 0, 0) };
async function until(test: () => boolean, message: string) {
    const deadline = Date.now() + 10000;
    while (!test()) { if (Date.now() > deadline) throw new Error(message); await delay(20); }
}
function stop(child?: ChildProcess) { if (child) stopProcess(child as any); }

test('OSD is legible on cached pictures, preserves image pixels and needs no cloud session', async () => {
    const frame = renderOsd(blue, state, false);
    assert.equal(blue[2], 210, 'input frame must remain unmodified');
    const center = (OSD_WIDTH * Math.floor(OSD_HEIGHT / 2) + Math.floor(OSD_WIDTH / 2)) * 3;
    assert.deepEqual(frame.subarray(center, center + 3), blue.subarray(center, center + 3));
    assert(!frame.subarray(0, OSD_WIDTH * 70 * 3).equals(blue.subarray(0, OSD_WIDTH * 70 * 3)));
    assert(frame.some((value, index) => index < OSD_WIDTH * 70 * 3 && index % 3 === 1 && value > 180), 'status glyphs must be visible');
    const changedSnapshot = { ...state, capturedAt: state.capturedAt + 60000 };
    const fixedTime = Date.UTC(2026, 9, 27, 1, 0, 0);
    assert.deepEqual(renderOsd(blue, state, true, false, fixedTime), renderOsd(blue, changedSnapshot, true, false, fixedTime),
        'live video must not include the snapshot timestamp');
    assert(!renderOsd(blue, state, false).equals(renderOsd(blue, changedSnapshot, false)), 'cached video keeps its snapshot timestamp');
    const aboveFooter = OSD_WIDTH * (OSD_HEIGHT - 50) * 3;
    assert.deepEqual(frame.subarray(aboveFooter, aboveFooter + OSD_WIDTH * 3), blue.subarray(aboveFooter, aboveFooter + OSD_WIDTH * 3),
        'a one-line footer must not cover a second row of video');
    const jpeg = await encodePoster('ffmpeg', blue);
    let calls = 0;
    const video = new StatusVideo({ ffmpeg: async () => 'ffmpeg', snapshot: () => jpeg, state: () => state,
        source: () => { calls++; throw new Error('snapshot must not inspect cloud media'); },
        sourceUrl: () => { calls++; throw new Error('must not connect'); },
        monitor: async () => { calls++; throw new Error('must not monitor'); }, log() {} });
    try {
        const picture = await video.takePicture();
        assert.equal(picture.readUInt16BE(0), 0xffd8); assert(picture.length > jpeg.length);
        assert.deepEqual(await video.takePicture(), picture); assert.equal(calls, 0);
        writeFileSync('/tmp/aiphone-osd-preview.jpg', picture);
    } finally { await video.close(); }
});

test('OSD survives reordered and lost RTP without grid distortion or jumping to an old snapshot', { timeout: 45000 }, async () => {
    const jpeg = await encodePoster('ffmpeg', blue);
    const ready = new Deferred<void>(); ready.resolve();
    let keyframeRequests = 0;
    const source = Object.assign(new EventEmitter(), { ready, closed: false, viewers: 0,
        audioPacketsForwarded: 0, tracks: [
            { kind: 'video' as const, payloadType: 96, rtpmap: 'a=rtpmap:96 H264/90000', fmtp: 'a=fmtp:96 packetization-mode=1' },
            { kind: 'audio' as const, payloadType: 0, rtpmap: 'a=rtpmap:0 PCMU/8000' },
        ], addViewer() { source.viewers++; }, removeViewer() { source.viewers--; }, requestKeyframe() { keyframeRequests++; },
    });
    let current: AiphoneSession | undefined, monitorCalls = 0, foregroundPlays = 0;
    const monitoring = new Deferred<AiphoneSession>();
    const rtsp = new RtspServer(async () => { throw new Error('OSD decoder must use passive source URL'); }, () => {}, () => current);
    await rtsp.listen();
    const logs: string[] = [];
    const host: StatusVideoHost = { ffmpeg: async () => 'ffmpeg', snapshot: () => jpeg, state: () => state,
        source: () => current, sourceUrl: () => rtsp.passiveUrl,
        monitor: () => { monitorCalls++; return monitoring.promise; }, viewStarted: () => { foregroundPlays++; }, log: message => logs.push(message) };
    const video = new StatusVideo(host);
    const udp = dgram.createSocket('udp4');
    let viewer: ChildProcess | undefined, watcher: ChildProcess | undefined, encoder: ChildProcess | undefined;
    let audioTimer: NodeJS.Timeout | undefined;
    let pauseVideo = false, dropFragment = false, dropped = false, videoPackets = 0;
    const delayed = new Set<NodeJS.Timeout>();
    try {
        const bound = once(udp, 'listening'); udp.bind(0, '127.0.0.1'); await bound;
        udp.on('message', data => {
            if (pauseVideo || source.closed) return;
            const rtp = RtpPacket.deSerialize(data);
            if (dropFragment && (rtp.payload[0] & 0x1f) === 28 && !(rtp.payload[1] & 0x80)) {
                dropFragment = false; dropped = true; return;
            }
            // A cloud WebRTC track can deliver retransmissions/out-of-order RTP
            // even though the subsequent loopback RTSP connection uses TCP.
            if (++videoPackets % 2) {
                const timer = setTimeout(() => { delayed.delete(timer); if (!source.closed && !pauseVideo) source.emit('rtp', 'video', data); }, 35);
                delayed.add(timer);
            } else source.emit('rtp', 'video', data);
        });
        const url = await video.getStream(false);
        let latest: Buffer | undefined, viewerErrors = '', frames = 0, nonSilentAudio = false;
        let inspectGrid = false, gridFrames = 0;
        const badGrid: number[][] = [];
        // Inspect decoded frames directly. Older FFmpeg releases can guess an
        // excessive RTSP frame rate before SPS/PPS arrives and duplicate frames.
        viewer = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-threads', '1', '-rtsp_transport', 'tcp', '-analyzeduration', '100000',
            '-probesize', '32768', '-i', url, '-map', '0:v', '-threads', '1', '-fps_mode', 'passthrough', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1',
            '-map', '0:a', '-c:a', 'copy', '-f', 'mulaw', 'pipe:3'], { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
        const output = new RawFrames();
        viewer.stdout!.on('data', data => output.push(data, frame => {
            latest = frame; frames++;
            if (!inspectGrid) return;
            gridFrames++;
            const rows: number[] = [];
            for (let y = 100; y < 435; y++) {
                const p = (OSD_WIDTH * y + 350) * 3;
                if (frame[p + 1] > 170 && (rows.length === 0 || y - rows[rows.length - 1] > 3)) rows.push(y);
            }
            if (rows.length !== 6 || rows.some((y, index) => Math.abs(y - (120 + 60 * index)) > 1)) badGrid.push(rows);
        }));
        viewer.stderr!.on('data', data => { viewerErrors += data; });
        viewer.stdio[3]!.on('data', (data: Buffer) => { if (data.some(value => value === 0x55)) nonSilentAudio = true; });
        const center = (OSD_WIDTH * 250 + 350) * 3;
        await until(() => !!latest && latest[center + 2] > 170 && latest[center] < 30, 'cached video missing: ' + logs.join('\n'));
        assert.equal(monitorCalls, 0, 'background stream must not wake the doorbell');
        assert.equal(foregroundPlays, 0, 'status-only video must not request automatic acceptance');
        const session = (video as any).session;
        const videoSsrc = new Set<number>(), audioSsrc = new Set<number>();
        let sequence: number | undefined;
        session.on('rtp', (kind: string, bytes: Buffer) => {
            const rtp = RtpPacket.deSerialize(bytes);
            (kind === 'video' ? videoSsrc : audioSsrc).add(rtp.header.ssrc);
            if (kind === 'audio') {
                if (sequence !== undefined) assert.equal(rtp.header.sequenceNumber, (sequence + 1) & 0xffff);
                sequence = rtp.header.sequenceNumber;
            }
        });
        const watchUrl = await video.getStream(true, '0123456789abcdef');
        assert(watchUrl.endsWith('/intent/0123456789abcdef/watch'));
        watcher = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-i', watchUrl, '-an', '-f', 'null', '-']);
        watcher.stdout!.resume(); watcher.stderr!.resume();
        await until(() => monitorCalls === 1, 'foreground view did not start monitor');
        assert.equal(foregroundPlays, 1, 'OSD forwards actual foreground PLAY intent');
        const beforeLive = frames;
        await delay(300); assert(frames > beforeLive, 'poster must keep playing while cloud connection is pending');
        current = source as unknown as AiphoneSession;
        monitoring.resolve(current); state.call = 'Monitoring';
        const address = udp.address();
        encoder = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'color=red:s=640x480:r=10,drawgrid=w=80:h=60:t=3:c=white',
            '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-g', '10', '-threads', '1',
            '-f', 'rtp', '-payload_type', '96', `rtp://127.0.0.1:${address.port}?pkt_size=1200`]);
        encoder.stdout!.resume(); encoder.stderr!.resume();
        let n = 0;
        audioTimer = setInterval(() => source.emit('rtp', 'audio', new RtpPacket(new RtpHeader({ payloadType: 0,
            sequenceNumber: n++ & 0xffff, timestamp: n * 160, ssrc: 12345 }), Buffer.alloc(160, 0x55)).serialize()), 20);
        await until(() => !!latest && latest[center] > 170 && latest[center + 2] < 40, 'live red video missing').catch(error => {
            throw new Error(`${error.message}; output=${latest?.subarray(center, center + 3).toString('hex')}; live=${session.liveFrame?.subarray(center, center + 3).toString('hex')}; age=${Date.now() - session.liveAt}; frames=${frames}; queued=${session.encoder?.stdin.writableLength}; viewer=${viewerErrors}`);
        });
        await until(() => nonSilentAudio, 'doorbell audio did not pass through');
        assert.equal(source.viewers, 1, 'all virtual watchers share one source viewer');
        inspectGrid = true;
        await until(() => gridFrames >= 22, 'not enough frames to validate geometry across keyframes');
        pauseVideo = true;
        await delay(1900);
        assert(latest![center] > 170 && latest![center + 2] < 40, 'a stalled source must keep the last live frame, not jump back to blue');
        pauseVideo = false;
        await until(() => Date.now() - session.liveAt < 300, 'live decoder did not recover after the pause');
        const requestedBeforeLoss = keyframeRequests;
        dropFragment = true;
        await until(() => dropped, 'test did not drop a fragmented H264 packet');
        await until(() => keyframeRequests > requestedBeforeLoss, 'damaged video did not request a replacement keyframe');
        const beforeRecovery = gridFrames;
        await until(() => gridFrames >= beforeRecovery + 15 && Date.now() - session.liveAt < 300, 'decoder did not recover from damaged video');
        assert.deepEqual(badGrid, [], 'grid rows must not drift or stretch between keyframes');
        assert.equal(logs.filter(line => line === 'OSD source: Cached snapshot').length, 1, 'network jitter must not switch the image back to an old snapshot');
        inspectGrid = false;
        stop(watcher); watcher = undefined;
        await until(() => source.viewers === 0, 'status-only reader must not keep the cloud session alive');
        source.closed = true; source.emit('close'); current = undefined; state.call = 'Idle';
        await until(() => !!latest && latest[center + 2] > 170 && latest[center] < 30, 'cached video did not return');
        assert.equal(viewer.exitCode, null, viewerErrors);
        assert.equal(videoSsrc.size, 1, 'video encoder must not restart across source changes');
        assert.equal(audioSsrc.size, 1, 'audio timeline must not restart across source changes');
        assert.equal(monitorCalls, 1);
        stop(viewer); viewer = undefined;
        await until(() => session.closed, 'local encoder did not stop after the last viewer left');
        assert.equal(source.viewers, 0);
    } catch (error) {
        const session = (video as any).session;
        throw new Error(`${(error as Error).message}; logs=${logs.join(' | ')}; decoder=${!!session?.decoder}; liveAt=${session?.liveAt}; pending=${session?.decoderPending}; attempts=${session?.decoderAttempts}`);
    } finally {
        delayed.forEach(clearTimeout);
        if (audioTimer) clearInterval(audioTimer);
        stop(viewer); stop(watcher); stop(encoder); udp.close();
        source.closed = true; source.emit('close'); monitoring.resolve(source as any);
        await video.close(); await rtsp.close();
    }
});
