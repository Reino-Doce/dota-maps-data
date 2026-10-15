// Rebuild map height, tree, visibility-blocker and ward raster panels.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { readGridNav } from './ward-grid.mjs';
import { buildVisionGrid } from './vision-grid.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function generateVisionAssets({ patch, assetDirectory = path.join(root, 'assets') }) {
    if (!patch || !/^[a-z0-9]+$/iu.test(patch)) throw new Error('A valid patch ID is required.');
    const directory = path.join(assetDirectory, 'data', patch);
    const read = file => fs.readFileSync(path.join(directory, file));
    const nav = readGridNav(read('gridnav.gnv'));
    const terrain = JSON.parse(read('terrain_grid.json'));
    const blockers = JSON.parse(read('fow_blockers.json'));
    const result = buildVisionGrid(nav, terrain, blockers.points);
    if (!Array.isArray(terrain.entities)) throw new Error('Recapture terrain with runtime entities before importing.');
    const mapData = JSON.parse(read('mapdata.json'));
    mapData.data.npc_dota_lotus_pool = terrain.entities
        .filter(entity => entity.classname === 'npc_dota_lotus_pool')
        .map(({ origin: [x, y], hullRadius }) => ({ x, y, hullRadius }));
    mapData.stats.npc_dota_lotus_pool = {};
    fs.writeFileSync(path.join(directory, 'mapdata.json'), JSON.stringify(mapData));
    fs.writeFileSync(path.join(directory, 'worlddata.json'), JSON.stringify(result.world));
    fs.writeFileSync(path.join(directory, 'elevation.json'), JSON.stringify(result.elevation));
    fs.writeFileSync(path.join(directory, 'ent_fow_blocker_node.json'), JSON.stringify(result.blockers));
    fs.writeFileSync(path.join(assetDirectory, 'img', `map_data_${patch}.png`), PNG.sync.write(result.image));
    return { width: nav.width, height: nav.height, blockerCount: blockers.points.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const [patch] = process.argv.slice(2);
        if (!patch || process.argv.length !== 3) throw new Error('Usage: npm run import:terrain -- <patch>');
        const result = generateVisionAssets({ patch });
        console.log(`Imported ${result.width}x${result.height} terrain cells and ${result.blockerCount} vision blockers.`);
    }
    catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
