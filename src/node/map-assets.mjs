import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const assetRoot = path.join(packageRoot, 'assets');
const safePath = value => typeof value === 'string' && value.length > 0
    && !path.isAbsolute(value) && !value.split(/[\\/]+/u).includes('..');

export function resolveAssetPath(relativePath) {
    if (!safePath(relativePath)) throw new TypeError('Map asset paths must stay inside the package.');
    return path.join(assetRoot, relativePath);
}

export function readMapData(patch, name = 'mapdata.json') {
    if (typeof patch !== 'string' || !/^[a-z0-9]+$/iu.test(patch) || !safePath(name)) {
        throw new TypeError('A patch ID and package-relative map data path are required.');
    }
    return JSON.parse(fs.readFileSync(resolveAssetPath(path.join('data', patch, name)), 'utf8'));
}

export function readMapManifest() {
    return JSON.parse(fs.readFileSync(path.join(packageRoot, 'manifest.json'), 'utf8'));
}
