import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import dgram from 'node:dgram';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { MediaStreamTrack, RTCPeerConnection, RtpHeader, RtpPacket, useH264, usePCMU } from 'werift';
import { AiphoneSession, AudioUplink, Signaling } from '../src/media';
import { Deferred, Signal, withTimeout } from '../src/protocol';
import { RtspServer } from '../src/rtsp';
import { SnapshotCache } from '../src/snapshot';

const credentials = { cliid: 'CLIENT', unit_mac: 'AA', iot_host: 'example.com', sndtpc: 'AA/send/unit', rcvtpc: 'AA/recv/client', cert_pem: '', seckey_pem: '', termname: 'Scrypted' };
function peer() { return new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle', iceUseIpv6: false, iceAdditionalHostAddresses: ['127.0.0.1'], codecs: { audio: [usePCMU()], video: [useH264({ payloadType: 102 })] } }); }

async function cloud() {
    const subscriber = peer();
    const video = new MediaStreamTrack({ kind: 'video' });
    const audio = new MediaStreamTrack({ kind: 'audio' });
    subscriber.addTransceiver(audio, { direction: 'sendonly' });
    subscriber.addTransceiver(video, { direction: 'sendonly' });
    let publisher: RTCPeerConnection | undefined;
    const receivedAudio: Buffer[] = [];
    const messages: string[] = [];
    const signaling: Signaling = {
        credentials, log: () => {}, ended: () => {}, answered: () => {},
        send: (mid) => { messages.push(mid); },
        request: async (mid, reply, cid, body): Promise<Signal> => {
            messages.push(mid);
            let result: Record<string, any> = {};
            if (mid === '30001' || mid === '30021') {
                publisher = peer();
                publisher.addTransceiver('audio', { direction: 'recvonly' });
                publisher.onTrack.subscribe(track => track.onReceiveRtp.subscribe(rtp => { receivedAudio.push(Buffer.from(rtp.payload)); }));
                await publisher.setRemoteDescription({ type: 'offer', sdp: body!.SDP });
                await publisher.setLocalDescription(await publisher.createAnswer());
                result = { SDP: publisher.localDescription!.sdp };
            } else if (mid === '30011') {
                await subscriber.setLocalDescription(await subscriber.createOffer());
                result = { SDP: subscriber.localDescription!.sdp };
            } else if (mid === '30012') await subscriber.setRemoteDescription({ type: 'answer', sdp: body!.SDP });
            return { HEADER: { MID: reply, CID: cid, RSLT: 200 }, BODY: result };
        },
    };
    // Passive setup uses send(30012) instead of request().
    signaling.send = (mid, _cid, body) => {
        messages.push(mid);
        if (mid === '30012') void subscriber.setRemoteDescription({ type: 'answer', sdp: body!.SDP });
    };
    return { signaling, video, audio, messages, receivedAudio, close: async () => { await subscriber.close(); await publisher?.close(); } };
}

test('real WebRTC monitor forwards video RTP and gates microphone until acceptance', { timeout: 30000 }, async () => {
    const remote = await cloud();
    const session = new AiphoneSession(remote.signaling, 'monitor1', 'monitor');
    try {
        await session.start();
        assert.equal(session.accepted, false);
        assert.equal(session.uplink!.enabled, false);
        assert.deepEqual(session.tracks.map(t => t.kind), ['audio', 'video']);
        const received = new Deferred<Buffer>();
        session.on('rtp', (kind, packet) => { if (kind === 'video') received.resolve(packet); });
        const packet = new RtpPacket(new RtpHeader(), Buffer.alloc(0));
        packet.header.payloadType = 102; packet.header.ssrc = 1234; packet.header.sequenceNumber = 10; packet.header.timestamp = 9000;
        packet.payload = Buffer.from([0x65, 1, 2, 3]);
        remote.video.writeRtp(packet);
        const forwarded = RtpPacket.deSerialize(await withTimeout(received.promise, 3000, 'RTP not forwarded'));
        assert.deepEqual(forwarded.payload, packet.payload);
        assert.equal(remote.messages.includes('23022'), false);
        await session.answer();
        assert.equal(session.accepted, true);
        assert.equal(session.talkAudioReady, false);
        const audioReady = new Deferred<void>();
        const changed = () => { if (session.talkAudioReady) audioReady.resolve(); };
        session.on('state', changed);
        remote.audio.writeRtp(new RtpPacket(new RtpHeader({ payloadType: 0, ssrc: 1235,
            sequenceNumber: 1, timestamp: 160 }), Buffer.alloc(160, 0xff)));
        await withTimeout(audioReady.promise, 3000, 'First call audio did not update status');
        session.off('state', changed);
        assert.equal(session.talkAudioReady, true);
        for (let i = 0; i < 5; i++) session.uplink!.push(Buffer.alloc(160, 0x55));
        await new Promise(resolve => setTimeout(resolve, 200));
        assert(remote.receivedAudio.some(data => data.equals(Buffer.alloc(160, 0x55))), 'accepted PCMU microphone should reach remote WebRTC peer');
        await session.close();
        assert.equal(remote.messages.filter(mid => mid === '30031').length, 1);
        assert.equal(remote.messages.filter(mid => mid === '23003').length, 1);
        await session.close();
        assert.equal(remote.messages.filter(mid => mid === '30031').length, 1);
    } finally { await session.close(true); await remote.close(); }
});

test('ring preview remains unanswered; explicit answer creates a separate publisher', { timeout: 30000 }, async () => {
    const remote = await cloud();
    const session = new AiphoneSession(remote.signaling, 'ring1', 'ring');
    try {
        await session.start();
        assert(remote.messages.includes('24001'));
        assert(!remote.messages.includes('30021'));
        assert(!remote.messages.includes('24002'));
        await session.answer();
        assert(remote.messages.indexOf('30021') < remote.messages.indexOf('24002'));
        assert.equal(session.isOwnCancel({ NCID: 'CLIENT' }), true);
        assert.equal(session.isOwnCancel({ NCID: 'OTHER' }), false);
    } finally { await session.close(true); await remote.close(); }
});

test('closing an auto-answer viewer during publisher setup keeps the ring unanswered and reuses the prepared publisher', { timeout: 30000 }, async () => {
    const remote = await cloud();
    const original = remote.signaling.request;
    const negotiating = new Deferred<void>(), proceed = new Deferred<void>();
    remote.signaling.request = async (...args) => {
        const response = await original(...args);
        if (args[0] === '30021') { negotiating.resolve(); await proceed.promise; }
        return response;
    };
    const session = new AiphoneSession(remote.signaling, 'auto-ring-cancel', 'ring');
    let active = true;
    try {
        await session.start();
        const automatic = session.answer(() => active);
        await negotiating.promise; active = false; proceed.resolve();
        await automatic;
        assert.equal(session.accepted, false); assert.equal(session.answerRequested, false);
        assert.equal(session.closed, false); assert.equal(session.uplink?.enabled, false);
        assert(!remote.messages.includes('24002'));
        await session.answer();
        assert.equal(session.accepted, true); assert.equal(session.uplink?.enabled, true);
        assert.equal(remote.messages.filter(mid => mid === '30021').length, 1, 'do not leak a second publisher');
        assert.equal(session.uplink?.framesReceived, 0, 'automatic acceptance must not capture microphone audio');
    } finally { proceed.resolve(); await session.close(true); await remote.close(); }
});

test('a manual microphone request can take over pending automatic acceptance without duplicate signaling', { timeout: 30000 }, async () => {
    const remote = await cloud();
    const original = remote.signaling.request;
    const negotiating = new Deferred<void>(), proceed = new Deferred<void>();
    remote.signaling.request = async (...args) => {
        const response = await original(...args);
        if (args[0] === '30021') { negotiating.resolve(); await proceed.promise; }
        return response;
    };
    const session = new AiphoneSession(remote.signaling, 'auto-ring-manual', 'ring');
    let active = true;
    try {
        await session.start();
        const automatic = session.answer(() => active);
        await negotiating.promise; active = false;
        const manual = session.answer(); proceed.resolve();
        await Promise.all([automatic, manual]);
        assert.equal(session.accepted, true);
        assert.equal(remote.messages.filter(mid => mid === '30021').length, 1);
        assert.equal(remote.messages.filter(mid => mid === '24002').length, 1);
    } finally { proceed.resolve(); await session.close(true); await remote.close(); }
});

test('PCMU downlink arriving after preview starts is audible through the same RTSP connection', { timeout: 20000 }, async t => {
    const check = spawn('ffmpeg', ['-version']);
    try { await once(check, 'spawn'); } catch { t.skip('ffmpeg is not installed'); return; }
    await once(check, 'exit');
    const remote = await cloud();
    const session = new AiphoneSession(remote.signaling, 'delayed-audio', 'monitor');
    const server = new RtspServer(async () => session, () => {});
    let decoder: ReturnType<typeof spawn> | undefined, timer: NodeJS.Timeout | undefined;
    try {
        await session.start();
        const url = await server.listen();
        decoder = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-analyzeduration', '100000', '-probesize', '512',
            '-rtsp_transport', 'tcp', '-i', url, '-vn', '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1']);
        let errors = '';
        decoder.stderr?.on('data', data => { errors += data; });
        const decoded = new Deferred<Buffer>();
        decoder.stdout?.on('data', data => decoded.resolve(data));
        await withTimeout((async () => { while (!session.viewers) await new Promise(resolve => setTimeout(resolve, 10)); })(), 4000, 'RTSP did not start');
        await new Promise(resolve => setTimeout(resolve, 500));
        assert.equal(session.audioPacketsReceived, 0);
        await session.answer();
        let sequence = 0;
        const payload = Buffer.from(Array.from({ length: 160 }, (_, index) => index % 20 < 10 ? 0x80 : 0));
        timer = setInterval(() => {
            remote.audio.writeRtp(new RtpPacket(new RtpHeader({ payloadType: 0, sequenceNumber: sequence++, timestamp: sequence * 160, ssrc: 123456 }), payload));
        }, 20);
        const pcm = await withTimeout(decoded.promise, 7000, 'Delayed downlink was not decoded: ' + errors);
        const samples = Array.from({ length: Math.floor(pcm.length / 2) }, (_, index) => pcm.readInt16LE(index * 2));
        assert(samples.some(sample => sample > 30000) && samples.some(sample => sample < -30000), errors);
        assert(session.audioPacketsForwarded > 0);
        assert.equal(session.audioPeakDb, 0);
        assert.equal(session.audioPayloadType, 0);
    } finally {
        if (timer) clearInterval(timer);
        decoder?.kill(); await server.close(); await session.close(true); await remote.close();
    }
});

// Decode a real generated H.264 frame after crossing WebRTC and the plugin's RTSP relay.
test('FFmpeg decodes H.264 through WebRTC → loopback RTSP/TCP → JPEG', { timeout: 35000 }, async t => {
    const check = spawn('ffmpeg', ['-version']);
    try { await once(check, 'spawn'); } catch { t.skip('ffmpeg is not installed'); return; }
    await once(check, 'exit');
    const remote = await cloud();
    const session = new AiphoneSession(remote.signaling, 'monitor2', 'monitor');
    const server = new RtspServer(async () => { await session.ready.promise; return session; }, () => {}, () => session.closed ? undefined : session);
    let savedSnapshot: string | undefined;
    const cache = new SnapshotCache('test', () => undefined, value => { savedSnapshot = value; });
    const captured = once(cache, 'updated');
    const udp = dgram.createSocket('udp4');
    let encoder: ReturnType<typeof spawn> | undefined;
    let decoder: ReturnType<typeof spawn> | undefined;
    try {
        const listening = once(udp, 'listening'); udp.bind(0, '127.0.0.1'); await listening;
        udp.on('message', data => remote.video.writeRtp(data));
        await session.start();
        const url = await server.listen();
        cache.start(session, 'ffmpeg', server.passiveUrl);
        encoder = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:r=10',
            '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-g', '10', '-f', 'rtp', '-payload_type', '102', `rtp://127.0.0.1:${udp.address().port}?pkt_size=1200`]);
        let encoderErrors = ''; encoder.stderr?.on('data', chunk => encoderErrors += chunk.toString());
        decoder = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-i', url, '-an', '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1']);
        const jpeg: Buffer[] = []; let errors = '';
        decoder.stdout?.on('data', data => jpeg.push(data)); decoder.stderr?.on('data', chunk => errors += chunk.toString());
        const [code] = await withTimeout(once(decoder, 'exit'), 20000, 'FFmpeg RTSP snapshot timed out');
        assert.equal(code, 0, errors + encoderErrors);
        const image = Buffer.concat(jpeg);
        assert.equal(image.readUInt16BE(0), 0xffd8, 'JPEG start marker');
        assert(image.length > 500, 'JPEG frame should contain image data');
        await withTimeout(captured, 12000, 'Passive snapshot decoder did not receive a frame');
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(session.viewers, 0, 'snapshot decoder must not keep the monitor alive');
        assert.equal(cache.read().readUInt16BE(0), 0xffd8);
        const latest = cache.read(); const capturedAt = cache.capturedAt;
        cache.stop();
        const restored = new SnapshotCache('test', () => savedSnapshot, () => {});
        assert.deepEqual(restored.read(), latest); assert.equal(restored.capturedAt, capturedAt);
    } finally {
        cache.stop(); encoder?.kill(); decoder?.kill(); udp.close();
        await server.close(); await session.close(true); await remote.close();
    }
});


test('monitor microphone requires an explicit 24022 RSLT=200', async () => {
    const signaling: Signaling = {
        credentials, log: () => {}, send: () => {}, ended: () => {}, answered: () => { throw new Error('must not mark answered'); },
        request: async (_mid, reply, cid) => ({ HEADER: { MID: reply, CID: cid, RSLT: 0 } }),
    };
    const session = new AiphoneSession(signaling, 'rejected', 'monitor');
    session.uplink = new AudioUplink();
    session.ready.resolve();
    await assert.rejects(session.answer(), /not accepted/);
    assert.equal(session.accepted, false);
    assert.equal(session.uplink.enabled, false);
    assert.equal(session.closed, true);
});

test('reply readiness waits on post-answer audio and media connection events', async () => {
    const signaling: Signaling = { credentials, log() {}, send() {}, ended() {}, answered() {},
        request: async () => ({ HEADER: {} }) };
    const session = new AiphoneSession(signaling, 'reply-ready', 'ring');
    session.uplink = new AudioUplink();
    const publisher = { connectionState: 'connecting' }, subscriber = { connectionState: 'connected' };
    Object.assign(session, { publisher, subscriber });
    const packet = new RtpPacket(new RtpHeader({ payloadType: 0 }), Buffer.alloc(160, 0xff));
    const receive = () => (session as any).receiveAudio(packet);
    try {
        await assert.rejects(session.waitForReplyAudio(), /not been accepted/);
        receive();
        session.accepted = true; session.uplink.enabled = true;
        let ready = false;
        const waiting = session.waitForReplyAudio(undefined, 2000).then(() => { ready = true; });
        await new Promise(resolve => setTimeout(resolve, 60));
        assert.equal(ready, false, 'monitor audio before acceptance must not count');
        receive();
        await new Promise(resolve => setTimeout(resolve, 60));
        assert.equal(ready, false, 'first call audio does not imply a connected publisher');
        publisher.connectionState = 'connected'; session.emit('state');
        await new Promise(resolve => setTimeout(resolve, 60));
        assert.equal(ready, false, 'retain the brief settling period before playback');
        await waiting;
        assert.equal(ready, true);
        assert.equal(session.listenerCount('state'), 0);
        assert.equal(session.listenerCount('close'), 0);
        session.audioLastReceivedAt = undefined;
        await session.waitForReplyAudio();  // A later audio gap does not reset readiness.
        const abort = new AbortController();
        const cancelled = session.waitForReplyAudio(abort.signal); abort.abort();
        await assert.rejects(cancelled, /cancelled/);
        assert.equal(session.listenerCount('state'), 0);
        const closed = session.waitForReplyAudio(); session.closed = true; session.emit('close');
        await assert.rejects(closed, /has ended/);
        assert.equal(session.listenerCount('state'), 0);
        assert.equal(session.listenerCount('close'), 0);
    } finally { session.uplink.close(); }
});

test('reply wait times out without first audio and removes temporary listeners', async () => {
    const signaling: Signaling = { credentials, log() {}, send() {}, ended() {}, answered() {},
        request: async () => ({ HEADER: {} }) };
    const session = new AiphoneSession(signaling, 'no-audio', 'monitor');
    session.accepted = true;
    session.uplink = new AudioUplink(); session.uplink.enabled = true;
    try {
        await assert.rejects(session.waitForReplyAudio(undefined, 30), /waiting for call audio/);
        assert.equal(session.listenerCount('state'), 0);
        assert.equal(session.listenerCount('close'), 0);
    } finally { session.uplink.close(); }
});

test('first post-answer packet confirms audio once and later packet gaps do not reset it', () => {
    const signaling: Signaling = { credentials, log() {}, send() {}, ended() {}, answered() {},
        request: async () => ({ HEADER: {} }) };
    const session = new AiphoneSession(signaling, 'talk-state', 'monitor');
    const packet = new RtpPacket(new RtpHeader({ payloadType: 0 }), Buffer.alloc(160, 0xff));
    const receive = () => (session as any).receiveAudio(packet);
    let updates = 0;
    session.on('state', () => updates++);
    receive();
    assert.equal(session.talkAudioReady, false);
    assert.equal(updates, 0);
    session.accepted = true;
    assert.equal(session.talkAudioReady, false, 'preview audio cannot confirm an accepted call');
    receive();
    assert.equal(session.audioLevelDb, -96);
    assert.equal(session.talkAudioReady, true, 'a silent packet also confirms the audio route');
    assert.equal(updates, 1);
    receive(); receive();
    assert.equal(updates, 1, 'later audio packets do not trigger status refreshes');
    session.audioLastReceivedAt = Date.now() - 60000;
    assert.equal(session.talkAudioReady, true);
    assert.equal(updates, 1);
    session.closed = true;
    assert.equal(session.talkAudioReady, false);
    assert.equal(new AiphoneSession(signaling, 'next-call', 'monitor').talkAudioReady, false);
});
