// Rebuild map height, tree, visibility-blocker and ward raster panels.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { createHash } from 'node:crypto';
import { readGridNav } from './ward-grid.mjs';
import { buildTerrainOverlays, buildVisionGrid } from './vision-grid.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const terrainInputs = ['terrain_grid.json', 'fow_blockers.json', 'mapdata.json', 'source.json'];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function generateVisionAssets({ patch, assetDirectory = path.join(root, 'assets') }) {
    if (!patch || !/^[a-z0-9]+$/iu.test(patch)) throw new Error('A valid patch ID is required.');
    const directory = path.join(assetDirectory, 'data', patch);
    const read = file => fs.readFileSync(path.join(directory, file));
    const terrain = JSON.parse(read('terrain_grid.json'));
    const blockers = JSON.parse(read('fow_blockers.json'));
    if (!Array.isArray(terrain.entities)) throw new Error('Recapture terrain with runtime entities before importing.');
    const source = JSON.parse(read('source.json'));
    if (source.patch !== patch || terrain.source?.patch !== patch
        || terrain.source.mapArchiveSha256 !== source.archiveSha256
        || terrain.source.mapResource !== source.resources?.map?.path
        || terrain.source.mapEntitiesSha256 !== (source.resources?.entities?.sha256 || null)) {
        throw new Error('Terrain capture does not match this patch source.json; refusing to generate mixed-version data.');
    }
    let nav;
    let result;
    let navigationSha256 = null;
    const hasGridNav = source.resources?.navigation?.available === true;
    if (hasGridNav) {
        const navigationBytes = read('gridnav.gnv');
        navigationSha256 = sha256(navigationBytes);
        if (navigationSha256 !== source.resources.navigation.sha256
            || terrain.source.navigationSha256 !== navigationSha256) {
            throw new Error('Navigation or terrain capture does not match the patch source; refusing to combine different versions.');
        }
        nav = readGridNav(navigationBytes);
        result = buildVisionGrid(nav, terrain, blockers.points);
    }
    else {
        if (fs.existsSync(path.join(directory, 'gridnav.gnv')) || terrain.source.navigationSha256 !== null) {
            throw new Error('Patch source marks navigation unavailable but terrain or files contain a navigation grid.');
        }
        result = buildTerrainOverlays(terrain, blockers.points);
    }
    const mapData = JSON.parse(read('mapdata.json'));
    mapData.data.npc_dota_lotus_pool = terrain.entities
        .filter(entity => entity.classname === 'npc_dota_lotus_pool')
        .map(({ origin: [x, y], hullRadius }) => ({ x, y, hullRadius }));
    mapData.stats.npc_dota_lotus_pool = {};
    source.dataCoverage = {
        ...source.dataCoverage,
        terrainHeights: 'terrain_grid.json: patch-matched GetGroundHeight samples at native navigation cell centers, or aligned world-bound cells when the exact archive has no GNV',
        elevationContours: 'elevation.json: generated from this patch terrain_grid.json',
        fowBlockerContours: 'ent_fow_blocker_node.json: generated from this patch fow_blockers.json',
        mapDataRaster: hasGridNav
            ? 'assets/img/<patch>/map_data.png: five-panel raster from this patch navigation, terrain, trees, and FOW blockers'
            : 'unavailable: the exact map archive has no GNV; only terrain and FOW overlays are generated',
        wardRestrictions: hasGridNav
            ? 'generated separately from this patch GNV and matching collision/structure footprints'
            : 'unavailable: the exact map archive has no GNV; no ward restrictions are inferred',
    };
    fs.writeFileSync(path.join(directory, 'mapdata.json'), `${JSON.stringify(mapData)}\n`);
    fs.writeFileSync(path.join(directory, 'worlddata.json'), `${JSON.stringify(result.world)}\n`);
    fs.writeFileSync(path.join(directory, 'elevation.json'), `${JSON.stringify(result.elevation)}\n`);
    fs.writeFileSync(path.join(directory, 'ent_fow_blocker_node.json'), `${JSON.stringify(result.blockers)}\n`);
    if (hasGridNav) {
        const imagePath = path.join(assetDirectory, 'img', patch, 'map_data.png');
        fs.mkdirSync(path.dirname(imagePath), { recursive: true });
        fs.writeFileSync(imagePath, PNG.sync.write(result.image));
    }
    fs.writeFileSync(path.join(directory, 'source.json'), `${JSON.stringify(source, null, 2)}\n`);
    return { width: terrain.width, height: terrain.height, blockerCount: blockers.points.length,
        navigationAvailable: hasGridNav };
}

export function generateAllVisionAssets({ assetDirectory = path.join(root, 'assets') } = {}) {
    const dataDirectory = path.join(assetDirectory, 'data');
    const imageDirectory = path.join(assetDirectory, 'img');
    const generated = [];
    const skipped = [];
    const failed = [];
    const patches = new Set();
    for (const directory of [dataDirectory, imageDirectory]) {
        if (!fs.existsSync(directory)) continue;
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            if (entry.isDirectory() && /^\d+[a-z0-9]*$/iu.test(entry.name)) patches.add(entry.name);
        }
    }

    for (const patch of [...patches].sort()) {
        const patchDirectory = path.join(dataDirectory, patch);
        const outputExists = fs.existsSync(path.join(imageDirectory, patch, 'map_data.png'));
        if (!fs.existsSync(patchDirectory)) {
            skipped.push({ patch, missing: [`assets/data/${patch}/`], outputExists });
            continue;
        }
        const missing = terrainInputs.filter(filename => !fs.existsSync(path.join(patchDirectory, filename)));
        let hasGridNav = false;
        if (missing.length === 0) {
            try {
                hasGridNav = JSON.parse(fs.readFileSync(path.join(patchDirectory, 'source.json'), 'utf8'))
                    .resources?.navigation?.available === true;
            }
            catch (error) {
                failed.push({ patch, message: `Invalid source.json: ${error.message}` });
                continue;
            }
        }
        if (hasGridNav && !fs.existsSync(path.join(patchDirectory, 'gridnav.gnv'))) missing.push('gridnav.gnv');
        if (missing.length > 0) {
            skipped.push({ patch, missing, outputExists });
            continue;
        }
        try {
            generated.push({ patch, ...generateVisionAssets({ patch, assetDirectory }) });
        }
        catch (error) {
            failed.push({ patch, message: error.message });
        }
    }
    return { generated, skipped, failed };
}

function main(argv = process.argv.slice(2)) {
    const [patch] = argv;
    if (patch === '--all') {
        if (argv.length !== 1) throw new Error('Usage: npm run import:terrain -- --all');
        const result = generateAllVisionAssets();
        for (const item of result.generated) {
            const raster = item.navigationAvailable ? 'five-panel raster' : 'no native nav raster';
            console.log(`${item.patch}: imported ${item.width}x${item.height} terrain cells, ${item.blockerCount} vision blockers, ${raster}.`);
        }
        for (const item of result.skipped) {
            const existing = item.outputExists ? 'kept existing map_data.png; ' : '';
            console.log(`${item.patch}: ${existing}skipped; missing ${item.missing.join(', ')}.`);
        }
        for (const item of result.failed) console.error(`${item.patch}: ${item.message}`);
        console.log(`Generated ${result.generated.length} patch(es); skipped ${result.skipped.length}; failed ${result.failed.length}.`);
        if (result.failed.length > 0 || result.generated.length === 0) process.exitCode = 1;
        return;
    }
    if (!patch || argv.length !== 1) throw new Error('Usage: npm run import:terrain -- <patch> | --all');
    const result = generateVisionAssets({ patch });
    console.log(`Imported ${result.width}x${result.height} terrain cells and ${result.blockerCount} vision blockers.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try { main(); }
    catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
