import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sharedLegacyBoundsPatches = new Set(['688', '700', '706', '707', '709', '715', '719', '720', '721', '722', '723']);

/** Read selected-patch map bounds; only shipped historical patches share the legacy calibration. */
export function readPreparedWorldData({ patch, assetDirectory = path.join(packageRoot, 'assets') } = {}) {
    if (!patch || !/^[a-z0-9]+$/iu.test(patch)) throw new TypeError('A valid patch ID is required.');
    const patchDirectory = path.join(assetDirectory, 'data', patch);
    for (const name of ['worlddata.json', 'legacy-worlddata.json']) {
        const filename = path.join(patchDirectory, name);
        if (fs.existsSync(filename)) return JSON.parse(fs.readFileSync(filename, 'utf8'));
    }
    if (sharedLegacyBoundsPatches.has(patch)) {
        const legacyPath = path.join(assetDirectory, 'data/legacy/worlddata.json');
        if (fs.existsSync(legacyPath)) return JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
    }
    throw new Error(`Map patch ${patch} is missing its prepared worlddata.json. Add bounds for this patch before generating map layers.`);
}
