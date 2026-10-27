import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { TLSSocket } from 'node:tls';
import { credentialsFromJSON, janusOffer, packet, requireSuccess, stripExtraFingerprints, withTimeout } from '../src/protocol';
import { PairingConnection } from '../src/pairing';
import { extractTracks } from '../src/media';
import { rtspSdp } from '../src/rtsp';

export const credentials = { cliid: 'CLIENT', unit_mac: 'AA', iot_host: 'example.iot.amazonaws.com', sndtpc: 'AA/send/unit', rcvtpc: 'AA/recv/client', cert_pem: '-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----', seckey_pem: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----', termname: 'Scrypted' };
const sdp = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 0\r\na=rtpmap:0 PCMU/8000\r\nm=video 9 UDP/TLS/RTP/SAVPF 102\r\na=rtpmap:102 H264/90000\r\na=fmtp:102 profile-level-id=42e01f;packetization-mode=1\r\na=setup:actpass\r\na=ice-pwd:secret\r\n';

test('credentials support raw and HA data envelopes without mixing devices', () => {
    assert.deepEqual(credentialsFromJSON(JSON.stringify({ data: credentials })), credentials);
    assert.deepEqual(credentialsFromJSON(credentials), credentials);
    assert.throws(() => credentialsFromJSON({ ...credentials, rcvtpc: 'BB/recv/client' }), /topics/);
    assert.throws(() => credentialsFromJSON({ ...credentials, cert_pem: '' }), /cert_pem/);
    assert.throws(() => credentialsFromJSON({ ...credentials, iot_host: 'https://example.com' }), /hostname/);
});
test('Janus uses active DTLS; SHA-256 is the sole advertised fingerprint', () => {
    assert.match(janusOffer(sdp), /a=setup:active/);
    assert.equal(stripExtraFingerprints('a=fingerprint:sha-256 ABC\r\na=fingerprint:sha-384 DEF\r\n'), 'a=fingerprint:sha-256 ABC\r\n');
});
test('RTSP contains only accepted RTP codecs and no cloud ICE credentials', () => {
    const tracks = extractTracks(sdp);
    assert.equal(tracks[0].payloadType, 0);
    assert.equal(tracks[1].payloadType, 102);
    const local = rtspSdp(tracks);
    assert.match(local, /m=video 0 RTP\/AVP 102/);
    assert.match(local, /a=fmtp:102/);
    assert.doesNotMatch(local, /ice-pwd|setup:|fingerprint/);
    assert.throws(() => extractTracks('m=video 9 RTP/AVP 96\r\na=rtpmap:96 VP8/90000\r\n'), /H.264/);
});
test('pairing validates MID and explicit success', () => {
    requireSuccess({ MID: '11003', RSLT: 0 }, '11003');
    assert.throws(() => requireSuccess({ MID: '11005', RSLT: 0 }, '11003'), /Unexpected/);
    assert.throws(() => requireSuccess({ MID: '11003' }, '11003'), /rejected/);
    assert.deepEqual(JSON.parse(packet('01003', { OTPASS: '1234' })), { HEADER: { MID: '01003', VER: '1.0' }, BODY: { OTPASS: '1234' } });
});
test('pairing reassembles split responses and retains coalesced messages', async () => {
    const socket = new EventEmitter() as any;
    socket.write = () => {};
    socket.destroy = (err: Error) => { throw err; };
    const connection = new PairingConnection(socket as TLSSocket);
    const first = connection.request('01002', '11002', {});
    socket.emit('data', Buffer.from('{"HEADER":{"MID":"11002","RSLT":0},"BODY":{"OT'));
    socket.emit('data', Buffer.from('PASS":"abcd1234"}}\n{"HEADER":{"MID":"11003","RSLT":0}}\n'));
    assert.equal((await first).OTPASS, 'abcd1234');
    assert.equal((await connection.request('01003', '11003', {})).RSLT, 0);
});
test('pairing accepts complete JSON without newline and propagates socket closure', async () => {
    const socket = new EventEmitter() as any;
    socket.write = () => {}; socket.destroy = () => {};
    const connection = new PairingConnection(socket);
    const first = connection.request('01003', '11003', {});
    socket.emit('data', Buffer.from('{"HEADER":{"MID":"11003","RSLT":0}}'));
    await first;
    const second = connection.request('01005', '11005', {});
    socket.emit('close');
    await assert.rejects(second, /closed/);
});
test('timeouts fail with an actionable message', async () => {
    await assert.rejects(withTimeout(new Promise(() => {}), 5, 'test timeout'), /test timeout/);
});
