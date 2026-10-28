import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundledReplyPath } from '../src/reply';
import { Deferred, withTimeout } from '../src/protocol';
import { AudioUplink } from '../src/media';
import { DIRECT_MODE, STATUS_MODE } from '../src/osd';
import { AUTO_ANSWER_OFF, AUTO_ANSWER_RINGING, AUTO_ANSWER_ALWAYS } from '../src/auto-answer';

const states = new Map<string, object>();
let manifest: { devices: { nativeId: string }[] };
Object.assign(globalThis, {
    deviceManager: {
        getDeviceLogger: () => console, getDeviceConsole: () => ({ log() {}, error() {} }),
        getDeviceState: (id: string) => { if (!states.has(id)) states.set(id, {}); return states.get(id); },
        onDevicesChanged: async (value: typeof manifest) => { manifest = value; }, onDeviceEvent: async () => {},
    },
    endpointManager: {}, systemManager: { setScryptedInterfaceDescriptors: async () => {} }, pluginHostAPI: {},
    mediaManager: {
        createFFmpegMediaObject: async (input: object) => input,
        convertMediaObjectToBuffer: async (input: object) => Buffer.from(JSON.stringify(input)),
        getFFmpegPath: async () => 'ffmpeg',
    },
});
let Provider: typeof import('../src/main').default;
let Doorbell: typeof import('../src/main').Doorbell;
let ReplySwitch: typeof import('../src/main').ReplySwitch;
let RingSensor: typeof import('../src/main').RingSensor;
before(async () => {
    const warn = console.warn;
    console.warn = (...args) => { if (args[0] !== 'failed to load custom interface descriptors') warn(...args); };
    try { ({ default: Provider, Doorbell, ReplySwitch, RingSensor } = await import('../src/main')); }
    finally { console.warn = warn; }
});
const tick = () => new Promise(resolve => setImmediate(resolve));
function camera(extra: object = {}) {
    return Object.assign(Object.create(Doorbell.prototype), {
        audioGeneration: 0, replyGeneration: 0, replyRunning: false, startingAudio: false,
        accessoryOptions: () => ({ unlock: false, reply: true }), settingsChanged: async () => {}, ringChanged: () => {},
        _console: { log() {}, error() {} }, _storage: { getItem: () => '' }, ...extra,
    });
}

test('optional accessories persist independently and toggling never triggers an action', async () => {
    const values = new Map<string, string>();
    let replies = 0, unlocks = 0, stops = 0;
    const bell = { refreshSettings: async () => {}, stopReply: async () => { stops++; },
        playReply: async () => { replies++; }, controller: { unlock: () => { unlocks++; } } };
    const provider = Object.assign(Object.create(Provider.prototype), {
        initialized: Promise.resolve(), credentials: { unit_mac: 'test' }, busy: false, doorbell: bell,
        _storage: { getItem: (key: string) => values.get(key), setItem: (key: string, value: string) => values.set(key, value) },
    });
    await provider.putSetting('enableReply', true);
    assert.deepEqual(manifest.devices.map(d => d.nativeId), ['doorbell', 'reply']);
    assert.equal(values.get('enableReply'), 'true');
    await assert.rejects(provider.getDevice('unlock'), /Unknown/);
    await provider.putSetting('enableUnlock', 'true');
    assert.deepEqual(manifest.devices.map(d => d.nativeId), ['doorbell', 'unlock', 'reply']);
    const oldUnlock = await provider.getDevice('unlock');
    await provider.putSetting('enableUnlock', false);
    assert.deepEqual(manifest.devices.map(d => d.nativeId), ['doorbell', 'reply']);
    await assert.rejects(oldUnlock.turnOn(), /not enabled/);
    const oldReply = await provider.getDevice('reply');
    await provider.putSetting('enableReply', false);
    assert.deepEqual(manifest.devices.map(d => d.nativeId), ['doorbell']);
    await assert.rejects(oldReply.turnOn(), /not enabled/);
    assert.equal(replies, 0); assert.equal(unlocks, 0); assert(stops > 0);
});

test('ring sensor is opt-in, read-only, independent of reply/unlock and removed safely', async () => {
    const values = new Map<string, string>();
    const provider = Object.assign(Object.create(Provider.prototype), {
        initialized: Promise.resolve(), credentials: { unit_mac: 'test' }, busy: false,
        doorbell: { refreshSettings: async () => {}, stopReply: async () => {},
            controller: { ensureVideo() { throw new Error('a sensor must never open media'); } } },
        _storage: { getItem: (key: string) => values.get(key), setItem: (key: string, value: string) => values.set(key, value) },
    });
    const setting = (await provider.getSettings()).find((s: any) => s.key === 'enableRingSensor');
    assert.equal(setting.value, false); assert.equal(setting.group, 'Accessories');
    await assert.rejects(provider.getDevice('ring-sensor'), /Unknown/);
    await provider.putSetting('enableRingSensor', true);
    assert.equal(values.get('enableRingSensor'), 'true');
    assert.deepEqual(manifest.devices.map(d => d.nativeId), ['doorbell', 'ring-sensor']);
    assert.deepEqual(manifest.devices.find(d => d.nativeId === 'ring-sensor'), {
        nativeId: 'ring-sensor', name: 'Aiphone Ring Sensor', type: 'Sensor', interfaces: ['BinarySensor'],
        info: { manufacturer: 'Aiphone', model: 'WP-2MED ring sensor' },
    });
    const oldSensor = await provider.getDevice('ring-sensor');
    assert.equal(oldSensor.binaryState, false, 'enabling while idle must not invent a ring');
    assert.equal(oldSensor.turnOn, undefined, 'the accessory must not be writable');
    oldSensor.setRinging(true); assert.equal(oldSensor.binaryState, true);
    await provider.putSetting('enableRingSensor', false);
    assert.deepEqual(manifest.devices.map(d => d.nativeId), ['doorbell']);
    assert.equal(oldSensor.binaryState, false);
    oldSensor.setRinging(true); assert.equal(oldSensor.binaryState, false, 'disabled instances must not emit later rings');
    await assert.rejects(provider.getDevice('ring-sensor'), /Unknown/);
    await provider.putSetting('enableRingSensor', 'true');
    const sensor = await provider.getDevice('ring-sensor');
    assert.notEqual(sensor, oldSensor); assert.equal(sensor.binaryState, false);
    await provider.releaseDevice('sensor-id', 'ring-sensor');
    sensor.setRinging(true); assert.equal(sensor.binaryState, false);
    provider.doorbell.binaryState = true;
    const currentRing = await provider.getDevice('ring-sensor');
    assert.equal(currentRing.binaryState, true, 'a newly loaded sensor must reflect the known current ring');
    await provider.releaseDevice('sensor-id', 'ring-sensor');
    assert.equal(values.get('enableUnlock'), undefined); assert.equal(values.get('enableReply'), undefined);
    provider.credentials = undefined;
    await provider.putSetting('enableRingSensor', true);
    assert.deepEqual(manifest.devices, [], 'unpaired providers must not create accessories');
    await assert.rejects(provider.getDevice('ring-sensor'), /Unknown/);
});

test('ring sensor and doorbell controls follow call state without a 1-second pulse reset', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const sensor = new RingSensor();
    let ringEvents = 0;
    const controller = { online: true, state: 'ringing' };
    const c = camera({ controller, ringChanged: (ringing: boolean) => {
        assert.equal(c.binaryState, ringing);
        if (ringing) ringEvents++;
        sensor.setRinging(ringing);
    } });
    c.incomingRing();
    assert.equal(c.binaryState, true); assert.equal(sensor.binaryState, true);
    t.mock.timers.tick(10000);
    assert.equal(sensor.binaryState, true);
    assert.equal(c.binaryState, true, 'ringing must persist beyond one second');
    const edges: boolean[] = [];
    let current = true;
    Object.defineProperty(sensor, 'binaryState', { get: () => current, set: (value: boolean) => { current = value; edges.push(value); } });
    c.syncRingState();
    assert.deepEqual(edges, [], 'unchanged ringing state must not repeat HomeKit notifications');
    c.incomingRing();
    assert.deepEqual(edges, [false, true], 'distinct calls must produce another open edge');
    for (const state of ['answered', 'idle']) {
        controller.state = state; c.syncRingState();
        assert.equal(sensor.binaryState, false); assert.equal(c.binaryState, false);
        controller.state = 'ringing'; c.syncRingState();
        assert.equal(sensor.binaryState, true); assert.equal(c.binaryState, true);
    }
    controller.online = false; c.syncRingState();
    assert.equal(sensor.binaryState, false); assert.equal(c.binaryState, false);
    controller.online = true; controller.state = 'idle'; c.syncRingState();
    assert.equal(sensor.binaryState, false, 'reconnect/monitoring must not invent a ring');
    sensor.setRinging(true); sensor.close(); t.mock.timers.tick(3000);
    assert.equal(sensor.binaryState, false);
    const count = ringEvents;
    c.closing = true; c.incomingRing(); assert.equal(ringEvents, count);
});

test('camera settings only expose status and disabled unlock rejects stale button calls', async () => {
    const flags = { reply: true, unlock: false };
    let unlocks = 0;
    const c = camera({ accessoryOptions: () => flags, snapshotCache: {},
        controller: { state: 'idle', online: true, unlock: () => { unlocks++; } } });
    let settings = await c.getSettings();
    assert.deepEqual(settings.map((s: any) => s.key), ['connection', 'call']);
    assert(settings.every((s: any) => s.group === 'Status' && s.readonly));
    await assert.rejects(c.putSetting('unlock', true), /not enabled/); assert.equal(unlocks, 0);
    flags.reply = false; flags.unlock = true;
    settings = await c.getSettings();
    assert.deepEqual(settings.map((s: any) => s.key), ['connection', 'call']);
});

test('doorbell status follows live sessions, incoming rings, replies, and disconnection without opening media', async () => {
    const controller: any = { online: false, state: 'idle', session: undefined,
        ensureVideo: () => { throw new Error('status must not open media'); } };
    const c = camera({ controller });
    const status = async () => (await c.getSettings()).find((s: any) => s.key === 'call').value;
    assert.equal(await status(), 'Offline');
    controller.online = true;
    assert.equal(await status(), 'Idle');
    controller.session = { accepted: false, closed: false };
    assert.equal(await status(), 'Monitoring');
    controller.state = 'ringing';
    assert.equal(await status(), 'Ringing');
    controller.state = 'answered'; controller.session.accepted = true;
    assert.equal(await status(), 'Connecting audio');
    controller.session.talkAudioReady = true;
    assert.equal(await status(), 'Answered (mic off)');
    c.replyRunning = true;
    assert.equal(await status(), 'Preparing reply');
    c.replyStatus = 'Playing reply';
    assert.equal(await status(), 'Playing reply');
    c.replyStatus = 'Preparing reply'; controller.session.accepted = false;
    assert.equal(await status(), 'Preparing reply');
    c.replyRunning = false; controller.session.closed = true;
    assert.equal(await status(), 'Idle');
    controller.online = false;
    assert.equal(await status(), 'Offline');
});

test('microphone status needs only first downlink audio and does not inspect later uplink activity', async () => {
    const session: any = { accepted: false, closed: false, talkAudioReady: false,
        uplink: { framesSent: 42, lastFrameSentAt: Date.now() - 60000 } };
    const controller = { online: true, state: 'ringing', session };
    const c = camera({ controller, startingAudio: true, audioOwner: 'microphone' });
    const status = async () => (await c.getSettings()).find((s: any) => s.key === 'call').value;
    assert.equal(await status(), 'Requesting call');
    session.accepted = true;
    assert.equal(await status(), 'Connecting audio');
    c.startingAudio = false; c.audio = {}; c.audioSession = session;
    session.talkAudioReady = true;
    assert.equal(await status(), 'In call', 'first downlink packet is sufficient');
    session.uplink.framesSent = 0;
    assert.equal(await status(), 'In call', 'no continuous microphone-frame checks');
    c.audioOwner = undefined; c.audio = undefined;
    assert.equal(await status(), 'Answered (mic off)');
    session.accepted = false; session.answering = true;
    assert.equal(await status(), 'Requesting call');
    session.closed = true; session.answering = false; controller.state = 'idle';
    assert.equal(await status(), 'Idle');
});

test('session state events refresh settings without a status polling interval', async () => {
    const session = Object.assign(new EventEmitter(), { accepted: false, closed: false, talkAudioReady: false });
    const controller = { online: true, state: 'idle', session };
    const states: string[] = [];
    const c = camera({ controller, audioOwner: 'microphone', audio: {}, audioSession: session });
    c.settingsChanged = async () => { c.lastStatus = c.statusText(); states.push(c.doorbellState()); };
    c.lastStatus = c.statusText();
    const unbind = c.bindSessionStatus(session);
    session.accepted = true; session.emit('state');
    session.talkAudioReady = true; session.emit('state');
    session.emit('state');
    assert.deepEqual(states, ['Connecting audio', 'In call']);
    unbind();
    assert.equal(session.listenerCount('state'), 0);
    session.closed = true; session.emit('state');
    assert.deepEqual(states, ['Connecting audio', 'In call']);
});

test('custom reply path moves to plugin configuration and preserves camera storage', async () => {
    const values = new Map([['enableReply', 'true'], ['replyPath', '/existing/reply.wav']]);
    const bell = camera({ _storage: { getItem: (key: string) => values.get(key),
        setItem: (key: string, value: string) => values.set(key, value) }, refreshSettings: async () => {} });
    const provider = Object.assign(Object.create(Provider.prototype), {
        initialized: Promise.resolve(), credentials: { unit_mac: 'test' }, busy: false, doorbell: bell,
        _storage: { getItem: (key: string) => values.get(key) },
    });
    const settings = await provider.getSettings();
    assert(settings.every((s: any) => s.group));
    assert.equal(settings.find((s: any) => s.key === 'replyPath').value, '/existing/reply.wav');
    assert(!settings.some((s: any) => ['network', 'discoveryLog', 'probe'].includes(s.key)));
    await provider.putSetting('replyPath', '/new/reply.wav');
    assert.equal(bell.getReplyPath(), '/new/reply.wav');
    await assert.rejects(provider.putSetting('replyPath', 'relative.wav'), /absolute/);
    assert.equal(bell.getReplyPath(), '/new/reply.wav');
});

test('experimental video mode is opt-in, persists without re-pairing or starting media, and can be reverted', async () => {
    const values = new Map<string, string>();
    let refreshes = 0;
    const provider = Object.assign(Object.create(Provider.prototype), {
        initialized: Promise.resolve(), busy: false, _console: { log() {} },
        doorbell: { refreshSettings: async () => { refreshes++; } },
        _storage: { getItem: (key: string) => values.get(key), setItem: (key: string, value: string) => values.set(key, value) },
    });
    let settings = await provider.getSettings();
    assert.equal(settings.find((s: any) => s.key === 'videoMode').value, DIRECT_MODE);
    assert.equal(settings.find((s: any) => s.key === 'videoMode').group, 'Experimental');
    await provider.putSetting('videoMode', STATUS_MODE);
    assert.equal(values.get('videoMode'), 'status-osd');
    settings = await provider.getSettings();
    assert.equal(settings.find((s: any) => s.key === 'videoMode').value, STATUS_MODE);
    await provider.putSetting('videoMode', DIRECT_MODE);
    assert.equal(values.get('videoMode'), 'direct'); assert.equal(refreshes, 2);
    await assert.rejects(provider.putSetting('videoMode', 'invalid'), /Unknown/);
    assert.equal(refreshes, 2);
});

test('experimental auto-answer defaults off and saves three policies without triggering any call', async () => {
    const values = new Map<string, string>();
    const provider = Object.assign(Object.create(Provider.prototype), {
        initialized: Promise.resolve(), busy: false, _console: { log() {} },
        doorbell: { refreshSettings: () => { throw new Error('saving must not act on the doorbell'); } },
        _storage: { getItem: (key: string) => values.get(key), setItem: (key: string, value: string) => values.set(key, value) },
    });
    const option = (await provider.getSettings()).find((s: any) => s.key === 'autoAnswerMode');
    assert.equal(option.value, AUTO_ANSWER_OFF); assert.equal(option.group, 'Experimental');
    assert.deepEqual(option.choices, [AUTO_ANSWER_OFF, AUTO_ANSWER_RINGING, AUTO_ANSWER_ALWAYS]);
    for (const [label, mode] of [[AUTO_ANSWER_RINGING, 'ringing'], [AUTO_ANSWER_ALWAYS, 'always'], [AUTO_ANSWER_OFF, 'off']]) {
        await provider.putSetting('autoAnswerMode', label);
        assert.equal(values.get('autoAnswerMode'), mode);
        assert.equal((await provider.getSettings()).find((s: any) => s.key === 'autoAnswerMode').value, label);
    }
    await assert.rejects(provider.putSetting('autoAnswerMode', '__proto__'), /Unknown/);
});

test('experimental streams separate foreground monitoring from passive and recorder requests, including offline display', async () => {
    const requests: boolean[] = [];
    const c = camera({ experimentalMode: () => true, listening: Promise.resolve(),
        controller: { online: false },
        getStatusVideo: () => ({ getStream: async (monitor: boolean) => { requests.push(monitor); return 'rtsp://127.0.0.1/status'; } }),
    });
    await c.getVideoStream({ destination: 'local' });
    await c.getVideoStream({ destination: 'remote' });
    await c.getVideoStream({ refresh: false });
    await c.getVideoStream({ destination: 'local-recorder' });
    await c.getVideoStream({ destination: 'remote-recorder' });
    await c.getVideoStream({ prebuffer: 5000 });
    await c.getVideoStream((await c.getVideoStreamOptions())[0]);
    assert.deepEqual(requests, [true, true, false, false, false, false, false]);
    c.experimentalMode = () => false;
    await assert.rejects(c.getVideoStream(), /not connected/);
    assert.equal(requests.length, 7);
});

test('HomeKit foreground acceptance starts before local video output or RTSP playback is ready', async () => {
    let answers = 0, streamReady = false, requestId = '';
    const listening = new Deferred<void>();
    const session: any = { cid: 'homekit-open', kind: 'monitor', closed: false, accepted: false,
        answer: async (allowed: () => boolean) => { if (allowed()) { answers++; session.accepted = true; } } };
    const c = camera({ experimentalMode: () => true, autoAnswerMode: () => 'always', listening: listening.promise,
        controller: { online: true, session, ensureVideo: async () => session },
        getStatusVideo: () => ({ getStream: async (_monitor: boolean, id: string) => { requestId = id; return 'rtsp://127.0.0.1/early'; } }),
    });
    const opening = c.getVideoStream({ destination: 'local', destinationType: '@scrypted/homekit' }).then(() => { streamReady = true; });
    await tick();
    assert.equal(answers, 1); assert.equal(streamReady, false, 'local output must not delay acceptance');
    assert.equal(c.audio, undefined, 'acceptance must not open a microphone');
    listening.resolve(); await opening;
    assert.match(requestId, /^[a-f0-9]{16}$/);
});

test('a failed video request cancels its pending early HomeKit acceptance', async () => {
    const listening = new Deferred<void>(), prepared = new Deferred<any>();
    let answers = 0;
    const session: any = { cid: 'failed-open', kind: 'monitor', closed: false, accepted: false,
        answer: async () => { answers++; } };
    const c = camera({ experimentalMode: () => true, autoAnswerMode: () => 'always', listening: listening.promise,
        controller: { online: true, session, ensureVideo: () => prepared.promise },
    });
    const opening = c.getVideoStream({ destination: 'local', destinationType: '@scrypted/homekit' });
    listening.reject(new Error('local output unavailable'));
    await assert.rejects(opening, /local output/);
    prepared.resolve(session); await tick();
    assert.equal(answers, 0);
});

test('reply switch acknowledges promptly, ignores duplicate presses, and resets on completion or failure', async () => {
    let calls = 0;
    const done = new Deferred<void>();
    const bell = { playReply: () => { calls++; return done.promise; }, stopReply: async () => done.resolve() };
    const button = new ReplySwitch(() => bell as unknown as InstanceType<typeof Doorbell>);
    await button.turnOn(); await button.turnOn();
    assert.equal(calls, 1); assert.equal(button.on, true);
    await button.turnOff(); await tick(); assert.equal(button.on, false);
    const broken = new ReplySwitch(() => ({ playReply: async () => { throw new Error('file unavailable'); } }) as any);
    await broken.turnOn(); await tick(); assert.equal(broken.on, false);
});

test('disabled or missing reply files fail before opening any doorbell session', async () => {
    let opened = 0;
    const c = camera({ _storage: { getItem: () => '/does-not-exist/aiphone-reply.wav' },
        controller: { ensureVideo: async () => { opened++; throw new Error('must not open'); } } });
    await assert.rejects(c.playReply(), /does not exist/);
    assert.equal(c.replyRunning, false); assert.equal(opened, 0);
    c.accessoryOptions = () => ({ reply: false, unlock: false });
    await assert.rejects(c.playReply(), /not enabled/); assert.equal(opened, 0);
});

test('an unreadable reply never interrupts an existing microphone', async () => {
    let changed = 0;
    const microphone = { kill: () => { changed++; } };
    const c = camera({ audioOwner: 'microphone', audio: microphone,
        _storage: { getItem: () => '/does-not-exist/aiphone-reply.wav' },
        audioSession: { close: async () => { changed++; }, uplink: { clear: () => { changed++; } } },
    });
    await assert.rejects(c.playReply(), /does not exist/);
    assert.equal(changed, 0); assert.equal(c.audio, microphone); assert.equal(c.audioOwner, 'microphone');
});

test('reply waits for microphone negotiation and cancellation does not steal it', async () => {
    const starting = new Deferred<{ done: Promise<void> }>();
    let starts = 0;
    const c = camera({ audioOwner: 'microphone', startingAudio: true, microphoneStart: starting.promise,
        startAudio: async () => { starts++; throw new Error('must not start a cancelled reply'); } });
    const preparing = c.playReply();
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(starts, 0);
    await c.stopReply();
    starting.resolve({ done: Promise.resolve() });
    await preparing;
    assert.equal(starts, 0); assert.equal(c.audioOwner, 'microphone');
});

test('cancelling preparation cannot start a late reply; reply cancellation leaves an active microphone alone', async () => {
    let starts = 0, stops = 0;
    const c = camera({ startAudio: async () => { starts++; throw new Error('must not start'); } });
    const preparing = c.playReply(); await c.stopReply(); await preparing;
    assert.equal(starts, 0);
    c.audioOwner = 'microphone'; c.audio = { kill: () => { stops++; } };
    c.audioSession = { close: async () => { stops++; } };
    await c.stopReply(); assert.equal(stops, 0); assert(c.audio);
});

test('bundled Japanese reply decodes fully and keeps the accepted call after completion', { timeout: 15000 }, async () => {
    assert(existsSync(bundledReplyPath()));
    const audible = new Deferred<void>();
    let frames = 0, closes = 0, opens = 0;
    const uplink = new AudioUplink();
    const push = uplink.push.bind(uplink);
    uplink.push = frame => { assert.equal(frame.length, 160); frames++; push(frame); audible.resolve(); };
    const session = Object.assign(new EventEmitter(), {
        closed: false, audioDiagnostics: {},
        uplink,
        answer: async () => { uplink.enabled = true; }, waitForReplyAudio: async () => {},
        close: async () => { if (!session.closed) { closes++; session.closed = true; session.emit('close'); uplink.close(); } },
    });
    const c = camera({ controller: { ensureVideo: async () => { opens++; return session; } } });
    try {
        const playing = c.playReply();
        await withTimeout(audible.promise, 4000, 'Reply audio did not reach uplink');
        await assert.rejects(c.startIntercom({}), /microphone or recording is already/);
        await c.stopIntercom(); assert.equal(session.closed, false, 'browser cleanup must not stop the reply');
        await playing;
        assert(frames > 300); assert.equal(opens, 1); assert.equal(closes, 0);
        assert.equal(session.closed, false);
        assert(uplink.framesSent >= frames - 1, `Reply lost audio frames: decoded=${frames}, sent=${uplink.framesSent}`);
        assert.equal(c.replyRunning, false); assert.equal(c.audio, undefined);
        assert.match(c.replyStatus, /call remains active/);
    } finally { await c.stopReply(); await session.close(); uplink.close(); }
});

test('reply decoder waits for both acceptance and audio readiness, and cancelling the wait sends no recording', async () => {
    const accepted = new Deferred<void>(), answering = new Deferred<void>();
    const audioReady = new Deferred<void>(), waiting = new Deferred<void>(), audible = new Deferred<void>();
    let frames = 0;
    const uplink = new AudioUplink();
    const push = uplink.push.bind(uplink);
    uplink.push = frame => { frames++; push(frame); audible.resolve(); };
    const session = Object.assign(new EventEmitter(), {
        closed: false, audioDiagnostics: {}, uplink,
        answer: async () => { answering.resolve(); await accepted.promise; uplink.enabled = true; },
        waitForReplyAudio: async (signal: AbortSignal) => {
            waiting.resolve();
            await new Promise<void>((resolve, reject) => {
                const cancelled = () => reject(new Error('Intercom was cancelled'));
                signal.addEventListener('abort', cancelled, { once: true });
                void audioReady.promise.then(resolve).finally(() => signal.removeEventListener('abort', cancelled));
            });
        },
    });
    const c = camera({ controller: { ensureVideo: async () => session } });
    try {
        const playing = c.playReply();
        await answering.promise; await new Promise(resolve => setTimeout(resolve, 80));
        assert.equal(c.audio, undefined); assert.equal(frames, 0);
        accepted.resolve(); await waiting.promise; await new Promise(resolve => setTimeout(resolve, 80));
        assert.equal(c.audio, undefined); assert.equal(frames, 0, 'answered alone must not start decoding');
        await c.stopReply(); await playing;
        audioReady.resolve(); await tick();
        assert.equal(c.audio, undefined); assert.equal(frames, 0, 'late readiness must not launch a cancelled reply');
        const second = c.playReply();
        await withTimeout(audible.promise, 3000, 'Ready call did not play the recording');
        await c.stopReply(); await second;
        assert(frames > 0); assert.equal(session.closed, false);
    } finally { await c.stopReply(); uplink.close(); }
});

test('reply takes over and restores the same microphone without hanging up, including reply cancellation', { timeout: 20000 }, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'aiphone-preemption-'));
    const path = join(directory, 'microphone.mulaw');
    const microphoneFrame = Buffer.alloc(160, 0x55);
    writeFileSync(path, Buffer.alloc(8000 * 15, 0x55));
    const microphoneReady = new Deferred<void>(), microphoneResumed = new Deferred<void>();
    let replyReady = new Deferred<void>();
    let handover = false, staleFrames = 0, replyFrames = 0, sentBeforeReply = 0;
    let opens = 0, accepts = 0, closes = 0;
    const uplink = new AudioUplink();
    const push = uplink.push.bind(uplink), clear = uplink.clear.bind(uplink);
    uplink.clear = () => {
        if (!handover) { handover = true; sentBeforeReply = uplink.framesSent; }
        clear();
    };
    uplink.push = frame => {
        if (!handover) microphoneReady.resolve();
        else if (c.audioOwner === 'microphone') microphoneResumed.resolve();
        else if (frame.equals(microphoneFrame)) staleFrames++;
        else { replyFrames++; replyReady.resolve(); }
        push(frame);
    };
    const session = Object.assign(new EventEmitter(), {
        closed: false, accepted: false, talkAudioReady: true, audioDiagnostics: {}, uplink,
        answer: async () => { if (!session.accepted) { accepts++; session.accepted = true; } uplink.enabled = true; },
        waitForReplyAudio: async () => {},
        close: async () => { if (!session.closed) { closes++; session.closed = true; session.emit('close'); uplink.close(); } },
    });
    const c = camera({ controller: { online: true, session, ensureVideo: async () => { opens++; return session; } } });
    try {
        await c.startIntercom({ inputArguments: ['-f', 'mulaw', '-ar', '8000', '-ac', '1', '-i', path] });
        await withTimeout(microphoneReady.promise, 4000, 'Microphone did not start');
        await new Promise(resolve => setTimeout(resolve, 80));
        assert.equal((await c.getSettings()).find((s: any) => s.key === 'call').value, 'In call');
        const oldMicrophone = c.audio;
        const replying = c.playReply();
        await withTimeout(replyReady.promise, 4000, 'Reply did not take over the microphone');
        assert.equal(c.audioSession, session); assert.equal(session.closed, false);
        assert.equal(oldMicrophone.killed, false, 'keep the original input connected during handover');
        oldMicrophone.stdout.emit('data', microphoneFrame);
        assert.equal(c.audioOwner, 'reply'); assert.equal(session.closed, false);
        await assert.rejects(c.playReply(), /recording is already/);
        await replying;
        assert.equal(staleFrames, 0); assert(replyFrames > 300);
        assert(uplink.framesSent - sentBeforeReply >= replyFrames - 1, 'reply must drain before restoring the microphone');
        assert.equal(opens, 1); assert.equal(accepts, 1); assert.equal(closes, 0);
        assert.equal(c.audio, oldMicrophone); assert.equal(c.audioOwner, 'microphone');
        assert.equal(oldMicrophone.killed, false);
        await withTimeout(microphoneResumed.promise, 1500, 'Microphone did not resume after the recording');
        await new Promise(resolve => setTimeout(resolve, 80));
        assert.equal((await c.getSettings()).find((s: any) => s.key === 'call').value, 'In call');
        replyReady = new Deferred<void>();
        const cancelledReply = c.playReply();
        await withTimeout(replyReady.promise, 3000, 'Second reply did not take over');
        await c.stopReply(); await cancelledReply;
        assert.equal(session.closed, false); assert.equal(c.audio, oldMicrophone);
        assert.equal(c.audioOwner, 'microphone'); assert.equal(closes, 0);
        await c.stopIntercom();
        assert.equal(closes, 1); assert.equal(oldMicrophone.killed, true, 'explicitly stopping the microphone still ends its call');
    } finally { await c.stopReply(); await c.stopIntercom(); await session.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('disabling the paused microphone does not stop a reply or restore the unwanted input', async () => {
    let microphoneStops = 0, replyStops = 0;
    const c = camera({
        pausedMicrophone: { child: { kill: () => { microphoneStops++; } }, completion: new Deferred<void>() },
        audioOwner: 'reply', audio: { kill: () => { replyStops++; } },
        audioSession: { close: async () => { replyStops++; } },
    });
    await c.stopIntercom();
    assert.equal(microphoneStops, 1); assert.equal(replyStops, 0);
    assert.equal(c.pausedMicrophone, undefined); assert.equal(c.audioOwner, 'reply');
});

test('a remote hangup is not reported as a retained call after a reply', async () => {
    const session = { closed: true };
    const c = camera();
    c.startAudio = async () => { c.replySession = session; return { done: Promise.resolve() }; };
    await c.playReply();
    assert.match(c.replyStatus, /Call ended/);
    assert(!c.replyStatus.includes('call remains active'));
});
