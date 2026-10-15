import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = path.join(root, 'assets');
const hashFile = file => {
    const bytes = fs.readFileSync(file);
    return { path: path.relative(assets, file).replaceAll('\\', '/'), bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex') };
};
const filesIn = directory => fs.readdirSync(directory, { withFileTypes: true })
    .flatMap(entry => {
        const file = path.join(directory, entry.name);
        return entry.isDirectory() ? filesIn(file) : entry.isFile() ? [file] : [];
    })
    .sort((first, second) => first.localeCompare(second));

const dataRoot = path.join(assets, 'data');
const patches = fs.readdirSync(dataRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^[0-9]+[a-z]*$/iu.test(entry.name))
    .map(entry => ({ id: entry.name, files: filesIn(path.join(dataRoot, entry.name)).map(hashFile) }))
    .sort((first, second) => first.id.localeCompare(second.id));
const shared = filesIn(path.join(dataRoot, 'legacy')).map(hashFile);
const images = filesIn(path.join(assets, 'img')).map(hashFile);
const manifest = { schemaVersion: 1, patches, shared, images };
fs.writeFileSync(path.join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
