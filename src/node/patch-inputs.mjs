import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
/** Read bounds prepared for exactly the selected patch. */
export function readPreparedWorldData({ patch, assetDirectory = path.join(packageRoot, 'assets') } = {}) {
    if (!patch || !/^[a-z0-9]+(?:_[a-z0-9]+)*$/iu.test(patch)) throw new TypeError('A valid patch ID is required.');
    const filename = path.join(assetDirectory, 'data', patch, 'worlddata.json');
    if (fs.existsSync(filename)) return JSON.parse(fs.readFileSync(filename, 'utf8'));
    throw new Error(`Map patch ${patch} is missing its prepared worlddata.json. Add bounds for this patch before generating map layers.`);
}
