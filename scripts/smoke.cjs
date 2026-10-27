// Load the production bundle in a minimal Scrypted host. No MQTT or hardware access.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const path = require('node:path');
const projectRequire = createRequire(path.resolve('package.json'));
const stored = new Map();
let manifest;
const context = {
    exports: {}, Buffer, process, setTimeout, clearTimeout, setInterval, clearInterval,
    __dirname: path.resolve('dist'),
    console,
    require(name) {
        if (name === 'fs') return new Proxy(fs, { get(target, prop) {
            if (prop === 'readFileSync') return (filename, ...args) => filename === '../sdk.json' ? Buffer.from('{}') : fs.readFileSync(filename, ...args);
            return target[prop];
        }});
        return projectRequire(name);
    },
    deviceManager: {
        getDeviceLogger: () => console,
        getDeviceConsole: () => console,
        getDeviceStorage: () => ({ getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key) }),
        onDevicesChanged: async value => { manifest = value; },
        onDeviceEvent: async () => {},
    },
    endpointManager: {}, mediaManager: {}, pluginHostAPI: {},
    systemManager: { setScryptedInterfaceDescriptors: async () => {} },
};
vm.runInNewContext(fs.readFileSync('dist/main.nodejs.js', 'utf8'), context, { filename: 'main.nodejs.js' });
(async () => {
    assert.equal(typeof context.exports.default, 'function');
    const plugin = new context.exports.default();
    await plugin.putSetting('termname', 'Scrypted Test');
    assert.equal(stored.get('termname'), 'Scrypted Test');
    assert.equal(manifest.devices.length, 0, 'unpaired plugin must not create a network camera');
    const settings = await plugin.getSettings();
    assert(settings.some(setting => setting.key === 'pair' && setting.type === 'button'));
    assert(!settings.some(setting => setting.key === 'importCredentials'));
    await assert.rejects(plugin.putSetting('importCredentials', '{}'), /Unknown setting/);
    assert(settings.some(setting => setting.key === 'enableUnlock' && setting.value === false));
    assert(settings.some(setting => setting.key === 'enableReply' && setting.value === false));
    assert(settings.some(setting => setting.key === 'enableRingSensor' && setting.value === false && setting.group === 'Accessories'));
    assert(settings.some(setting => setting.key === 'videoMode' && setting.value === 'Direct' && setting.group === 'Experimental'));
    assert(settings.some(setting => setting.key === 'autoAnswerMode' && setting.value === 'Off'
        && setting.group === 'Experimental' && setting.choices.length === 3));
    assert(settings.every(setting => setting.group), 'plugin configuration must use named groups');
    assert(!settings.some(setting => ['network', 'discoveryLog', 'probe'].includes(setting.key)));
    const zip = new (projectRequire('adm-zip'))('dist/plugin.zip');
    const audio = zip.readFile('fs/replies/jp_delivery.wav');
    assert(audio && audio.subarray(0, 4).toString() === 'RIFF' && audio.length > 100000, 'reply WAV must ship inside the plugin');
    const font = JSON.parse(zip.readAsText('fs/osd/glyphs.json'));
    for (let char = 32; char < 127; char++)
        assert(font.glyphs[String.fromCharCode(char)], `Missing OSD glyph: ${String.fromCharCode(char)}`);
    assert(zip.readAsText('fs/osd/OFL.txt').includes('OPEN FONT LICENSE'));
    assert(zip.readAsText('fs/third-party-licenses.txt').includes('werift@'));
    assert(zip.readAsText('THIRD_PARTY_NOTICES.md').includes('Third-party notices'));
    const camera = Object.assign(Object.create(context.exports.Doorbell.prototype), {
        accessoryOptions: () => ({ unlock: false, reply: true }), snapshotCache: {},
        controller: { state: 'idle', online: false }, _storage: { getItem: () => '' },
    });
    const cameraSettings = await camera.getSettings();
    assert.equal(cameraSettings.length, 2);
    assert(cameraSettings.every(setting => setting.group === 'Status' && setting.readonly));
    assert(cameraSettings.some(setting => setting.key === 'call' && setting.value === 'Offline'));
    console.log('Production bundle smoke test passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
