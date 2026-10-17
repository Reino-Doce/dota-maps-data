import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import { readGridNav, encodeWardGrid, wardGridToGeoJSON, runtimeWardHulls, WARD_BLOCKING } from './ward-grid.mjs';
import { isWardBlocked } from '../src/wardGrid.mjs';
import { readPreparedWorldData } from '../src/node/patch-inputs.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function importWardGrid({ patch, input, assetDirectory = path.join(root, 'assets') }) {
    if (!patch || !/^[a-z0-9]+$/iu.test(patch)) throw new Error('A valid patch ID is required.');
    const directory = path.join(assetDirectory, 'data', patch);
    const sourcePath = path.join(directory, 'gridnav.gnv');
    const source = JSON.parse(fs.readFileSync(path.join(directory, 'source.json'), 'utf8'));
    const navigation = source.resources?.navigation;
    if (source.patch !== patch || navigation?.available !== true || !navigation.path || !navigation.sha256) {
        throw new Error(`Patch ${patch} has no exact native navigation grid in source.json; ward restrictions cannot be generated.`);
    }
    const bytes = fs.readFileSync(input || sourcePath);
    const navigationSha256 = createHash('sha256').update(bytes).digest('hex');
    if (navigationSha256 !== navigation.sha256) {
        throw new Error('Navigation input does not match this patch source.json; refusing to create mixed-version ward data.');
    }
    if (fs.existsSync(sourcePath) && createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex') !== navigationSha256) {
        throw new Error('Prepared gridnav.gnv does not match this patch source.json; refusing to overwrite it.');
    }
    const nav = readGridNav(bytes);
    const terrainBytes = fs.readFileSync(path.join(directory, 'terrain_grid.json'));
    const terrain = JSON.parse(terrainBytes);
    const structures = JSON.parse(fs.readFileSync(path.join(directory, 'ward_structures.json')));
    if (structures.source.terrainSha256 !== createHash('sha256').update(terrainBytes).digest('hex')
        || structures.source.navigationSha256 !== createHash('sha256').update(bytes).digest('hex')) {
        throw new Error('Structure footprints are stale; run import:structures for this terrain scan.');
    }
    const grid = encodeWardGrid(nav, {
        file: navigation.path,
        sha256: navigationSha256,
        flag: WARD_BLOCKING,
    }, runtimeWardHulls(terrain), structures.features);
    const geoJSON = wardGridToGeoJSON(grid);
    const imagePath = path.join(assetDirectory, 'img', patch, 'map_data.png');
    const image = PNG.sync.read(fs.readFileSync(imagePath));
    const world = readPreparedWorldData({ patch, assetDirectory });
    const width = (world.worldMaxX - world.worldMinX) / 64 + 1;
    const height = (world.worldMaxY - world.worldMinY) / 64 + 1;
    if (image.width !== width * 5 || image.height !== height) throw new Error('Unexpected vision raster bounds.');
    // Runtime hulls use exact positions; the image keeps the static ward grid.
    const staticGrid = { ...grid, hulls: [], structures: [] };
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const index = ((height - 1 - y) * image.width + 4 * width + x) * 4;
            const color = isWardBlocked(staticGrid, world.worldMinX + x * 64, world.worldMinY + y * 64) ? 0 : 255;
            image.data[index] = image.data[index + 1] = image.data[index + 2] = color;
            image.data[index + 3] = 255;
        }
    }
    fs.mkdirSync(directory, { recursive: true });
    if (!fs.existsSync(sourcePath)) fs.writeFileSync(sourcePath, bytes, { flag: 'wx' });
    fs.writeFileSync(path.join(directory, 'ward_grid.json'), JSON.stringify(grid));
    fs.writeFileSync(path.join(directory, 'no_wards.json'), JSON.stringify(geoJSON));
    fs.writeFileSync(imagePath, PNG.sync.write(image));
    source.dataCoverage = { ...source.dataCoverage,
        wardGrid: `ward_grid.json: exact ${navigation.path} (${navigationSha256}) plus matching terrain/collision inputs`,
        wardRestrictions: 'no_wards.json and panel 5 of assets/img/<patch>/map_data.png generated from this patch ward_grid.json',
    };
    fs.writeFileSync(path.join(directory, 'source.json'), `${JSON.stringify(source, null, 2)}\n`);
    return { width: nav.width, height: nav.height, blockedCells: nav.flags.filter(flag => flag & WARD_BLOCKING).length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const [patch, input] = process.argv.slice(2);
        if (!patch || process.argv.length > 4) throw new Error('Usage: npm run import:wards -- <patch> [extracted dota.gnv]');
        const result = importWardGrid({ patch, input });
        console.log(`Imported ${result.width}x${result.height} cells; ${result.blockedCells} block wards.`);
    }
    catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
