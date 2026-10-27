import assert from 'node:assert/strict';
import { test } from 'node:test';
import dgram from 'node:dgram';
import { once } from 'node:events';
import { discover, discoveryTargets, subnetBroadcast } from '../src/pairing';

test('discovery computes each subnet broadcast without assuming /24', () => {
    assert.equal(subnetBroadcast('10.0.1.16', '255.255.255.0'), '10.0.1.255');
    assert.equal(subnetBroadcast('10.0.1.16', '255.255.254.0'), '10.0.1.255');
    assert.equal(subnetBroadcast('10.12.3.4', '255.255.0.0'), '10.12.255.255');
    assert.equal(subnetBroadcast('10.12.3.4', '255.255.255.255'), undefined);
    assert.deepEqual(discoveryTargets({ termname: 'test', address: '10.0.1.214' }), ['10.0.1.214']);
    assert.throws(() => discoveryTargets({ termname: 'test', address: 'http://invalid' }), /IPv4/);
});
for (const replyToSource of [false, true]) {
    test(`discovery accepts ${replyToSource ? 'source-port' : 'fixed-port'} replies using the HA datagram`, async () => {
        const server = dgram.createSocket('udp4');
        const listening = once(server, 'listening'); server.bind(51711, '127.0.0.1'); await listening;
        server.on('message', (request, remote) => {
            assert.equal(request.toString(), '{"HEADER": {"MID": "01001", "VER": "1.0"}}\n');
            server.send(Buffer.from(JSON.stringify({ HEADER: { MID: '11001', RSLT: 0 }, BODY: { PORT: '52712' } })),
                replyToSource ? remote.port : 51712, remote.address);
        });
        try {
            assert.deepEqual(await discover({ termname: 'test', address: '127.0.0.1', bindAddress: '127.0.0.1' }),
                { host: '127.0.0.1', port: 52712 });
        } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
    });
}
test('a device rejection is distinguished from a missing UDP response', async () => {
    const server = dgram.createSocket('udp4');
    const listening = once(server, 'listening'); server.bind(51711, '127.0.0.1'); await listening;
    server.on('message', (_request, remote) => server.send(Buffer.from(JSON.stringify({ HEADER: { MID: '11001', RSLT: 2, PORT: 52712 } })), remote.port, remote.address));
    try {
        await assert.rejects(discover({ termname: 'test', address: '127.0.0.1', timeoutMs: 50 }), /rejected discovery.*RSLT=2/);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
