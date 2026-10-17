import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = path.join(root, 'assets');
const patchIdPattern = /^[0-9]+(?:_[0-9]+)?[a-z]*$/iu;
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
    .filter(entry => entry.isDirectory() && patchIdPattern.test(entry.name))
    .map(entry => ({
        id: entry.name,
        packageName: `@reino-doce/dota-maps-data-${entry.name}`,
        files: filesIn(path.join(dataRoot, entry.name)).map(hashFile),
    }))
    .sort((first, second) => first.id.localeCompare(second.id));
for (const patch of patches) {
    const expectedWorldData = `data/${patch.id}/worlddata.json`;
    if (!patch.files.some(entry => entry.path === expectedWorldData)) {
        throw new Error(`Patch ${patch.id} is missing ${expectedWorldData}; every patch needs its own coordinate bounds.`);
    }
}
const currentPatch = packageJson.dotaMapsData?.currentPatch;
if (!patches.some(patch => patch.id === currentPatch)) {
    throw new Error(`The configured current patch ${JSON.stringify(currentPatch)} has no assets/data directory.`);
}
const shared = [];
const images = filesIn(path.join(assets, 'img')).map(hashFile);
const minimapsDirectory = path.join(assets, 'provenance', 'minimaps');
const minimaps = fs.existsSync(minimapsDirectory)
    ? fs.readdirSync(minimapsDirectory, { withFileTypes: true })
        .filter(entry => entry.isFile() && /^[0-9]+(?:_[0-9]+)?[a-z]*\.json$/iu.test(entry.name))
        .map(entry => {
            const filename = path.join(minimapsDirectory, entry.name);
            const data = JSON.parse(fs.readFileSync(filename, 'utf8'));
            if (data.patch !== path.basename(entry.name, '.json') || !data.images || typeof data.images !== 'object') {
                throw new Error(`Invalid minimap provenance file: ${path.relative(root, filename)}`);
            }
            for (const image of Object.values(data.images)) {
                const inventoryEntry = images.find(candidate => candidate.path === image.path);
                if (!inventoryEntry || inventoryEntry.sha256 !== image.sha256 || inventoryEntry.bytes !== image.bytes) {
                    throw new Error(`Minimap provenance does not match its registered image: ${image.path}`);
                }
            }
            return {
                patch: data.patch,
                sourceFile: hashFile(filename),
                source: data.source,
                images: data.images,
                ...(data.omittedImages ? { omittedImages: data.omittedImages } : {}),
                ...(data.rejectedCandidates ? { rejectedCandidates: data.rejectedCandidates } : {}),
            };
        })
        .sort((first, second) => first.patch.localeCompare(second.patch))
    : [];
const patchImageMatch = entry => entry.path.match(/^img\/([0-9]+(?:_[0-9]+)?[a-z]*)\/([^/]+)$/iu);
const nonSkinImages = new Set(['default.png', 'map_data.png', 'illustrated.jpg', 'overview.png', 'screenshot.jpg',
    'simple.png', 'detailed.png']);
const skinPackages = images
    .filter(entry => {
        const match = patchImageMatch(entry);
        return match && !nonSkinImages.has(match[2]) && !match[2].endsWith('.source.png');
    })
    .map(entry => {
        const [, patchId, filename] = patchImageMatch(entry);
        const id = path.posix.basename(filename, path.posix.extname(filename));
        return {
            id,
            patchId,
            packageName: `@reino-doce/dota-map-skin-${patchId}-${id}`,
            file: entry,
        };
    });
const skinSetPackages = Object.fromEntries([...new Set(skinPackages.map(skin => skin.patchId))]
    .map(patchId => [patchId, `@reino-doce/dota-map-skins-${patchId}`]));
const manifest = {
    schemaVersion: 1,
    currentPatch,
    latestPackage: {
        packageName: '@reino-doce/dota-maps-data-latest',
        sourcePatch: currentPatch,
        sourcePackageName: `@reino-doce/dota-maps-data-${currentPatch}`,
    },
    latestSkinsPackageName: '@reino-doce/dota-map-skins-latest',
    skinSetPackages,
    skinPackages,
    patches,
    minimaps,
    shared,
    images,
};
const latestExports = {
    './latest/mapdata.json': './assets/data/' + currentPatch + '/mapdata.json',
    './latest/worlddata.json': './assets/data/' + currentPatch + '/worlddata.json',
};
const currentImages = images.filter(entry => entry.path.startsWith(`img/${currentPatch}/`));
for (const image of currentImages.filter(entry => nonSkinImages.has(path.posix.basename(entry.path)))) {
    if (path.posix.basename(image.path) === 'overview.png') continue;
    latestExports['./latest/' + path.posix.basename(image.path)] = './assets/' + image.path;
}
for (const image of currentImages.filter(entry => entry.path.startsWith(`img/${currentPatch}/minimaps/`))) {
    const filename = image.path.slice(`img/${currentPatch}/minimaps/`.length);
    latestExports['./latest/minimaps/' + filename] = './assets/' + image.path;
}
for (const skin of skinPackages.filter(entry => entry.patchId === currentPatch)) {
    latestExports['./latest/' + skin.id + '/' + path.posix.basename(skin.file.path)] = './assets/' + skin.file.path;
}
packageJson.exports = {
    ...Object.fromEntries(Object.entries(packageJson.exports)
        .filter(([subpath]) => !subpath.startsWith('./latest/'))),
    ...latestExports,
};
fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(packageJson, null, 2) + '\n');
fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
