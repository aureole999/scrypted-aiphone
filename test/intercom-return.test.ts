import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter, once } from 'node:events';
import dgram from 'node:dgram';
import { spawn } from 'node:child_process';
import { intercomArguments } from '../src/intercom';
import { RtspServer } from '../src/rtsp';
import { AiphoneSession } from '../src/media';
import { Deferred, withTimeout } from '../src/protocol';

test('HomeKit-style live Opus RTSP is decoded into non-silent 8 kHz PCMU', { timeout: 15000 }, async t => {
    const check = spawn('ffmpeg', ['-version']);
    try { await once(check, 'spawn'); } catch { t.skip('ffmpeg is not installed'); return; }
    await once(check, 'exit');
    const source = Object.assign(new EventEmitter(), {
        closed: false, tracks: [{ kind: 'audio', payloadType: 111, rtpmap: 'a=rtpmap:111 opus/48000/2' }],
        addViewer() {}, removeViewer() {}, requestKeyframe() {},
    }) as unknown as AiphoneSession;
    const server = new RtspServer(async () => source, () => {});
    const udp = dgram.createSocket('udp4');
    let encoder: ReturnType<typeof spawn> | undefined, decoder: ReturnType<typeof spawn> | undefined;
    try {
        const listening = once(udp, 'listening'); udp.bind(0, '127.0.0.1'); await listening;
        udp.on('message', packet => source.emit('rtp', 'audio', packet));
        const url = await server.listen();
        encoder = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
            '-ac', '2', '-c:a', 'libopus', '-f', 'rtp', '-payload_type', '111', `rtp://127.0.0.1:${udp.address().port}`]);
        decoder = spawn('ffmpeg', intercomArguments(['-rtsp_transport', 'tcp', '-acodec', 'libopus', '-i', url]));
        let errors = '', total = 0;
        encoder.stderr?.on('data', data => { errors += data; });
        decoder.stderr?.on('data', data => { errors += data; });
        const decoded = new Deferred<Buffer>();
        decoder.stdout?.on('data', data => { total += data.length; if (total >= 1600) decoded.resolve(data); });
        const pcmu = await withTimeout(decoded.promise, 9000, 'No decoded microphone audio');
        assert(pcmu.some(value => value !== 0xff && value !== 0x7f), errors || 'Audio must contain the test tone');
    } finally {
        encoder?.kill(); decoder?.kill(); udp.close(); await server.close();
    }
});
