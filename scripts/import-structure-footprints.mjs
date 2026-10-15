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

/** Generate ward-blocking footprints for one prepared map patch. */
export function importStructureFootprints({ patch, resourceTool, game: gameDirectory,
    assetDirectory = path.join(root, 'assets'), captureDirectory = path.join(root, 'map-captures', patch, 'structure-models') } = {}) {
    if (!patch || !/^[a-z0-9]+$/iu.test(patch)) throw new Error('A valid patch ID is required.');
    if (!resourceTool) throw new Error('Set resourceTool to the Source2Viewer CLI path.');
    const game = resolveGameDirectory(gameDirectory);
    const directory = path.join(assetDirectory, 'data', patch);
    const navigationSha256 = hash(openVpk(path.join(game, 'dota/maps/dota.vpk')).read('maps/dota.gnv'));
    if (navigationSha256 !== hash(fs.readFileSync(path.join(directory, 'gridnav.gnv')))) {
        throw new Error('Installed navigation differs from this patch; refresh the gameplay scan before importing structures.');
    }
    const terrainBytes = fs.readFileSync(path.join(directory, 'terrain_grid.json'));
    const terrain = JSON.parse(terrainBytes);
    if (!structureClasses.every(classname => terrain.entities?.some(entity => entity.classname === classname)) || !terrain.pits?.length) {
        throw new Error('Recapture terrain with structure models and Tormentor pit traces.');
    }
    const archive = openVpk(path.join(game, 'dota/pak01_dir.vpk'));
    fs.mkdirSync(captureDirectory, { recursive: true });
    const output = fs.mkdtempSync(path.join(captureDirectory, 'run-'));
    const models = new Map();
    const features = [];
    for (const entity of terrain.entities.filter(value => structureClasses.includes(value.classname))) {
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
        source: { terrainSha256: hash(terrainBytes), navigationSha256,
            meshSelection: 'Default bodygroups, opaque structural materials; enclosed bowls filled',
            models: [...models].map(([model, data]) => ({ model, sha256: data.sha256 })) }, features };
    fs.writeFileSync(path.join(directory, 'ward_structures.json'), JSON.stringify(result));
    console.log(`Imported ${features.length} structure footprints at 8-unit resolution from ${models.size} game models and ${terrain.pits.length} pit traces.`);
    return result;
}

function main(argv = process.argv.slice(2)) {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true,
        options: { game: { type: 'string' }, 'resource-tool': { type: 'string' } } });
    const [patch] = positionals;
    if (positionals.length !== 1) throw new Error('Usage: npm run import:structures -- <patch> --resource-tool <Source2Viewer-CLI> [--game <directory>]');
    importStructureFootprints({ patch, resourceTool: values['resource-tool'], game: values.game });
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
