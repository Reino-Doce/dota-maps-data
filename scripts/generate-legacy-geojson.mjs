import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import VisionSimulation from '../dist/vision.node.mjs';
import { gridToPolygons } from '../src/gridContours.mjs';
import { wardGridToGeoJSON } from './ward-grid.mjs';
import { readPreparedWorldData } from '../src/node/patch-inputs.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function gridKeysToFeature(vision, keys, properties) {
    const width = vision.gridWidth;
    const height = vision.gridHeight;
    if (!Number.isInteger(width) || !Number.isInteger(height)) throw new Error('Vision raster has invalid grid dimensions.');
    const rows = Array.from({ length: height }, () => []);
    for (const key of keys) {
        const point = vision.key2pt(key);
        if (Number.isInteger(point.x) && Number.isInteger(point.y)
            && point.x >= 0 && point.y >= 0 && point.x < width && point.y < height) rows[point.y].push(point.x);
    }
    const blockedRows = rows.map(cells => {
        cells.sort((first, second) => first - second);
        const spans = [];
        for (const x of cells) {
            const last = spans.length - 1;
            if (last >= 0 && x < spans[last]) continue;
            if (last >= 0 && x === spans[last]) spans[last]++;
            else spans.push(x, x + 1);
        }
        return spans;
    });
    const coordinates = gridToPolygons({ width, height, cellSize: 64,
        origin: [vision.worldMinX - 32, vision.worldMinY - 32], blockedRows });
    if (!coordinates.length) return null;
    return { type: 'Feature', ...(properties ? { properties } : {}),
        geometry: { type: 'MultiPolygon', coordinates } };
}

function gridFeatures(vision, grids, properties) {
    const keys = new Set();
    for (const grid of grids) for (const key of Object.keys(grid)) keys.add(key);
    return gridKeysToFeature(vision, keys, properties);
}

export function generateLegacyGeoJSON({ patch, index = -1, assetDirectory = path.join(root, 'assets') } = {}) {
    if (!patch || !/^[a-z0-9]+$/iu.test(patch)) throw new Error('A valid patch ID is required.');
    if (![-1, 0, 1, 2].includes(index)) throw new Error('index must be -1, 0, 1, or 2.');
    const directory = path.join(assetDirectory, 'data', patch);
    const world = readPreparedWorldData({ patch, assetDirectory });
    const vision = new VisionSimulation(world);
    const versionedImagePath = path.join(assetDirectory, 'img', patch, 'map_data.png');
    const legacyImagePath = path.join(assetDirectory, 'img', `map_data_${patch}.png`);
    const imagePath = fs.existsSync(versionedImagePath) ? versionedImagePath : legacyImagePath;
    if (!fs.existsSync(imagePath)) {
        throw new Error(`Patch ${patch} is missing its map_data.png vision raster under assets/img/${patch}/.`);
    }
    return new Promise((resolve, reject) => {
        vision.initialize(imagePath, () => {
            try {
                if (index === 0 || index === -1) {
                    const wardPath = path.join(directory, 'ward_grid.json');
                    const noWards = fs.existsSync(wardPath)
                        ? wardGridToGeoJSON(JSON.parse(fs.readFileSync(wardPath, 'utf8')))
                        : gridFeatures(vision, [vision.gridnav, vision.tools_no_wards]);
                    fs.writeFileSync(path.join(directory, 'no_wards.json'), JSON.stringify(noWards), 'utf8');
                }
                if (index === 1 || index === -1) {
                    const blockers = gridFeatures(vision, [vision.ent_fow_blocker_node]);
                    fs.writeFileSync(path.join(directory, 'ent_fow_blocker_node.json'), JSON.stringify(blockers), 'utf8');
                }
                if (index === 2 || index === -1) {
                    const elevations = new Map();
                    for (const [key, point] of Object.entries(vision.elevationGrid)) {
                        if (!elevations.has(point.z)) elevations.set(point.z, []);
                        elevations.get(point.z).push(key);
                    }
                    const combined = { type: 'FeatureCollection', features: [] };
                    for (const elevation of [...elevations.keys()].sort((first, second) => first - second)) {
                        const feature = gridKeysToFeature(vision, elevations.get(elevation), { elevation: String(elevation) });
                        if (feature) combined.features.push(feature);
                    }
                    fs.writeFileSync(path.join(directory, 'elevation.json'), JSON.stringify(combined), 'utf8');
                }
                resolve({ patch, directory });
            }
            catch (error) {
                reject(error);
            }
        });
    });
}

async function main(argv = process.argv.slice(2)) {
    const [patch, value] = argv;
    if (!patch || argv.length > 2) throw new Error('Usage: npm run generatejson -- <patch> [0|1|2]');
    const index = value === undefined ? -1 : Number(value);
    await generateLegacyGeoJSON({ patch, index });
    await import('./build-manifest.mjs');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
