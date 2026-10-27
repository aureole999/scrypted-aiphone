// Preserve notices for the packages actually included by the Scrypted bundler.
const fs = require('node:fs');
const path = require('node:path');
const AdmZip = require('adm-zip');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist');
const map = JSON.parse(fs.readFileSync(path.join(output, 'main.nodejs.js.map'), 'utf8'));
const packages = new Map();
for (const source of map.sources) {
    let directory = path.dirname(path.resolve(output, source));
    while (directory !== path.dirname(directory)) {
        const manifest = path.join(directory, 'package.json');
        if (fs.existsSync(manifest)) {
            const metadata = JSON.parse(fs.readFileSync(manifest, 'utf8'));
            if (metadata.name) {
                if (directory !== root) packages.set(`${metadata.name}@${metadata.version}`, { directory, metadata });
                break;
            }
        }
        directory = path.dirname(directory);
    }
}
const fallback = new Map([
    ['@scrypted/sdk', 'scrypted-sdk-ISC.txt'],
    ['werift', 'werift-LICENSE.txt'],
]);
const notices = [];
for (const [name, { directory, metadata }] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
    let licenses = fs.readdirSync(directory, { withFileTypes: true })
        .filter(entry => entry.isFile() && /^(licen[cs]e|copying|notice)/i.test(entry.name))
        .map(entry => path.join(directory, entry.name)).sort();
    if (!licenses.length && fallback.has(metadata.name)) licenses = [path.join(root, 'licenses', fallback.get(metadata.name))];
    if (!licenses.length) throw new Error(`Missing license notice for bundled dependency ${name}`);
    notices.push(`${name}\nLicense: ${metadata.license || 'See notice below'}\n\n`
        + licenses.map(file => fs.readFileSync(file, 'utf8').trim()).join('\n\n'));
}
const contents = Buffer.from('Bundled JavaScript dependency notices\n\n' + notices.join('\n\n' + '='.repeat(72) + '\n\n') + '\n');
fs.writeFileSync(path.join(output, 'THIRD_PARTY_LICENSES.txt'), contents);
const zip = new AdmZip(path.join(output, 'plugin.zip'));
zip.addFile('fs/third-party-licenses.txt', contents);
zip.addLocalFile(path.join(root, 'THIRD_PARTY_NOTICES.md'));
zip.writeZip(path.join(output, 'plugin.zip'));
console.log(`Preserved license notices for ${packages.size} bundled packages.`);
