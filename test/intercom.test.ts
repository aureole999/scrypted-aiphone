import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Deferred } from '../src/protocol';
import { intercomArguments, safeAudioError } from '../src/intercom';

async function doorbellClass(mediaManager: object) {
    Object.assign(globalThis, {
        deviceManager: { getDeviceLogger: () => console },
        endpointManager: {}, mediaManager, systemManager: {}, pluginHostAPI: {},
    });
    const warn = console.warn;
    console.warn = (...args) => { if (args[0] !== 'failed to load custom interface descriptors') warn(...args); };
    try { return (await import('../src/main')).Doorbell; }
    finally { console.warn = warn; }
}

test('stopping Intercom during call acceptance prevents a late microphone process', async () => {
    const manager = {
        convertMediaObjectToBuffer: async () => Buffer.from(JSON.stringify({ inputArguments: [] })),
        getFFmpegPath: async () => '/must-not-be-launched/ffmpeg',
    };
    const Doorbell = await doorbellClass(manager);
    const answering = new Deferred<void>(), answerStarted = new Deferred<void>();
    let closes = 0;
    const session = { closed: false,
        answer: async () => { answerStarted.resolve(); await answering.promise; },
        close: async () => { closes++; session.closed = true; },
    };
    const camera = Object.assign(Object.create(Doorbell.prototype), {
        audioGeneration: 0, startingAudio: false,
        controller: { ensureVideo: async () => session },
        settingsChanged: async () => {},
    });
    Object.defineProperty(camera, 'console', { value: { log: () => {}, error: () => {} } });
    const start = camera.startIntercom({});
    await answerStarted.promise;
    await assert.rejects(camera.startIntercom({}), /microphone or recording is already/);
    await camera.stopIntercom();
    answering.resolve();
    await assert.rejects(start, /Intercom was cancelled/);
    assert(closes > 0);
    assert.equal(camera.audio, undefined);
    assert.equal(camera.audioSession, undefined);
    assert.equal(camera.startingAudio, false);
});

test('live HomeKit return audio is decoded without file pacing or lengthy probing', () => {
    const input = ['-rtsp_transport', 'tcp', '-acodec', 'libopus', '-i', 'rtsp://127.0.0.1:1234'];
    const args = intercomArguments(input);
    assert(!args.includes('-re'));
    assert(args.indexOf('-probesize') < args.indexOf('-i'));
    assert.deepEqual(args.slice(-10), ['-vn', '-ac', '1', '-ar', '8000', '-acodec', 'pcm_mulaw', '-f', 'mulaw', 'pipe:1']);
    assert(intercomArguments(['-i', '/recordings/reply.wav']).includes('-re'));
});

test('decoder diagnostics hide input URLs and remain bounded', () => {
    assert.equal(safeAudioError('Unable to open rtsp://user:secret@127.0.0.1:123/token: Connection refused'), 'Unable to open [audio input] Connection refused');
    assert.equal(safeAudioError('x'.repeat(3000)).length, 2000);
});
