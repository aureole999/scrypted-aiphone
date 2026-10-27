import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AiphoneController } from '../src/controller';
import { AiphoneSession } from '../src/media';
import { Credentials, Deferred, Signal } from '../src/protocol';
const credentials: Credentials = { cliid: 'CLIENT', unit_mac: 'AA', iot_host: 'example.com', sndtpc: 'AA/send/unit', rcvtpc: 'AA/recv/client', cert_pem: '', seckey_pem: '', termname: 'Scrypted' };
function controller() {
    const c = new AiphoneController(credentials, () => {});
    c.online = true;
    const sent: { mid: string; cid: string; fields?: Record<string, any> }[] = [];
    c.send = (mid, cid, _body, fields) => { sent.push({ mid, cid, fields }); };
    return { c, sent };
}
test('requests reject wrong CID and other terminals relay responses', async () => {
    const { c } = controller();
    const pending = c.request('30011', '31011', 'call1', {}, {}, 1000);
    c.receive({ HEADER: { MID: '31011', CID: 'call2', CLIID: 'CLIENT' } });
    c.receive({ HEADER: { MID: '31011', CID: 'call1', CLIID: 'OTHER' } });
    const reply: Signal = { HEADER: { MID: '31011', CID: 'call1', CLIID: 'CLIENT', RSLT: 0 }, BODY: { SDP: 'valid' } };
    c.receive(reply);
    assert.deepEqual(await pending, reply);
    await c.close();
});
test('negative cloud acknowledgement does not enable talk', async () => {
    const { c } = controller();
    const pending = c.request('23022', '24022', 'call1', {}, {}, 1000);
    c.receive({ HEADER: { MID: '24022', CID: 'call1', RSLT: 486 } });
    await assert.rejects(pending, /rejected 23022/);
    await c.close();
});
test('ring duplicate is suppressed and own cancel keeps accepted call alive', async () => {
    const originalStart = AiphoneSession.prototype.start;
    const originalClose = AiphoneSession.prototype.close;
    AiphoneSession.prototype.start = async function () { this.ready.resolve(); };
    AiphoneSession.prototype.close = async function () { this.closed = true; this.signaling.ended(this); };
    const { c, sent } = controller();
    try {
        let rings = 0; c.on('ring', () => rings++);
        const ring = { HEADER: { MID: '23001', CID: 'ring1', CLIID: 'UNIT', DSP1: 'Entrance', CKIND: 1 } };
        c.receive(ring); c.receive(ring);
        const session = await c.ensureVideo();
        assert.equal(rings, 1); assert.equal(c.state, 'ringing'); assert.equal(session.kind, 'ring');
        assert.equal(c.ringingCallId, 'ring1');
        assert.equal(await c.ringingSession('ring1'), session);
        assert.equal(await c.ringingSession('different-call'), undefined);
        assert.equal(sent.filter(s => s.mid === '24000').length, 1);
        session.answerRequested = true;
        c.receive({ HEADER: { MID: '23004', CID: 'ring1', CLIID: 'UNIT', NCID: 'CLIENT' } });
        assert.equal(session.closed, false);
        assert.equal(sent.some(s => s.mid === '24004'), false);
        c.receive({ HEADER: { MID: '24002', CID: 'ring1', CLIID: 'OTHER', RSLT: 200 } });
        assert.equal(session.closed, true);
        assert.equal(c.state, 'idle');
        assert.equal(c.ringingCallId, undefined);
        assert.equal(await c.ringingSession('ring1'), undefined, 'ended ringing must not fall back to a new Monitor');
    } finally { await c.close(); AiphoneSession.prototype.start = originalStart; AiphoneSession.prototype.close = originalClose; }
});
test('simultaneous viewers share one monitor startup', async () => {
    const originalStart = AiphoneSession.prototype.start;
    const originalClose = AiphoneSession.prototype.close;
    let starts = 0;
    const ready = new Deferred<void>();
    AiphoneSession.prototype.start = async function () { starts++; await ready.promise; this.ready.resolve(); };
    AiphoneSession.prototype.close = async function () { this.closed = true; this.signaling.ended(this); };
    const { c } = controller();
    try {
        const one = c.ensureVideo(), two = c.ensureVideo();
        ready.resolve();
        const [a, b] = await Promise.all([one, two]);
        assert.equal(a, b); assert.equal(starts, 1);
    } finally { await c.close(); AiphoneSession.prototype.start = originalStart; AiphoneSession.prototype.close = originalClose; }
});
test('incoming ring interrupts an unfinished monitor before starting ring media', async () => {
    const originalStart = AiphoneSession.prototype.start;
    const originalClose = AiphoneSession.prototype.close;
    const blocked = new Deferred<void>();
    const { c } = controller();
    AiphoneSession.prototype.start = async function () {
        if (this.kind === 'monitor') { await blocked.promise; if (this.closed) throw new Error('interrupted'); }
        this.ready.resolve();
    };
    AiphoneSession.prototype.close = async function () {
        this.closed = true; blocked.resolve(); this.signaling.ended(this);
    };
    try {
        const monitoring = c.ensureVideo();
        c.receive({ HEADER: { MID: '23001', CID: 'ring2', CLIID: 'UNIT' } });
        await assert.rejects(monitoring, /interrupted/);
        const ringing = await c.ensureVideo();
        assert.equal(ringing.kind, 'ring'); assert.equal(ringing.cid, 'ring2'); assert.equal(c.state, 'ringing');
    } finally { await c.close(); AiphoneSession.prototype.start = originalStart; AiphoneSession.prototype.close = originalClose; }
});
test('remote hangup during a ring transition cancels pending incoming media', async () => {
    const originalStart = AiphoneSession.prototype.start;
    const originalClose = AiphoneSession.prototype.close;
    let starts = 0;
    AiphoneSession.prototype.start = async function () { starts++; this.ready.resolve(); };
    AiphoneSession.prototype.close = async function () { this.closed = true; this.signaling.ended(this); };
    const { c, sent } = controller();
    try {
        c.receive({ HEADER: { MID: '23001', CID: 'ring3', CLIID: 'UNIT' } });
        c.receive({ HEADER: { MID: '23003', CID: 'ring3', CLIID: 'UNIT' } });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(starts, 0); assert.equal(c.state, 'idle');
        assert(sent.some(s => s.mid === '24003'));
    } finally { await c.close(); AiphoneSession.prototype.start = originalStart; AiphoneSession.prototype.close = originalClose; }
});

test('another terminal answering before incoming media exists clears ringing and prevents late video', async () => {
    const originalStart = AiphoneSession.prototype.start;
    let starts = 0;
    AiphoneSession.prototype.start = async function () { starts++; this.ready.resolve(); };
    const { c } = controller();
    try {
        c.receive({ HEADER: { MID: '23001', CID: 'early-answer', CLIID: 'UNIT' } });
        assert.equal(c.state, 'ringing');
        c.receive({ HEADER: { MID: '24002', CID: 'wrong-call', CLIID: 'OTHER', RSLT: 200 } });
        c.receive({ HEADER: { MID: '24002', CID: 'early-answer', CLIID: 'OTHER', RSLT: 486 } });
        c.receive({ HEADER: { MID: '24002', CID: 'early-answer', CLIID: 'CLIENT', RSLT: 200 } });
        assert.equal(c.state, 'ringing', 'wrong calls, rejected answers and own messages must not clear ringing');
        c.receive({ HEADER: { MID: '24002', CID: 'early-answer', CLIID: 'OTHER', RSLT: 200 } });
        assert.equal(c.state, 'idle'); assert.equal(c.ringingCallId, undefined);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(starts, 0); assert.equal(c.session, undefined);
    } finally { await c.close(); AiphoneSession.prototype.start = originalStart; }
});

test('cloud ring state lasts until acceptance, timeout, cancellation or disconnection', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const originalStart = AiphoneSession.prototype.start;
    const originalClose = AiphoneSession.prototype.close;
    AiphoneSession.prototype.start = async function () { this.ready.resolve(); };
    AiphoneSession.prototype.close = async function () { this.closed = true; this.signaling.ended(this); };
    const { c } = controller();
    const ring = (id: string) => c.receive({ HEADER: { MID: '23001', CID: id, CLIID: 'UNIT' } });
    try {
        ring('answered'); const session = await c.ensureVideo();
        t.mock.timers.tick(10000); assert.equal(c.state, 'ringing');
        c.answered(session); assert.equal(c.state, 'answered');
        await session.close(); assert.equal(c.state, 'idle');
        ring('timeout'); await c.ensureVideo();
        t.mock.timers.tick(44999); assert.equal(c.state, 'ringing');
        t.mock.timers.tick(1); assert.equal(c.state, 'idle'); assert.equal(c.ringingCallId, undefined);
        ring('cancelled'); await c.ensureVideo();
        c.receive({ HEADER: { MID: '23004', CID: 'cancelled', CLIID: 'UNIT' } });
        assert.equal(c.state, 'idle');
        ring('disconnected'); await c.ensureVideo();
        (c as any).disconnected();
        assert.equal(c.state, 'idle'); assert.equal(c.online, false); assert.equal(c.ringingCallId, undefined);
    } finally { await c.close(); AiphoneSession.prototype.start = originalStart; AiphoneSession.prototype.close = originalClose; }
});

test('cloud end and other-terminal answer clear ringing before slow media cleanup completes', async () => {
    for (const mid of ['23003', '23004', '24002']) {
        const { c } = controller();
        const released = new Deferred<void>();
        const session = { cid: 'slow-cleanup', closed: false, callKind: 1,
            isOwnCancel: () => false, close() { this.closed = true; return released.promise; } };
        c.state = 'ringing'; (c as any).ringId = session.cid; c.session = session as any;
        try {
            c.receive({ HEADER: { MID: mid, CID: session.cid, CLIID: 'OTHER', RSLT: 200 } });
            assert.equal(c.state, 'idle', `${mid} must clear ringing without waiting for RTCP/DTLS cleanup`);
            assert.equal(c.ringingCallId, undefined); assert.equal(session.closed, true);
        } finally { released.resolve(); await c.close(); }
    }
});
