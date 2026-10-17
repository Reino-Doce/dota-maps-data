import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { openVpk, resolveGameDirectory } from '../src/node/game-files.mjs';
import { defaultMeshGroups, readModelTriangles, projectModelFootprint, pitFootprint } from './structure-footprints.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const structureClasses = ['npc_dota_lotus_pool', 'npc_dota_unit_twin_gate', 'npc_dota_watch_tower'];

function hashFile(filename) {
    const digest = createHash('sha256');
    const fd = fs.openSync(filename, 'r');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    try {
        let bytesRead;
        while ((bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) digest.update(buffer.subarray(0, bytesRead));
    }
    finally {
        fs.closeSync(fd);
    }
    return digest.digest('hex');
}

export function validateStructureCapture(patch, source, terrain, mapData, navigationSha256) {
    if (source.patch !== patch || terrain.source?.patch !== patch
        || terrain.source.mapArchiveSha256 !== source.archiveSha256
        || terrain.source.mapResource !== source.resources?.map?.path
        || terrain.source.mapEntitiesSha256 !== (source.resources?.entities?.sha256 || null)
        || terrain.source.navigationSha256 !== navigationSha256) {
        throw new Error('Terrain capture does not match this patch source.json; refusing to combine structure data from another version.');
    }
    if (!Array.isArray(terrain.entities) || !Array.isArray(terrain.pits)) {
        throw new Error('Terrain capture is missing runtime structure entities or Tormentor pit traces.');
    }
    for (const classname of structureClasses) {
        const expected = mapData.data?.[classname];
        const captured = terrain.entities.filter(entity => entity.classname === classname);
        // mapdata.json stores X/Y for these entities; runtime captures also
        // have a Z origin, which has no matching archive field.
        const positions = rows => new Set(rows.map(({ x, y, origin }) =>
            (origin || [x, y]).slice(0, 2).map(value => Math.fround(value)).join(',')));
        if (!Array.isArray(expected) || captured.length !== expected.length
            || positions(expected).size !== expected.length || positions(captured).size !== captured.length
            || [...positions(captured)].some(position => !positions(expected).has(position))) {
            throw new Error(`Runtime ${classname} positions do not match ${patch} mapdata.json; recapture the exact patch.`);
        }
    }
}

/** Generate ward-blocking footprints for one prepared map patch. */
export function importStructureFootprints({ patch, resourceTool, modelArchive: modelArchiveInput, game: gameDirectory,
    assetDirectory = path.join(root, 'assets'), captureDirectory = path.join(root, 'map-captures', patch, 'structure-models') } = {}) {
    if (!patch || !/^[a-z0-9]+$/iu.test(patch)) throw new Error('A valid patch ID is required.');
    const directory = path.join(assetDirectory, 'data', patch);
    const source = JSON.parse(fs.readFileSync(path.join(directory, 'source.json'), 'utf8'));
    const navigation = source.resources?.navigation;
    if (source.patch !== patch || navigation?.available !== true || !navigation.path || !navigation.sha256) {
        throw new Error(`Patch ${patch} has no exact native GNV; ward-blocking structure footprints cannot be compiled.`);
    }
    const navigationBytes = fs.readFileSync(path.join(directory, 'gridnav.gnv'));
    const navigationSha256 = hash(navigationBytes);
    if (navigationSha256 !== navigation.sha256) {
        throw new Error('Prepared gridnav.gnv does not match this patch source.json; refusing to scan different navigation.');
    }
    const terrainBytes = fs.readFileSync(path.join(directory, 'terrain_grid.json'));
    const terrain = JSON.parse(terrainBytes);
    const mapData = JSON.parse(fs.readFileSync(path.join(directory, 'mapdata.json'), 'utf8'));
    validateStructureCapture(patch, source, terrain, mapData, navigationSha256);
    const modelEntities = terrain.entities.filter(entity => structureClasses.includes(entity.classname));
    const modelArchivePath = modelArchiveInput ? path.resolve(modelArchiveInput) : null;
    if (modelEntities.length && !modelArchivePath) {
        throw new Error(`Patch ${patch} has ward-blocking structures; provide its prepared game model archive with --model-archive <pak01_dir.vpk>.`);
    }
    if (modelEntities.length && !resourceTool) throw new Error('Set resourceTool to the Source2Viewer CLI path to inspect the structures used by this patch.');
    if (modelArchivePath && !fs.existsSync(modelArchivePath)) throw new Error(`Model archive not found: ${modelArchivePath}`);
    const game = modelEntities.length ? resolveGameDirectory(gameDirectory) : null;
    const modelArchiveSha256 = modelArchivePath ? hashFile(modelArchivePath) : null;
    const archive = modelArchivePath ? openVpk(modelArchivePath) : null;
    fs.mkdirSync(captureDirectory, { recursive: true });
    const output = fs.mkdtempSync(path.join(captureDirectory, 'run-'));
    const models = new Map();
    const features = [];
    for (const entity of modelEntities) {
        if (!/^models\/[a-zA-Z0-9_/.\-]+\.vmdl$/u.test(entity.model) || entity.model.includes('..')
            || !Number.isFinite(entity.modelScale) || entity.modelScale <= 0
            || entity.angles?.length !== 3 || !entity.angles.every(Number.isFinite)) throw new Error('Invalid scanned model placement.');
        if (!models.has(entity.model)) {
            const bytes = archive.read(`${entity.model}_c`);
            const input = path.join(output, `${models.size}.vmdl_c`);
            const glb = path.join(output, `${models.size}.glb`);
            fs.writeFileSync(input, bytes);
            const modelData = execFileSync(resourceTool, ['-i', input, '-b', 'DATA'],
                { windowsHide: true, encoding: 'utf8', timeout: 60_000 });
            execFileSync(resourceTool, ['-i', input, '-o', glb, '-d', '--gltf_export_format', 'glb',
                '--gltf_export_materials', '--game', path.join(game, 'dota/gameinfo.gi')],
            { windowsHide: true, stdio: 'pipe', timeout: 60_000 });
            models.set(entity.model, { sha256: hash(bytes), triangles: readModelTriangles(fs.readFileSync(glb), defaultMeshGroups(modelData)) });
        }
        features.push({ type: 'Feature', properties: { source: 'projected structure model', classname: entity.classname,
            name: entity.name, model: entity.model, center: entity.origin.slice(0, 2) },
        geometry: projectModelFootprint(models.get(entity.model).triangles, entity) });
    }
    for (const pit of terrain.pits) features.push({ type: 'Feature',
        properties: { source: 'traced Tormentor pit', classname: 'npc_dota_miniboss_spawner', name: pit.name, center: pit.center },
        geometry: pitFootprint(pit) });
    const result = { type: 'FeatureCollection', cellSize: 8,
        source: { patch, mapArchiveSha256: source.archiveSha256, navigationPath: navigation.path,
            terrainSha256: hash(terrainBytes), navigationSha256,
            ...(modelArchivePath ? { modelArchive: path.basename(modelArchivePath), modelArchiveSha256 } : {}),
            meshSelection: 'Default bodygroups, opaque structural materials; enclosed bowls filled',
            models: [...models].map(([model, data]) => ({ model, sha256: data.sha256 })) }, features };
    fs.writeFileSync(path.join(directory, 'ward_structures.json'), `${JSON.stringify(result, null, 2)}\n`);
    console.log(`Imported ${features.length} structure footprints at 8-unit resolution from ${models.size} game models and ${terrain.pits.length} pit traces.`);
    return result;
}

function main(argv = process.argv.slice(2)) {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true,
        options: { game: { type: 'string' }, 'resource-tool': { type: 'string' }, 'model-archive': { type: 'string' } } });
    const [patch] = positionals;
    if (positionals.length !== 1) throw new Error('Usage: npm run import:structures -- <patch> --resource-tool <Source2Viewer-CLI> [--model-archive <pak01_dir.vpk>] [--game <directory>]');
    importStructureFootprints({ patch, resourceTool: values['resource-tool'], modelArchive: values['model-archive'], game: values.game });
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
