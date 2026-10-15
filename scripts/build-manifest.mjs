import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = path.join(root, 'assets');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
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
    .map(entry => ({
        id: entry.name,
        packageName: `@reino-doce/dota-maps-data-${entry.name}`,
        files: filesIn(path.join(dataRoot, entry.name)).map(hashFile),
    }))
    .sort((first, second) => first.id.localeCompare(second.id));
const currentPatch = packageJson.dotaMapsData?.currentPatch;
if (!patches.some(patch => patch.id === currentPatch)) {
    throw new Error(`The configured current patch ${JSON.stringify(currentPatch)} has no assets/data directory.`);
}
const shared = filesIn(path.join(dataRoot, 'legacy')).map(hashFile);
const images = filesIn(path.join(assets, 'img')).map(hashFile);
const skinPackages = images
    .filter(entry => entry.path.startsWith(`img/skins/${currentPatch}/`))
    .map(entry => {
        const filename = path.posix.basename(entry.path, '.png');
        const id = filename === 'dota' ? 'base' : filename.replace(/^dota_/u, '');
        return { id, packageName: `@reino-doce/dota-map-skin-${id}`, file: entry };
    });
const manifest = {
    schemaVersion: 1,
    currentPatch,
    latestPackage: {
        packageName: '@reino-doce/dota-maps-data-latest',
        sourcePatch: currentPatch,
        sourcePackageName: `@reino-doce/dota-maps-data-${currentPatch}`,
    },
    latestSkinsPackageName: '@reino-doce/dota-map-skins-latest',
    skinPackages,
    patches,
    shared,
    images,
};
const latestExports = {
    './latest/mapdata.json': './assets/data/' + currentPatch + '/mapdata.json',
};
const latestImages = images.filter(entry => {
    if (entry.path.startsWith('img/skins/')) return false;
    return entry.path === 'img/map_data_' + currentPatch + '.png'
        || (currentPatch === '688' && entry.path === 'img/map_data.png')
        || entry.path === 'img/dota-map-' + currentPatch + '.png'
        || entry.path === 'img/dota-game-map-' + currentPatch + '.jpg';
});
for (const image of latestImages) {
    latestExports['./latest/' + path.posix.basename(image.path)] = './assets/' + image.path;
}
const imageAliases = [
    ['map_data.png', currentPatch === '688' ? 'img/map_data.png' : 'img/map_data_' + currentPatch + '.png'],
    ['dota-map.png', 'img/dota-map-' + currentPatch + '.png'],
    ['dota-game-map.jpg', 'img/dota-game-map-' + currentPatch + '.jpg'],
];
for (const [alias, assetPath] of imageAliases) {
    if (images.some(image => image.path === assetPath)) {
        latestExports['./latest/' + alias] = './assets/' + assetPath;
    }
}
for (const skin of skinPackages) {
    latestExports['./latest/' + skin.id + '/' + path.posix.basename(skin.file.path)] = './assets/' + skin.file.path;
}
packageJson.exports = { ...packageJson.exports, ...latestExports };
fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(packageJson, null, 2) + '\n');
fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
