// Generate map locations from one exact Dota map archive. Importing this module is inert.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { openVpk } from '../src/node/game-files.mjs';
import { parseEntityVector, parseSource2EntityDump } from './source2-entities.mjs';
import { buildNeutralSpawnBoxes, mergeNeutralSpawnBoxes, parseNeutralSpawnEntities,
    parseSource2PhysicsHull } from './neutral-spawn-boxes.mjs';
import { buildLaneGeometry } from './import-lane-geometry.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mapResourcePattern = /^maps\/(dota(?:_[a-z0-9]+)?)\.vmap_c$/iu;
const baseLayerPattern = /^world_layer_(?:dire|radiant)_base\.vents_c$/iu;
const pointClasses = [
    'dota_item_rune_spawner', 'dota_item_rune_spawner_bounty', 'dota_item_rune_spawner_powerup',
    'dota_item_rune_spawner_xp', 'ent_dota_fountain', 'npc_dota_lotus_pool', 'ent_dota_neutral_item_stash',
    'ent_dota_shop', 'npc_dota_base_blocker', 'npc_dota_fort', 'npc_dota_healer', 'npc_dota_lantern',
    'npc_dota_mango_tree', 'npc_dota_miniboss_spawner', 'npc_dota_roshan_spawner', 'npc_dota_tower',
    'npc_dota_unit_twin_gate', 'npc_dota_watch_tower', 'npc_dota_xp_fountain',
];
const mapEntityLayerClasses = [...new Set([
    ...pointClasses.filter(classname => classname !== 'dota_item_rune_spawner'),
    'ent_dota_tree', 'npc_dota_neutral_spawner', 'npc_dota_barracks',
    'npc_dota_filler', 'trigger_multiple',
])];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function fileSha256(filename) {
    const digest = createHash('sha256');
    const descriptor = fs.openSync(filename, 'r');
    try {
        const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
        let read;
        while ((read = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
            digest.update(buffer.subarray(0, read));
        }
    }
    finally {
        fs.closeSync(descriptor);
    }
    return digest.digest('hex');
}

function mapCoordinate(entity, includeZ = false) {
    const [x, y, z] = parseEntityVector(entity.origin, `${entity.classname} origin`);
    const point = { x, y };
    if (includeZ) point.z = z;
    return point;
}

function put(data, classname, entities, project = entity => mapCoordinate(entity)) {
    const values = entities.map(project);
    if (values.length) data[classname] = values;
}

export function buildMapData(entities) {
    if (!Array.isArray(entities) || entities.length === 0) throw new Error('No decoded map entities were provided.');
    // A present empty array means the exact source was checked and this map has
    // no entities for that layer. It is distinct from data we never extracted.
    const data = Object.fromEntries(mapEntityLayerClasses.map(classname => [classname, []]));
    const select = classname => entities.filter(entity => entity.classname === classname);
    const trees = new Map();
    for (const entity of select('ent_dota_tree')) {
        const point = mapCoordinate(entity, true);
        trees.set(`${point.x},${point.y},${point.z}`, point);
    }
    if (!trees.size) throw new Error('The selected map archive contains no tree entities.');
    data.ent_dota_tree = [...trees.values()];

    const spawners = select('npc_dota_neutral_spawner');
    if (spawners.length) {
        data.npc_dota_neutral_spawner = spawners.map(entity => {
            const sourceName = entity.volumename;
            const triggerName = typeof sourceName === 'string' ? sourceName.replace(/^\[PR#\]/u, '') : '';
            if (!/^neutralcamp_(?:good|evil)_\d+$/u.test(triggerName) || entity.neutraltype === undefined) {
                throw new Error('A neutral spawner is missing its versioned camp identity or type.');
            }
            return { triggerName, neutralType: entity.neutraltype,
                ...(entity.pulltype === undefined ? {} : { pullType: entity.pulltype }), ...mapCoordinate(entity) };
        });
    }

    for (const classname of pointClasses) {
        const found = select(classname);
        if (classname === 'npc_dota_tower') {
            put(data, classname, found, entity => {
                const match = /_tower([1-4])(?:_(?:bot|mid|top))?$/iu.exec(entity.mapunitname || '');
                if (!match) throw new Error('A tower has no versioned tower-tier unit name.');
                return { ...mapCoordinate(entity), subType: `tower${match[1]}` };
            });
        }
        else if (classname === 'npc_dota_miniboss_spawner') {
            put(data, classname, found, entity => ({ ...mapCoordinate(entity), name: entity.targetname || '' }));
        }
        else {
            // Source 2 archives use both the generic name and the explicit
            // powerup name for the rune entity. The viewer has one stable
            // layer ID, so normalize both source forms to it.
            const outputClassname = classname === 'dota_item_rune_spawner'
                ? 'dota_item_rune_spawner_powerup' : classname;
            put(data, outputClassname, found);
        }
    }

    const barracks = select('npc_dota_barracks');
    put(data, 'npc_dota_barracks', barracks, entity => {
        const name = entity.mapunitname || entity.model || '';
        const subType = /melee/iu.test(name) ? 'melee' : /range/iu.test(name) ? 'range' : null;
        if (!subType) throw new Error('A barracks has no melee/range identity.');
        return { ...mapCoordinate(entity), subType };
    });

    for (const entity of select('npc_dota_building')) {
        const unitName = entity.mapunitname || '';
        const classname = /_fillers$/iu.test(unitName) ? 'npc_dota_filler'
            : /_healers$/iu.test(unitName) ? 'npc_dota_healer' : null;
        if (classname) (data[classname] ||= []).push(mapCoordinate(entity));
    }

    const blockers = select('ent_fow_blocker_node').map(entity => {
        const [x, y, z] = parseEntityVector(entity.origin, 'FOW blocker origin');
        return [x, y, z];
    });
    data.trigger_multiple = [];
    const mapdata = { data, stats: {} };
    return { mapdata, blockers };
}

function entityKey(entity) {
    if (typeof entity?.campId === 'string') return `camp:${entity.campId}`;
    if (Number.isFinite(entity?.x) && Number.isFinite(entity?.y)) {
        // Source 2 Viewer rounds some floats to six decimal places. Match at
        // millimeter precision so runtime-captured coordinates can be retained.
        const z = Number.isFinite(entity.z) ? Math.round(entity.z * 1000) : '';
        return `point:${Math.round(entity.x * 1000)},${Math.round(entity.y * 1000)},${z}`;
    }
    return null;
}

// Preserve per-patch stats and calibrated hulls when refreshing a map from a
// VPK. Those fields are not encoded in the point-location output. Only carry a
// hull onto an entity whose coordinates still match exactly.
export function preserveMapDataAnnotations(mapdata, previousMapdata) {
    if (!previousMapdata || typeof previousMapdata !== 'object') return mapdata;
    if (previousMapdata.stats && typeof previousMapdata.stats === 'object' && !Array.isArray(previousMapdata.stats)) {
        mapdata.stats = previousMapdata.stats;
    }
    for (const [classname, entities] of Object.entries(mapdata.data)) {
        const previousEntities = previousMapdata.data?.[classname];
        if (!Array.isArray(entities) || !Array.isArray(previousEntities)) continue;
        const oldByKey = new Map(previousEntities.map(entity => [entityKey(entity), entity]).filter(([key]) => key));
        for (const entity of entities) {
            const previous = oldByKey.get(entityKey(entity));
            if (!previous) continue;
            if (Math.abs(previous.x - entity.x) <= 0.001 && Math.abs(previous.y - entity.y) <= 0.001) {
                entity.x = previous.x;
                entity.y = previous.y;
                if (Number.isFinite(previous.z) && Number.isFinite(entity.z) && Math.abs(previous.z - entity.z) <= 0.001) {
                    entity.z = previous.z;
                }
            }
            if (Number.isFinite(previous.hullRadius) && !Number.isFinite(entity.hullRadius)) {
                entity.hullRadius = previous.hullRadius;
            }
        }
    }
    return mapdata;
}

function preservedGameClientVersion(previousMapdata, entityHash, navigationHash) {
    for (const trigger of previousMapdata?.data?.trigger_multiple || []) {
        const source = trigger.source;
        if (source?.entityResource?.sha256 === entityHash && source.gridnavSha256 === navigationHash
            && typeof source.gameClientVersion === 'string' && /^\d+$/u.test(source.gameClientVersion)) {
            return source.gameClientVersion;
        }
    }
    return null;
}

function decode(resourceTool, input, args, options = {}) {
    try {
        return execFileSync(resourceTool, ['-i', input, ...args], {
            windowsHide: true,
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
            timeout: 120_000,
            ...options,
        });
    }
    catch (error) {
        const detail = error.stderr?.toString().trim() || error.message;
        throw new Error(`Source 2 Viewer could not decode ${path.basename(input)}: ${detail}`, { cause: error });
    }
}

function decodeEntityResource(resourceTool, resourcePath, bytes, directory, index) {
    const input = path.join(directory, `entities-${index}.vents_c`);
    const output = path.join(directory, `entities-${index}.txt`);
    fs.writeFileSync(input, bytes, { flag: 'wx' });
    decode(resourceTool, input, ['-d', '-o', output]);
    if (!fs.existsSync(output)) throw new Error(`Source 2 Viewer produced no entity dump for ${resourcePath}.`);
    return fs.readFileSync(output, 'utf8');
}

function physicsResourceForModel(modelPath) {
    if (typeof modelPath !== 'string' || !modelPath.endsWith('.vmdl')) {
        throw new Error('A neutral camp trigger does not reference a Source 2 model.');
    }
    return modelPath.replace(/\.vmdl$/iu, '.vphys') + '_c';
}

function writeAtomic(filename, bytes) {
    const temporary = `${filename}.${process.pid}.tmp`;
    try {
        fs.writeFileSync(temporary, bytes, { flag: 'wx' });
        fs.renameSync(temporary, filename);
    }
    finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
}

export function importMapData({ patch, archivePath, resourceTool, outputDirectory, overwrite = false,
    gameClientVersion = null } = {}) {
    if (typeof patch !== 'string' || !/^[a-z0-9]+$/iu.test(patch)) throw new Error('Pass a valid --patch ID.');
    if (gameClientVersion !== null && (typeof gameClientVersion !== 'string' || !/^\d+$/u.test(gameClientVersion))) {
        throw new Error('Pass --game-client-version as a numeric string.');
    }
    if (typeof archivePath !== 'string' || !path.isAbsolute(archivePath) || !fs.existsSync(archivePath)) {
        throw new Error('Pass --archive with an existing absolute Dota map VPK path.');
    }
    if (typeof resourceTool !== 'string' || !path.isAbsolute(resourceTool) || !fs.existsSync(resourceTool)) {
        throw new Error('Pass --resource-tool with an existing absolute Source2Viewer-CLI path.');
    }
    if (typeof outputDirectory !== 'string' || !path.isAbsolute(outputDirectory)) {
        throw new Error('Pass --output with an absolute patch output directory.');
    }

    const archive = openVpk(archivePath);
    const mapResources = archive.files.filter(filename => mapResourcePattern.test(filename));
    if (mapResources.length !== 1) throw new Error(`Expected one compiled Dota map in the VPK; found ${mapResources.length}.`);
    const mapName = mapResourcePattern.exec(mapResources[0])[1];
    const entitiesPrefix = `maps/${mapName}/entities/`;
    const entityResources = archive.files.filter(filename => filename.startsWith(entitiesPrefix)
        && filename.endsWith('.vents_c') && (filename === `${entitiesPrefix}default_ents.vents_c`
            || baseLayerPattern.test(path.posix.basename(filename))))
        .sort((a, b) => a === `${entitiesPrefix}default_ents.vents_c` ? -1
            : b === `${entitiesPrefix}default_ents.vents_c` ? 1 : a.localeCompare(b));
    const defaultEntityPath = `${entitiesPrefix}default_ents.vents_c`;
    if (entityResources[0] !== defaultEntityPath) throw new Error(`Map archive has no ${defaultEntityPath} resource.`);
    const navigationPath = `maps/${mapName}.gnv`;
    const hasNavigation = archive.files.includes(navigationPath);
    const outputFiles = ['mapdata.json', 'fow_blockers.json', 'source.json', 'npc_dota_spawner.json',
        'path_corner.json', ...(hasNavigation ? ['gridnav.gnv'] : [])];
    fs.mkdirSync(outputDirectory, { recursive: true });
    const navigationOutput = path.join(outputDirectory, 'gridnav.gnv');
    if (!overwrite) {
        const existing = outputFiles.filter(filename => fs.existsSync(path.join(outputDirectory, filename)));
        if (!hasNavigation && fs.existsSync(navigationOutput)) existing.push('gridnav.gnv (not present in archive)');
        if (existing.length) throw new Error(`Refusing to overwrite ${existing.join(', ')}; pass --overwrite explicitly.`);
    }
    else if (!hasNavigation && fs.existsSync(navigationOutput)) {
        fs.unlinkSync(navigationOutput);
    }

    const mapdataOutput = path.join(outputDirectory, 'mapdata.json');
    let previousMapdata;
    if (overwrite && fs.existsSync(mapdataOutput)) {
        try {
            previousMapdata = JSON.parse(fs.readFileSync(mapdataOutput, 'utf8'));
        }
        catch (error) {
            throw new Error(`Existing ${mapdataOutput} is not valid JSON; refusing to replace it.`, { cause: error });
        }
    }

    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dota-mapdata-'));
    try {
        const allEntities = [];
        const entitySources = [];
        const neutralEntities = [];
        for (const [index, resourcePath] of entityResources.entries()) {
            const bytes = archive.read(resourcePath);
            const dump = decodeEntityResource(resourceTool, resourcePath, bytes, tempDirectory, index);
            const decodedEntities = parseSource2EntityDump(dump);
            if (!decodedEntities.length) throw new Error(`No map entities decoded from ${resourcePath}.`);
            allEntities.push(...decodedEntities);
            if (decodedEntities.some(entity => entity.classname === 'trigger_multiple'
                || entity.classname === 'npc_dota_neutral_spawner')) {
                neutralEntities.push(...parseNeutralSpawnEntities(dump));
            }
            entitySources.push({ path: resourcePath, bytes: bytes.length, sha256: sha256(bytes) });
        }
        const { mapdata, blockers } = buildMapData(allEntities);
        const laneGeometry = buildLaneGeometry(allEntities);
        const defaultSource = entitySources.find(resource => resource.path === defaultEntityPath);
        const navBytes = hasNavigation ? archive.read(navigationPath) : null;
        const navHash = navBytes ? sha256(navBytes) : null;
        if (blockers.length === 0) throw new Error('The selected map has no FOW blocker nodes.');

        if (mapdata.data.npc_dota_neutral_spawner?.length) {
            const models = new Map();
            const triggers = neutralEntities.filter(entity => entity.classname === 'trigger_multiple'
                && entity.targetname.startsWith('[PR#]neutralcamp_'));
            const modelPaths = [...new Set(triggers.map(trigger => trigger.model))].sort();
            for (const [index, modelPath] of modelPaths.entries()) {
                const physicsPath = physicsResourceForModel(modelPath);
                const compiledModelPath = `${modelPath}_c`;
                const resourcePath = archive.files.includes(physicsPath) ? physicsPath
                    : archive.files.includes(compiledModelPath) ? compiledModelPath : null;
                if (!resourcePath) throw new Error(`Missing neutral camp collision resources ${physicsPath} and ${compiledModelPath} in the selected map archive.`);
                const bytes = archive.read(resourcePath);
                const input = path.join(tempDirectory, `physics-${index}${path.extname(resourcePath)}`);
                fs.writeFileSync(input, bytes, { flag: 'wx' });
                const text = decode(resourceTool, input, ['-b', resourcePath === physicsPath ? 'DATA' : 'PHYS']);
                try {
                    models.set(modelPath, { ...parseSource2PhysicsHull(text), sha256: sha256(bytes), sourcePath: resourcePath });
                }
                catch (error) {
                    throw new Error(`Could not parse neutral camp collision geometry from ${resourcePath}: ${error.message}`, {
                        cause: error,
                    });
                }
            }
            let toolVersion;
            try {
                toolVersion = execFileSync(resourceTool, ['--version'], { windowsHide: true, encoding: 'utf8',
                    maxBuffer: 1024 * 1024, timeout: 15_000 }).trim();
            }
            catch (error) {
                throw new Error(`Could not read Source 2 Viewer version: ${error.message}`, { cause: error });
            }
            const source = {
                patch,
                gameClientVersion: gameClientVersion ?? preservedGameClientVersion(previousMapdata, defaultSource.sha256, navHash),
                gridnavSha256: navHash,
                archiveSha256: fileSha256(archivePath),
                entityResource: { path: defaultSource.path, sha256: defaultSource.sha256 },
                source2ViewerCli: toolVersion,
                source2ViewerCliSha256: fileSha256(resourceTool),
            };
            const boxes = buildNeutralSpawnBoxes({ camps: mapdata.data.npc_dota_neutral_spawner,
                entities: neutralEntities, models, source });
            Object.assign(mapdata, mergeNeutralSpawnBoxes(mapdata, boxes));
        }

        preserveMapDataAnnotations(mapdata, previousMapdata);

        const archiveName = path.basename(archivePath);
        const sourceManifest = {
            patch,
            mapName,
            gameClientVersion: gameClientVersion ?? preservedGameClientVersion(previousMapdata, defaultSource.sha256, navHash),
            archive: archiveName,
            archiveSha256: fileSha256(archivePath),
            resources: {
                entities: { path: defaultSource.path, available: true, bytes: defaultSource.bytes,
                    sha256: defaultSource.sha256 },
                entityLayers: entitySources.filter(resource => resource.path !== defaultEntityPath),
                navigation: navBytes ? { path: navigationPath, available: true, bytes: navBytes.length,
                    sha256: navHash } : { path: navigationPath, available: false },
                map: { path: mapResources[0], available: true, bytes: archive.read(mapResources[0]).length,
                    sha256: sha256(archive.read(mapResources[0])) },
                fowBlockers: { source: defaultSource.path, count: blockers.length },
            },
            dataCoverage: {
                mapEntityLocations: 'mapdata.json:data (all exported entity classes; empty arrays mean zero entities)',
                neutralSpawnPolygons: 'mapdata.json:data.trigger_multiple',
                laneGeometry: "npc_dota_spawner.json and path_corner.json from this archive entity resources",
                fowBlockerPoints: 'fow_blockers.json',
                navigationGrid: navBytes ? 'gridnav.gnv' : null,
                terrainHeights: 'not-included: capture from a loaded map in Dota 2 Tools',
                unitStats: 'not-included: not present in the versioned map archive',
                patchSpecificDerivedData: 'not generated by this VPK import; requires each layer\'s matching capture or game resources',
            },
            mapEntityCounts: Object.fromEntries(Object.entries(mapdata.data)
                .filter(([, value]) => Array.isArray(value)).map(([classname, value]) => [classname, value.length])),
        };
        const artifacts = new Map([
            ['mapdata.json', Buffer.from(JSON.stringify(mapdata))],
            ['fow_blockers.json', Buffer.from(JSON.stringify({ source: { file: defaultSource.path,
                sha256: defaultSource.sha256 }, points: blockers }))],
            ['npc_dota_spawner.json', Buffer.from(`${JSON.stringify(laneGeometry.spawners)}\n`)],
            ['path_corner.json', Buffer.from(`${JSON.stringify(laneGeometry.paths)}\n`)],
            ['source.json', Buffer.from(`${JSON.stringify(sourceManifest, null, 2)}\n`)],
        ]);
        if (navBytes) artifacts.set('gridnav.gnv', navBytes);
        for (const [filename, bytes] of artifacts) writeAtomic(path.join(outputDirectory, filename), bytes);
        return {
            patch, mapName, treeCount: mapdata.data.ent_dota_tree.length,
            campCount: mapdata.data.npc_dota_neutral_spawner?.length || 0,
            fowBlockerCount: blockers.length, hasNavigation, laneCount: laneGeometry.spawners.features.length,
            written: [...artifacts.keys()].map(filename => path.join(outputDirectory, filename)),
        };
    }
    finally {
        fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
}

function main(argv = process.argv.slice(2)) {
    const { values } = parseArgs({ args: argv, options: {
        patch: { type: 'string' }, archive: { type: 'string' }, 'resource-tool': { type: 'string' },
        'game-client-version': { type: 'string' }, output: { type: 'string' }, overwrite: { type: 'boolean' },
    } });
    const result = importMapData({ patch: values.patch, archivePath: values.archive,
        resourceTool: values['resource-tool'], outputDirectory: values.output, overwrite: values.overwrite,
        gameClientVersion: values['game-client-version'] ?? null });
    console.log(`${result.patch} (${result.mapName}): ${result.treeCount} trees, ${result.campCount} camps, `
        + `${result.fowBlockerCount} FOW blockers${result.hasNavigation ? ', navigation grid included' : ', no navigation grid in archive'}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        main();
    }
    catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
