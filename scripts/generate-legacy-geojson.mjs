import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import VisionSimulation from '../dist/vision.node.mjs';
import { unionFeatures } from './geojson-union.mjs';
import { wardGridToGeoJSON } from './ward-grid.mjs';
import { readPreparedWorldData } from '../src/node/patch-inputs.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function generateGeoJSON(vision, grids) {
    let result = null;
    grids.forEach((data, index) => {
        const total = Object.keys(data).length;
        let count = 0;
        for (const key in data) {
            const point = vision.key2pt(key);
            const world = vision.GridXYtoWorldXY(point.x, point.y);
            const feature = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[
                [world.x - 32, world.y - 32], [world.x - 32, world.y + 32],
                [world.x + 32, world.y + 32], [world.x + 32, world.y - 32],
                [world.x - 32, world.y - 32],
            ]] } };
            result = result === null ? feature : unionFeatures(result, feature);
            if (count % 200 === 0) console.log('grids', index, '/', grids.length, ', points', count, '/', total);
            count++;
        }
    });
    return result;
}

export function generateLegacyGeoJSON({ patch, index = -1, assetDirectory = path.join(root, 'assets') } = {}) {
    if (!patch || !/^[a-z0-9]+$/iu.test(patch)) throw new Error('A valid patch ID is required.');
    if (![-1, 0, 1, 2].includes(index)) throw new Error('index must be -1, 0, 1, or 2.');
    const directory = path.join(assetDirectory, 'data', patch);
    const world = readPreparedWorldData({ patch, assetDirectory });
    const vision = new VisionSimulation(world);
    const imagePath = path.join(assetDirectory, 'img', `map_data_${patch}.png`);
    return new Promise((resolve, reject) => {
        vision.initialize(imagePath, () => {
            try {
                if (index === 0 || index === -1) {
                    const wardPath = path.join(directory, 'ward_grid.json');
                    const noWards = fs.existsSync(wardPath)
                        ? wardGridToGeoJSON(JSON.parse(fs.readFileSync(wardPath, 'utf8')))
                        : generateGeoJSON(vision, [vision.gridnav, vision.tools_no_wards]);
                    fs.writeFileSync(path.join(directory, 'no_wards.json'), JSON.stringify(noWards), 'utf8');
                }
                if (index === 1 || index === -1) {
                    const blockers = generateGeoJSON(vision, [vision.ent_fow_blocker_node]);
                    fs.writeFileSync(path.join(directory, 'ent_fow_blocker_node.json'), JSON.stringify(blockers), 'utf8');
                }
                if (index === 2 || index === -1) {
                    const elevations = {};
                    for (const [key, point] of Object.entries(vision.elevationGrid)) {
                        (elevations[point.z] ||= {})[key] = point;
                    }
                    const combined = { type: 'FeatureCollection', features: [] };
                    for (const [elevation, grid] of Object.entries(elevations)) {
                        const feature = generateGeoJSON(vision, [grid]);
                        feature.properties = { elevation };
                        combined.features.push(feature);
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
