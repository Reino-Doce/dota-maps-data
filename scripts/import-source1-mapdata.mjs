// Extract versioned map locations from a compiled Source 1 Dota BSP. Importing this module is inert.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const patchPattern = /^[a-z0-9]+(?:_[a-z0-9]+)*$/iu;
const campNamePattern = /^neutralcamp_(?:good|evil)_\d+$/iu;
const campTypes = ['small', 'medium', 'large', 'ancient'];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function readLump(bsp, index) {
    if (!Buffer.isBuffer(bsp) || bsp.length < 8 + 64 * 16 || bsp.toString('ascii', 0, 4) !== 'VBSP') {
        throw new Error('Input is not a complete Source 1 VBSP map.');
    }
    if (!Number.isInteger(index) || index < 0 || index >= 64) throw new Error('Invalid BSP lump index.');
    const offset = 8 + index * 16;
    const fileOffset = bsp.readInt32LE(offset);
    const fileLength = bsp.readInt32LE(offset + 4);
    if (fileOffset < 0 || fileLength < 0 || fileOffset + fileLength > bsp.length) {
        throw new Error(`BSP lump ${index} points outside the map file.`);
    }
    return bsp.subarray(fileOffset, fileOffset + fileLength);
}

function tokenizeKeyValues(source) {
    const tokens = [];
    const tokenPattern = /"(?:\\.|[^"\\])*"|[{}]/gu;
    let cursor = 0;
    for (const match of source.matchAll(tokenPattern)) {
        if (source.slice(cursor, match.index).trim()) throw new Error('Unsupported text in Source 1 BSP entity lump.');
        tokens.push(match[0]);
        cursor = match.index + match[0].length;
    }
    if (source.slice(cursor).trim()) throw new Error('Unsupported trailing text in Source 1 BSP entity lump.');
    return tokens;
}

function unquote(value) {
    if (!value.startsWith('"') || !value.endsWith('"')) throw new Error('Source 1 BSP entity fields must be quoted.');
    return value.slice(1, -1).replace(/\\(["\\])/gu, '$1');
}

export function parseSource1EntityLump(bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new Error('Source 1 BSP entity lump is empty.');
    const source = bytes.toString('latin1').replace(/\0+$/u, '');
    const tokens = tokenizeKeyValues(source);
    const entities = [];
    let cursor = 0;
    while (cursor < tokens.length) {
        if (tokens[cursor] !== '{') throw new Error('Expected an entity block in the Source 1 BSP entity lump.');
        cursor += 1;
        const entity = Object.create(null);
        let depth = 1;
        while (cursor < tokens.length && depth > 0) {
            if (tokens[cursor] === '{') {
                depth += 1;
                cursor += 1;
                continue;
            }
            if (tokens[cursor] === '}') {
                depth -= 1;
                cursor += 1;
                continue;
            }
            const key = unquote(tokens[cursor]).toLowerCase();
            cursor += 1;
            if (cursor >= tokens.length || tokens[cursor] === '{' || tokens[cursor] === '}') {
                throw new Error(`Source 1 BSP entity has no value for ${key}.`);
            }
            const value = unquote(tokens[cursor]);
            cursor += 1;
            if (depth === 1) {
                if (Object.hasOwn(entity, key)) {
                    entity[key] = Array.isArray(entity[key]) ? [...entity[key], value] : [entity[key], value];
                }
                else entity[key] = value;
            }
        }
        if (depth !== 0) throw new Error('Unclosed Source 1 BSP entity block.');
        if (typeof entity.classname === 'string') entities.push(entity);
    }
    if (!entities.length) throw new Error('Source 1 BSP entity lump contains no entities.');
    return entities;
}

export function parseSource1Models(bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length % 48 !== 0) {
        throw new Error('Source 1 BSP model lump has an invalid length.');
    }
    const models = [];
    for (let offset = 0; offset < bytes.length; offset += 48) {
        const values = Array.from({ length: 9 }, (_, index) => bytes.readFloatLE(offset + index * 4));
        const integers = Array.from({ length: 3 }, (_, index) => bytes.readInt32LE(offset + 36 + index * 4));
        if (![...values, ...integers].every(Number.isFinite)) throw new Error('Source 1 BSP model lump has invalid bounds.');
        models.push({ min: values.slice(0, 3), max: values.slice(3, 6), origin: values.slice(6, 9),
            headnode: integers[0], firstface: integers[1], numfaces: integers[2] });
    }
    return models;
}

export function parseSource1Vector(value, fieldName) {
    if (typeof value !== 'string') throw new Error(`Source 1 BSP entity is missing ${fieldName}.`);
    const parts = value.trim().split(/\s+/u).map(Number);
    if (parts.length !== 3 || !parts.every(Number.isFinite)) throw new Error(`Invalid Source 1 BSP ${fieldName} vector.`);
    return parts;
}

function mapCoordinate(entity, withZ = false) {
    const [x, y, z] = parseSource1Vector(entity.origin, `${entity.classname} origin`);
    return withZ ? { x, y, z } : { x, y };
}

function entitySet(entities, classname) {
    return entities.filter(entity => entity.classname === classname);
}

function indexForBrushModel(value, models) {
    const match = /^\*(\d+)$/u.exec(value || '');
    if (!match || Number(match[1]) >= models.length) throw new Error('A Source 1 brush entity references an invalid BSP model.');
    return Number(match[1]);
}

function minimumPairing(spawners, triggers) {
    if (spawners.length !== triggers.length || !spawners.length) {
        throw new Error('The Source 1 map has mismatched neutral spawner and trigger counts.');
    }
    const spawnerPoints = spawners.map(entity => mapCoordinate(entity));
    const triggerPoints = triggers.map(entity => mapCoordinate(entity));
    const costs = spawnerPoints.map(spawner => triggerPoints.map(trigger =>
        (spawner.x - trigger.x) ** 2 + (spawner.y - trigger.y) ** 2));
    const memo = new Map();
    const solve = (spawnerIndex, mask) => {
        if (spawnerIndex === spawners.length) return { cost: 0, indices: [] };
        const key = `${spawnerIndex}:${mask}`;
        if (memo.has(key)) return memo.get(key);
        let best = null;
        for (let triggerIndex = 0; triggerIndex < triggers.length; triggerIndex += 1) {
            if (mask & (1 << triggerIndex)) continue;
            const next = solve(spawnerIndex + 1, mask | (1 << triggerIndex));
            const candidate = { cost: costs[spawnerIndex][triggerIndex] + next.cost,
                indices: [triggerIndex, ...next.indices] };
            if (!best || candidate.cost < best.cost) best = candidate;
        }
        memo.set(key, best);
        return best;
    };
    const result = solve(0, 0);
    return spawners.map((spawner, index) => {
        const trigger = triggers[result.indices[index]];
        const distance = Math.sqrt(costs[index][result.indices[index]]);
        if (distance > 512) throw new Error('A Source 1 neutral spawner is too far from its nearest trigger to associate safely.');
        return { spawner, trigger, distance };
    });
}

function boxPoints(trigger, model) {
    const [originX, originY, originZ] = parseSource1Vector(trigger.origin, 'neutral trigger origin');
    const yaw = Number((trigger.angles || '0 0 0').trim().split(/\s+/u)[1] || 0);
    if (!Number.isFinite(yaw)) throw new Error('Invalid Source 1 neutral trigger yaw.');
    const radians = yaw * Math.PI / 180;
    const centerX = originX + model.origin[0];
    const centerY = originY + model.origin[1];
    const centerZ = originZ + model.origin[2];
    const rotate = (x, y) => [centerX + x * Math.cos(radians) - y * Math.sin(radians),
        centerY + x * Math.sin(radians) + y * Math.cos(radians)];
    const corners = [[model.min[0], model.min[1]], [model.max[0], model.min[1]],
        [model.max[0], model.max[1]], [model.min[0], model.max[1]]].map(([x, y]) => rotate(x, y));
    const minZ = model.min[2] + centerZ;
    const maxZ = model.max[2] + centerZ;
    const xs = corners.map(([x]) => x);
    const ys = corners.map(([, y]) => y);
    const min = [Math.min(...xs), Math.min(...ys), minZ];
    const max = [Math.max(...xs), Math.max(...ys), maxZ];
    const vertices = [...corners.map(([x, y]) => [x, y, maxZ]), ...corners.map(([x, y]) => [x, y, minZ])];
    return { points: corners.map(([x, y]) => ({ x, y })), vertices,
        localBounds: { min: [...model.min], max: [...model.max] }, worldBounds: { min, max },
        transform: { origin: [centerX, centerY, centerZ], angles: [0, yaw, 0] } };
}

export function buildSource1MapData(entities, models, bspSha256) {
    if (!Array.isArray(entities) || !Array.isArray(models) || !/^[a-f0-9]{64}$/iu.test(bspSha256 || '')) {
        throw new TypeError('Source 1 entities, BSP models, and a verified BSP checksum are required.');
    }
    const worldspawn = entitySet(entities, 'worldspawn');
    if (worldspawn.length !== 1) throw new Error('The Source 1 BSP must contain exactly one worldspawn entity.');
    const world = worldspawn[0];
    const min = parseSource1Vector(world.world_mins, 'world_mins');
    const max = parseSource1Vector(world.world_maxs, 'world_maxs');
    if (max.some((value, index) => value <= min[index])) throw new Error('The Source 1 world bounds are inverted.');

    const data = Object.create(null);
    const trees = new Map();
    for (const entity of entitySet(entities, 'ent_dota_tree')) {
        const point = mapCoordinate(entity, true);
        trees.set(`${point.x},${point.y},${point.z}`, point);
    }
    if (!trees.size) throw new Error('The Source 1 map contains no tree entities.');
    data.ent_dota_tree = [...trees.values()];

    const pairedCamps = minimumPairing(entitySet(entities, 'npc_dota_neutral_spawner'),
        entitySet(entities, 'trigger_multiple').filter(entity => campNamePattern.test(entity.targetname || '')));
    data.npc_dota_neutral_spawner = pairedCamps.map(({ spawner, trigger }) => ({
        ...mapCoordinate(spawner), triggerName: trigger.targetname,
        ...(spawner.neutraltype === undefined ? {} : { neutralType: spawner.neutraltype }),
    }));
    data.trigger_multiple = pairedCamps.map(({ trigger }) => {
        const model = models[indexForBrushModel(trigger.model, models)];
        const geometry = boxPoints(trigger, model);
        const neutralType = pairedCamps.find(pair => pair.trigger === trigger)?.spawner.neutraltype;
        return {
            campId: trigger.targetname,
            triggerName: trigger.targetname,
            targetname: trigger.targetname,
            ...(neutralType === undefined ? {} : { campType: campTypes[Number(neutralType)] || 'unknown' }),
            ...geometry,
            geometrySource: { kind: 'source1-bsp-model-bounds', modelIndex: indexForBrushModel(trigger.model, models),
                bspSha256 },
        };
    }).sort((first, second) => first.campId.localeCompare(second.campId));

    for (const entity of entitySet(entities, 'npc_dota_tower')) {
        const match = /_tower([1-4])(?:_|$)/iu.exec(entity.targetname || '');
        if (!match) throw new Error('A Source 1 tower has no tier in its target name.');
        (data.npc_dota_tower ||= []).push({ ...mapCoordinate(entity), subType: `tower${match[1]}` });
    }
    for (const entity of entitySet(entities, 'npc_dota_barracks')) {
        const name = `${entity.targetname || ''} ${entity.model || ''}`;
        const subtype = /melee/iu.test(name) ? 'melee' : /range|ranged/iu.test(name) ? 'range' : null;
        if (!subtype) throw new Error('A Source 1 barracks has no melee/ranged identity.');
        (data.npc_dota_barracks ||= []).push({ ...mapCoordinate(entity), subType: subtype });
    }
    for (const entity of entitySet(entities, 'npc_dota_building')) {
        if (/filler/iu.test(entity.targetname || '')) (data.npc_dota_filler ||= []).push(mapCoordinate(entity));
        else if (/healer/iu.test(entity.targetname || '')) (data.npc_dota_healer ||= []).push(mapCoordinate(entity));
        else throw new Error(`Unclassified Source 1 building ${entity.targetname || '(unnamed)'}.`);
    }
    for (const classname of ['ent_dota_fountain', 'npc_dota_fort', 'ent_dota_shop', 'dota_item_rune_spawner',
        'npc_dota_roshan_spawner', 'npc_dota_spawner']) {
        const found = entitySet(entities, classname);
        if (found.length) data[classname] = found.map(entity => mapCoordinate(entity));
    }
    const pathCorners = entitySet(entities, 'path_corner');
    if (pathCorners.length) data.path_corner = pathCorners.map(entity => ({
        ...mapCoordinate(entity, true), targetname: entity.targetname || '', target: entity.target || '',
    }));

    const worlddata = { worldMinX: min[0], worldMaxX: max[0], worldMinY: min[1], worldMaxY: max[1] };
    return {
        mapdata: { data, stats: {} },
        worlddata,
        coverage: {
            entityCount: entities.length,
            treeEntityCount: entitySet(entities, 'ent_dota_tree').length,
            uniqueTreeCount: trees.size,
            neutralSpawnerCount: pairedCamps.length,
            neutralTriggerCount: pairedCamps.length,
            neutralAssociations: pairedCamps.map(({ spawner, trigger, distance }) => ({
                triggerName: trigger.targetname, distance, inferredBy: 'minimum-total-XY-distance',
                hasNeutralType: spawner.neutraltype !== undefined,
            })),
            unsupportedMapFeatures: ['building vision', 'fog-of-war blockers', 'ward restrictions', 'Watchers',
                'Eyes vision', 'terrain heights', 'terrain skins'],
        },
    };
}

function parseSteamInfo(source) {
    const values = Object.create(null);
    for (const line of source.split(/\r?\n/u)) {
        const match = /^\s*([A-Za-z][A-Za-z0-9]*)\s*=\s*(.*?)\s*$/u.exec(line);
        if (match) values[match[1].toLowerCase()] = match[2];
    }
    return {
        productName: values.productname || null,
        appId: values.appid || null,
        patchVersion: values.patchversion || null,
        clientVersion: values.clientversion || null,
    };
}

function fileInfo(filename, root, bytes = fs.readFileSync(filename)) {
    return { path: path.relative(root, filename).replaceAll('\\', '/'), bytes: bytes.length, sha256: sha256(bytes) };
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

export function importSource1MapData({ patch, mapPath, outputDirectory, overwrite = false } = {}) {
    if (typeof patch !== 'string' || !patchPattern.test(patch)) throw new Error('Pass a valid Source 1 map ID with --patch.');
    if (typeof mapPath !== 'string' || !path.isAbsolute(mapPath) || !fs.existsSync(mapPath)) {
        throw new Error('Pass --map with an existing absolute Source 1 .bsp file.');
    }
    if (path.extname(mapPath).toLowerCase() !== '.bsp') throw new Error('The Source 1 map input must be a .bsp file.');
    if (typeof outputDirectory !== 'string' || !path.isAbsolute(outputDirectory)) {
        throw new Error('Pass --output with an absolute patch data directory.');
    }

    const mapBytes = fs.readFileSync(mapPath);
    const bspVersion = mapBytes.readInt32LE(4);
    const entities = parseSource1EntityLump(readLump(mapBytes, 0));
    const models = parseSource1Models(readLump(mapBytes, 14));
    const mapHash = sha256(mapBytes);
    const result = buildSource1MapData(entities, models, mapHash);
    const mapDirectory = path.dirname(mapPath);
    const gameDirectory = path.dirname(mapDirectory);
    const sourceRoot = path.dirname(gameDirectory);
    const navPath = path.join(mapDirectory, `${path.basename(mapPath, '.bsp')}.gnv`);
    const steamInfoPath = path.join(gameDirectory, 'steam.inf');
    const sourceFiles = { map: fileInfo(mapPath, sourceRoot) };
    if (fs.existsSync(navPath)) sourceFiles.navigation = fileInfo(navPath, sourceRoot);
    if (fs.existsSync(steamInfoPath)) sourceFiles.steamInfo = fileInfo(steamInfoPath, sourceRoot);
    const steamInfo = fs.existsSync(steamInfoPath)
        ? parseSteamInfo(fs.readFileSync(steamInfoPath, 'utf8')) : null;
    const source = {
        patch,
        sourceEngine: 'Source 1',
        sourceId: patch,
        mapName: path.basename(mapPath, '.bsp'),
        bspVersion,
        steamInfo,
        files: sourceFiles,
        coverage: result.coverage,
    };
    const outputFiles = ['mapdata.json', 'worlddata.json', 'source.json',
        ...(sourceFiles.navigation ? ['gridnav.gnv'] : [])];
    fs.mkdirSync(outputDirectory, { recursive: true });
    const existing = outputFiles.filter(filename => fs.existsSync(path.join(outputDirectory, filename)));
    if (!sourceFiles.navigation && fs.existsSync(path.join(outputDirectory, 'gridnav.gnv'))) {
        existing.push('gridnav.gnv (not present in source)');
    }
    if (existing.length && !overwrite) throw new Error(`Refusing to overwrite ${existing.join(', ')}; pass --overwrite.`);
    if (overwrite && !sourceFiles.navigation && fs.existsSync(path.join(outputDirectory, 'gridnav.gnv'))) {
        fs.unlinkSync(path.join(outputDirectory, 'gridnav.gnv'));
    }

    const artifacts = new Map([
        ['mapdata.json', Buffer.from(`${JSON.stringify(result.mapdata)}\n`)],
        ['worlddata.json', Buffer.from(`${JSON.stringify(result.worlddata, null, 2)}\n`)],
        ['source.json', Buffer.from(`${JSON.stringify(source, null, 2)}\n`)],
    ]);
    if (sourceFiles.navigation) artifacts.set('gridnav.gnv', fs.readFileSync(navPath));
    for (const [name, bytes] of artifacts) writeAtomic(path.join(outputDirectory, name), bytes);
    return { patch, bspVersion, entityCount: entities.length, treeCount: result.coverage.uniqueTreeCount,
        campCount: result.coverage.neutralTriggerCount, hasNavigation: Boolean(sourceFiles.navigation),
        written: [...artifacts.keys()].map(name => path.join(outputDirectory, name)) };
}

function main(argv = process.argv.slice(2)) {
    const { values } = parseArgs({ args: argv, options: {
        patch: { type: 'string' }, map: { type: 'string' }, output: { type: 'string' }, overwrite: { type: 'boolean' },
    } });
    const result = importSource1MapData({ patch: values.patch, mapPath: path.resolve(values.map || ''),
        outputDirectory: path.resolve(values.output || ''), overwrite: values.overwrite });
    console.log(`${result.patch} (BSP ${result.bspVersion}): ${result.entityCount} entities, `
        + `${result.treeCount} unique trees, ${result.campCount} neutral camps`
        + `${result.hasNavigation ? ', navigation grid included' : ', no navigation grid found'}.`);
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
