// Import fixed Watcher positions and sight ranges from the installed map.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { openVpk, parseKeyValues, resolveGameDirectory } from '../src/node/game-files.mjs';

export function readWatchers(entities, units) {
    const positions = [...entities.matchAll(/classname\s*=\s*"npc_dota_lantern"\s+compile_source_id\s*=\s*\d+\s+origin\s*=\s*\[([^\]]+)\]/g)]
        .map(match => match[1].split(',').map(Number));
    const expected = [...entities.matchAll(/classname\s*=\s*"npc_dota_lantern"/g)].length;
    const unit = units.DOTAUnits?.npc_dota_lantern;
    const dayVision = Number(unit?.VisionDaytimeRange);
    const nightVision = Number(unit?.VisionNighttimeRange);
    if (!expected || positions.length !== expected
        || positions.some(position => position.length !== 3 || !position.every(Number.isFinite))
        || new Set(positions.map(position => position.slice(0, 2).join(','))).size !== expected
        || ![dayVision, nightVision].every(value => Number.isFinite(value) && value > 0)) {
        throw new Error('Incomplete Watcher positions or sight ranges in game resources');
    }
    positions.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    return { unitClass: 'npc_dota_lantern', dayVision, nightVision, positions };
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function importWatchers({ patch, resourceTool, game: gameDirectory, assetDirectory = path.join(root, 'assets'),
    captureDirectory = path.join(root, 'map-captures', patch, 'watchers') } = {}) {
    if (!patch || !/^[a-z0-9]+$/iu.test(patch)) throw new Error('A valid patch ID is required.');
    if (!resourceTool) throw new Error('Set resourceTool to the Source2Viewer CLI path.');
    const directory = path.join(assetDirectory, 'data', patch);
    const game = resolveGameDirectory(gameDirectory);
    const map = openVpk(path.join(game, 'dota/maps/dota.vpk'));
    const archive = openVpk(path.join(game, 'dota/pak01_dir.vpk'));
    const hash = bytes => createHash('sha256').update(bytes).digest('hex');
    const gridnavSha256 = hash(map.read('maps/dota.gnv'));
    if (gridnavSha256 !== hash(fs.readFileSync(path.join(directory, 'gridnav.gnv')))) {
        throw new Error('Installed map differs from this patch; update map data first');
    }
    const entityBytes = map.read('maps/dota/entities/default_ents.vents_c');
    const unitsBytes = archive.read('scripts/npc/npc_units.txt');
    fs.mkdirSync(captureDirectory, { recursive: true });
    const input = path.join(captureDirectory, 'default_ents.vents_c');
    fs.writeFileSync(input, entityBytes);
    const entities = execFileSync(resourceTool, ['-i', input, '-b', 'DATA'],
        { windowsHide: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 60_000 });
    const data = readWatchers(entities, parseKeyValues(unitsBytes.toString('utf8')));
    data.source = { gridnavSha256, mapEntitiesSha256: hash(entityBytes), unitsSha256: hash(unitsBytes),
        entities: 'maps/dota/entities/default_ents.vents_c', units: 'scripts/npc/npc_units.txt' };
    fs.writeFileSync(path.join(directory, 'watchers.json'), `${JSON.stringify(data, null, 2)}\n`);
    console.log(`Imported ${data.positions.length} Watchers (${data.dayVision}/${data.nightVision} day/night vision).`);
    return data;
}

function main(argv = process.argv.slice(2)) {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
        game: { type: 'string' }, 'resource-tool': { type: 'string' },
    } });
    const [patch] = positionals;
    if (positionals.length !== 1) throw new Error('Usage: npm run import:watchers -- <patch> --resource-tool <Source2Viewer-CLI> [--game <directory>]');
    importWatchers({ patch, resourceTool: values['resource-tool'], game: values.game });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
