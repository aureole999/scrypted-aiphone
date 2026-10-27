import { access, stat } from 'fs/promises';
import { constants, existsSync } from 'fs';
import { resolve } from 'path';

export interface AccessoryOptions { unlock: boolean; reply: boolean; }

/** Packaged under fs/ by the official Scrypted SDK. Also supports source checkouts. */
export function bundledReplyPath() {
    const candidates = [resolve(__dirname, 'fs/replies/jp_delivery.wav'), resolve(__dirname, '../fs/replies/jp_delivery.wav')];
    const path = candidates.find(path => existsSync(path));
    if (!path) throw new Error('Bundled reply audio is missing. Reinstall the plugin or specify a custom recording.');
    return path;
}

export async function readableReplyFile(customPath: string) {
    const path = customPath || bundledReplyPath();
    if (!path.startsWith('/')) throw new Error('Reply audio must use an absolute path on the Scrypted host');
    try {
        if (!(await stat(path)).isFile()) throw new Error('Not a file');
        await access(path, constants.R_OK);
    } catch { throw new Error('Reply audio file does not exist or cannot be read. Check the path on the Scrypted host.'); }
    return path;
}
