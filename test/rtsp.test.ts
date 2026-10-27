import assert from 'node:assert/strict';
import { test } from 'node:test';
import net from 'node:net';
import { EventEmitter, once } from 'node:events';
import { RtspServer } from '../src/rtsp';
import { withTimeout } from '../src/protocol';

test('a cloud start failure returns RTSP 503 instead of an unexplained EOF', async () => {
    const logs: string[] = [];
    const server = new RtspServer(async () => { throw new Error('Aiphone rejected 23021 (RSLT=480)'); }, message => logs.push(message));
    const url = new URL(await server.listen());
    const socket = net.createConnection({ host: url.hostname, port: Number(url.port) });
    try {
        await once(socket, 'connect');
        let response = '';
        socket.on('data', chunk => response += chunk.toString());
        const closed = once(socket, 'close');
        socket.write(`DESCRIBE ${url} RTSP/1.0\r\nCSeq: 1\r\n\r\n`);
        await withTimeout(closed, 2000, 'RTSP response did not close');
        assert.match(response, /^RTSP\/1.0 503 Service Unavailable/);
        assert.match(response, /Retry-After: 5/);
        assert(logs.some(line => line.includes('RSLT=480')));
    } finally { socket.destroy(); await server.close(); }
});
test('the snapshot decoder endpoint cannot create a missing video session', async () => {
    let opened = 0;
    const server = new RtspServer(async () => { opened++; throw new Error('Must not start'); }, () => {}, () => undefined);
    await server.listen();
    const url = new URL(server.passiveUrl);
    const socket = net.createConnection({ host: url.hostname, port: Number(url.port) });
    try {
        await once(socket, 'connect');
        let response = ''; socket.on('data', chunk => response += chunk.toString());
        const closed = once(socket, 'close');
        socket.write(`DESCRIBE ${url} RTSP/1.0\r\nCSeq: 1\r\n\r\n`);
        await withTimeout(closed, 2000, 'RTSP response did not close');
        assert.match(response, /^RTSP\/1.0 503/); assert.equal(opened, 0);
    } finally { socket.destroy(); await server.close(); }
});

test('foreground intent begins once at PLAY, never on DESCRIBE or passive reads, and expires on disconnect', async () => {
    const starts: { path: string; active: () => boolean }[] = [];
    const session = Object.assign(new EventEmitter(), { closed: false, audioPacketsForwarded: 0,
        tracks: [{ kind: 'video' as const, payloadType: 96, rtpmap: 'a=rtpmap:96 H264/90000' }],
        addViewer() {}, removeViewer() {}, requestKeyframe() {} });
    const server = new RtspServer(async () => session, () => {}, () => session,
        (_session, path, active) => { if (path.endsWith('/watch')) starts.push({ path, active }); });
    await server.listen();
    try {
        for (const suffix of ['/background', '/snapshot-cache', '/watch']) {
            const uri = new URL(server.url + suffix);
            const socket = net.createConnection({ host: uri.hostname, port: Number(uri.port) });
            await once(socket, 'connect');
            let cseq = 0;
            const send = async (method: string, target = String(uri), headers = '') => {
                let pending = Buffer.alloc(0);
                const done = new Promise<string>((resolve, reject) => {
                    const onData = (chunk: Buffer) => {
                        pending = Buffer.concat([pending, chunk]);
                        const end = pending.indexOf('\r\n\r\n');
                        if (end < 0) return;
                        const length = Number(pending.subarray(0, end).toString().match(/Content-Length: (\d+)/i)?.[1] || 0);
                        if (pending.length < end + 4 + length) return;
                        socket.off('data', onData); socket.off('error', reject); resolve(pending.toString());
                    };
                    socket.on('data', onData); socket.once('error', reject);
                });
                socket.write(`${method} ${target} RTSP/1.0\r\nCSeq: ${++cseq}\r\n${headers}\r\n`);
                const response = await withTimeout(done, 2000, 'RTSP test request timed out');
                assert.match(response, /^RTSP\/1.0 200/);
            };
            try {
                await send('DESCRIBE'); assert.equal(starts.length, 0);
                await send('SETUP', server.url + '/trackID=0', 'Transport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n');
                assert.equal(starts.length, 0);
                await send('PLAY'); await send('PLAY');
                if (suffix === '/watch') {
                    assert.equal(starts.length, 1); assert(starts[0].active());
                    await send('TEARDOWN'); assert.equal(starts[0].active(), false, 'TEARDOWN cancels intent immediately');
                }
                else assert.equal(starts.length, 0);
            } finally {
                socket.destroy(); await new Promise(resolve => setTimeout(resolve, 20));
            }
        }
        assert.equal(starts[0].active(), false);
    } finally { await server.close(); }
});
