import assert from 'node:assert/strict';
import { test } from 'node:test';
import { autoAnswerOnView, AutoAnswerHost, AutoAnswerMode, EarlyViewIntent, isEarlyHomeKitStream, isForegroundStream } from '../src/auto-answer';
import { Deferred } from '../src/protocol';

function fixture(mode: AutoAnswerMode, kind: 'ring' | 'monitor') {
    let answers = 0, monitors = 0, ringLookups = 0;
    const session: any = { cid: 'call1', kind, closed: false, accepted: false,
        answer: async (allowed: () => boolean) => { if (allowed()) { answers++; session.accepted = true; } } };
    const state: any = { mode, online: true, ring: kind === 'ring' ? 'call1' : undefined, session, active: true };
    const host: AutoAnswerHost = {
        mode: () => state.mode, online: () => state.online, ringingId: () => state.ring, current: () => state.session,
        monitor: async () => { monitors++; return session; },
        ringingSession: async cid => { ringLookups++; assert.equal(cid, 'call1'); return session; }, log() {},
    };
    return { host, state, session, counts: () => ({ answers, monitors, ringLookups }), active: () => state.active };
}

test('foreground auto-answer policies: off, ringing-only and Always', async () => {
    for (const mode of ['off', 'ringing', 'always'] as const) {
        for (const kind of ['ring', 'monitor'] as const) {
            const f = fixture(mode, kind);
            await autoAnswerOnView(f.host, f.active);
            const enabled = mode === 'always' || mode === 'ringing' && kind === 'ring';
            assert.equal(f.counts().answers, enabled ? 1 : 0, `${mode}/${kind}`);
            assert.equal(f.counts().monitors, mode === 'always' ? 1 : 0);
            assert.equal(f.counts().ringLookups, mode === 'ringing' && kind === 'ring' ? 1 : 0);
        }
    }
});

test('direct video reuses its already-open target, and viewing a connected call does not answer twice', async () => {
    const f = fixture('always', 'monitor');
    await autoAnswerOnView(f.host, f.active, f.session);
    await autoAnswerOnView(f.host, f.active, f.session);
    assert.deepEqual(f.counts(), { answers: 1, monitors: 0, ringLookups: 0 });
});

test('cancelled viewers, changed settings, offline or replaced calls cannot answer after slow setup', async () => {
    for (const change of ['closed-view', 'disabled', 'ringing-only', 'offline', 'closed-call', 'replaced-call'] as const) {
        const f = fixture('always', 'monitor');
        const pending = new Deferred<any>();
        f.host.monitor = () => pending.promise;
        const opening = autoAnswerOnView(f.host, f.active);
        if (change === 'closed-view') f.state.active = false;
        if (change === 'disabled') f.state.mode = 'off';
        if (change === 'ringing-only') f.state.mode = 'ringing';
        if (change === 'offline') f.state.online = false;
        if (change === 'closed-call') f.session.closed = true;
        if (change === 'replaced-call') f.state.session = { cid: 'new-call' };
        pending.resolve(f.session); await opening;
        assert.equal(f.counts().answers, 0, change);
    }
    const f = fixture('ringing', 'ring');
    const pending = new Deferred<any>();
    f.host.ringingSession = () => pending.promise;
    const opening = autoAnswerOnView(f.host, f.active);
    f.state.ring = 'another-ring'; pending.resolve(f.session); await opening;
    assert.equal(f.counts().answers, 0, 'a newer doorbell ring must not inherit the old viewer intent');
});

test('background metadata, prebuffer, recorders and passive snapshots are never foreground intent', () => {
    assert.equal(isForegroundStream(), true);
    assert.equal(isForegroundStream({ destination: 'local', destinationType: '@scrypted/homekit' }), true);
    assert.equal(isForegroundStream({ destination: 'remote' }), true);
    for (const options of [{ refresh: false }, { prebuffer: 5000 }, { destination: 'local-recorder' },
        { destination: 'remote-recorder' }, { source: 'synthetic' }, { source: 'cloud' }])
        assert.equal(isForegroundStream(options as any), false);
});

test('only explicit HomeKit foreground streaming requests are eligible for early acceptance', () => {
    assert(isEarlyHomeKitStream({ destinationType: '@scrypted/homekit', destination: 'local' }));
    assert(isEarlyHomeKitStream({ destinationType: '@scrypted/homekit', destination: 'remote' }));
    assert.equal(isEarlyHomeKitStream(), false);
    assert.equal(isEarlyHomeKitStream({ destination: 'local' }), false);
    assert.equal(isEarlyHomeKitStream({ destinationType: '@scrypted/homekit', refresh: false }), false);
    assert.equal(isEarlyHomeKitStream({ destinationType: '@scrypted/homekit', destination: 'local-recorder' }), false);
    assert.equal(isEarlyHomeKitStream({ destinationType: '@scrypted/homekit', prebuffer: 5000 }), false);
});

test('early foreground intent is bounded until an RTSP reader supplies its lifetime', () => {
    let now = 0, connected = true;
    const intent = new EarlyViewIntent(() => now);
    assert(intent.active()); now = 30001; assert.equal(intent.active(), false);
    intent.bind(() => connected); assert(intent.active());
    connected = false; assert.equal(intent.active(), false);
    connected = true; intent.cancel(); assert.equal(intent.active(), false);
});
