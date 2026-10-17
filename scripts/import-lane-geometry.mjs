import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parseEntityVector, parseSource2EntityDump } from './source2-entities.mjs';

const laneSpawner = /^npc_dota_spawner_(?:good|bad)_(?:bot|mid|top)$/iu;

function feature(id, type, coordinates) {
    return { type: 'Feature', id, geometry: { type, coordinates } };
}

function routeFor(spawner, corners) {
    let target = spawner.npcfirstwaypoint;
    if (typeof target !== 'string' || target.length === 0) {
        throw new Error(`Lane spawner ${spawner.classname} has no first waypoint.`);
    }
    const visited = new Set();
    const coordinates = [];
    while (target) {
        if (visited.has(target)) break;
        visited.add(target);
        const corner = corners.get(target);
        if (!corner) throw new Error(`Lane path ${spawner.classname} points to missing corner ${target}.`);
        coordinates.push(parseEntityVector(corner.origin, `${target} origin`).slice(0, 2));
        target = corner.target || '';
    }
    if (coordinates.length < 2) throw new Error(`Lane path ${spawner.classname} has fewer than two waypoints.`);
    return coordinates;
}

export function buildLaneGeometry(entities) {
    if (!Array.isArray(entities)) throw new TypeError('Map entities must be an array.');
    const spawners = entities.filter(entity => laneSpawner.test(entity.classname))
        .sort((first, second) => first.classname.localeCompare(second.classname));
    if (spawners.length !== 6 || new Set(spawners.map(entity => entity.classname)).size !== 6) {
        throw new Error(`Expected six distinct lane spawners; found ${spawners.length}.`);
    }

    const corners = new Map();
    for (const corner of entities.filter(entity => entity.classname === 'path_corner')) {
        if (typeof corner.targetname !== 'string' || corner.targetname.length === 0 || corners.has(corner.targetname)) {
            throw new Error('Lane path corners must have unique target names.');
        }
        corners.set(corner.targetname, corner);
    }
    if (corners.size === 0) throw new Error('The map has no path_corner entities.');

    const spawnerFeatures = [];
    const pathFeatures = [];
    for (const spawner of spawners) {
        const id = spawner.classname.toLowerCase();
        const [x, y] = parseEntityVector(spawner.origin, `${id} origin`);
        spawnerFeatures.push(feature(id, 'Point', [x, y]));
        pathFeatures.push(feature(id, 'LineString', routeFor(spawner, corners)));
    }
    return {
        spawners: { type: 'FeatureCollection', features: spawnerFeatures },
        paths: { type: 'FeatureCollection', features: pathFeatures },
    };
}

function writeAtomic(filename, text) {
    const temporary = `${filename}.${process.pid}.tmp`;
    try {
        fs.writeFileSync(temporary, text, { flag: 'wx' });
        fs.renameSync(temporary, filename);
    }
    finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
}

export function importLaneGeometry({ patch, entitiesFile, outputDirectory, overwrite = false } = {}) {
    if (typeof patch !== 'string' || !/^[a-z0-9]+$/iu.test(patch)) throw new Error('A valid patch ID is required.');
    if (typeof entitiesFile !== 'string' || !path.isAbsolute(entitiesFile) || !fs.existsSync(entitiesFile)) {
        throw new Error('Pass --entities with an existing absolute Source 2 Viewer entity dump.');
    }
    if (typeof outputDirectory !== 'string' || !path.isAbsolute(outputDirectory)) {
        throw new Error('Pass --output with an absolute patch output directory.');
    }

    const data = buildLaneGeometry(parseSource2EntityDump(fs.readFileSync(entitiesFile, 'utf8')));
    const outputs = [
        [path.join(outputDirectory, 'npc_dota_spawner.json'), data.spawners],
        [path.join(outputDirectory, 'path_corner.json'), data.paths],
    ];
    const existing = outputs.filter(([filename]) => fs.existsSync(filename)).map(([filename]) => path.basename(filename));
    if (existing.length && !overwrite) throw new Error(`Refusing to overwrite ${existing.join(', ')}; pass --overwrite explicitly.`);
    fs.mkdirSync(outputDirectory, { recursive: true });
    for (const [filename, value] of outputs) writeAtomic(filename, `${JSON.stringify(value)}\n`);
    return { patch, spawners: data.spawners.features.length, pathFeatures: data.paths.features.length };
}

function main(argv = process.argv.slice(2)) {
    const { values, positionals } = parseArgs({ args: argv, strict: true, allowPositionals: true, options: {
        patch: { type: 'string' }, entities: { type: 'string' }, output: { type: 'string' }, overwrite: { type: 'boolean' },
    } });
    if (positionals.length) throw new Error('Usage: npm run import:lanes -- --patch <id> --entities <dump.txt> --output <directory> [--overwrite]');
    const result = importLaneGeometry({ patch: values.patch, entitiesFile: values.entities, outputDirectory: values.output,
        overwrite: values.overwrite });
    console.log(`${result.patch}: generated ${result.spawners} lane spawners and ${result.pathFeatures} paths.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try { main(); }
    catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
