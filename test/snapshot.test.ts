import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JpegFrames, SnapshotCache } from '../src/snapshot';
import { NO_SNAPSHOT_JPEG } from '../src/no-snapshot';

const frame = NO_SNAPSHOT_JPEG;
test('MJPEG framing handles split markers, multiple frames, and bounded corrupt output', () => {
    const parser = new JpegFrames();
    assert.deepEqual(parser.push(Buffer.from([1, 2, 0xff])), []);
    assert.deepEqual(parser.push(frame.subarray(1, 50)), []);
    const result = parser.push(Buffer.concat([frame.subarray(50), frame]));
    assert.equal(result.length, 2); assert.deepEqual(result[0], frame); assert.deepEqual(result[1], frame);
    parser.push(Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(1024 * 1024 + 1)]));
    assert.deepEqual(parser.push(frame), [frame]);
});
test('empty, invalid, and other-device caches return a valid placeholder without I/O', () => {
    for (const stored of [undefined, '{bad', JSON.stringify({ unit: 'other', jpeg: frame.toString('base64'), capturedAt: Date.now() })]) {
        let writes = 0, loads = 0;
        const cache = new SnapshotCache('unit', () => { loads++; return stored; }, () => writes++);
        for (let i = 0; i < 10; i++) assert.deepEqual(cache.read(), frame);
        assert.equal(loads, 1); assert.equal(writes, 0); assert.equal(cache.capturedAt, undefined);
    }
});
test('the last JPEG survives restart and is served even while no media session exists', () => {
    const capturedAt = Date.now() - 86400000;
    const saved = JSON.stringify({ unit: 'unit', jpeg: frame.toString('base64'), capturedAt });
    const cache = new SnapshotCache('unit', () => saved, () => { throw new Error('Snapshot reads must not write'); });
    assert.equal(cache.capturedAt, capturedAt);
    assert.deepEqual(cache.read(), frame);
    const returned = cache.read(); returned[0] = 0;
    assert.equal(cache.read()[0], 0xff, 'callers cannot mutate the cached image');
});
test('Camera.takePicture never starts media or consults FFmpeg, including an empty cache', async () => {
    Object.assign(globalThis, {
        deviceManager: { getDeviceLogger: () => console }, endpointManager: {}, systemManager: {}, pluginHostAPI: {},
        mediaManager: {
            createMediaObject: async (data: Buffer, mimeType: string) => ({ data, mimeType }),
            getFFmpegPath: () => { throw new Error('Snapshot must not start FFmpeg'); },
        },
    });
    const warn = console.warn;
    console.warn = (...args) => { if (args[0] !== 'failed to load custom interface descriptors') warn(...args); };
    let Doorbell: typeof import('../src/main').Doorbell;
    try { Doorbell = (await import('../src/main')).Doorbell; } finally { console.warn = warn; }
    for (const stored of [undefined, JSON.stringify({ unit: 'unit', jpeg: frame.toString('base64'), capturedAt: 123 })]) {
        const camera = Object.assign(Object.create(Doorbell.prototype), {
            snapshotCache: new SnapshotCache('unit', () => stored, () => {}),
            controller: { online: false, ensureVideo: () => { throw new Error('Snapshot must not open a doorbell session'); } },
        });
        Object.defineProperty(camera, 'listening', { get() { throw new Error('Snapshot must not access RTSP'); } });
        for (let i = 0; i < 5; i++) {
            const image = await camera.takePicture();
            assert.equal(image.mimeType, 'image/jpeg'); assert.deepEqual(image.data, frame);
        }
    }
});
