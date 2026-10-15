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
    const bytes = fs.readFileSync(input || sourcePath);
    const nav = readGridNav(bytes);
    const terrainBytes = fs.readFileSync(path.join(directory, 'terrain_grid.json'));
    const terrain = JSON.parse(terrainBytes);
    const structures = JSON.parse(fs.readFileSync(path.join(directory, 'ward_structures.json')));
    if (structures.source.terrainSha256 !== createHash('sha256').update(terrainBytes).digest('hex')
        || structures.source.navigationSha256 !== createHash('sha256').update(bytes).digest('hex')) {
        throw new Error('Structure footprints are stale; run import:structures for this terrain scan.');
    }
    const grid = encodeWardGrid(nav, {
        file: 'maps/dota.gnv',
        sha256: createHash('sha256').update(bytes).digest('hex'),
        flag: WARD_BLOCKING,
    }, runtimeWardHulls(terrain), structures.features);
    const geoJSON = wardGridToGeoJSON(grid);
    const imagePath = path.join(assetDirectory, 'img', `map_data_${patch}.png`);
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
    fs.writeFileSync(sourcePath, bytes);
    fs.writeFileSync(path.join(directory, 'ward_grid.json'), JSON.stringify(grid));
    fs.writeFileSync(path.join(directory, 'no_wards.json'), JSON.stringify(geoJSON));
    fs.writeFileSync(imagePath, PNG.sync.write(image));
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
