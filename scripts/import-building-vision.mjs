// Read compiled map instances as well as unit definitions: a filler is placed
// as npc_dota_building, so filtering only entity classnames loses base buildings.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { openVpk, parseKeyValues, resolveGameDirectory } from '../src/node/game-files.mjs';

const classes = new Set(['npc_dota_tower', 'npc_dota_barracks', 'npc_dota_fort',
    'npc_dota_filler', 'ent_dota_fountain', 'npc_dota_watch_tower',
    'npc_dota_unit_twin_gate', 'npc_dota_lotus_pool', 'npc_dota_xp_fountain']);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function readBuildings(entities, units) {
    const buildings = [];
    for (const match of entities.matchAll(/\bvalues\s*=\s*\{([^{}]*)\}/g)) {
        const body = match[1];
        const field = name => body.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`))?.[1];
        const name = field('MapUnitName');
        const unit = units.DOTAUnits?.[name];
        const placedClass = field('classname');
        const unitClass = classes.has(placedClass) ? placedClass : unit?.BaseClass;
        if (!classes.has(unitClass)) continue;
        const position = body.match(/\borigin\s*=\s*\[([^\]]+)\]/)?.[1].split(',').map(Number);
        const id = field('hammerUniqueId');
        const dayVision = Number(unit?.VisionDaytimeRange);
        const nightVision = Number(unit?.VisionNighttimeRange);
        let team = { 2: 'radiant', 3: 'dire', 4: 'neutral' }[field('teamnumber')]
            || { DOTA_TEAM_GOODGUYS: 'radiant', DOTA_TEAM_BADGUYS: 'dire', DOTA_TEAM_NEUTRALS: 'neutral' }[unit?.TeamName];
        // These classes have engine-assigned teams, overriding the generic NPC
        // template. Verified against GetTeamNumber() on the loaded default map.
        if (['npc_dota_unit_twin_gate', 'npc_dota_lotus_pool', 'npc_dota_xp_fountain'].includes(unitClass)) team = 'neutral';
        if (unitClass === 'npc_dota_watch_tower') {
            team = { '#DOTA_OutpostName_North': 'dire', '#DOTA_OutpostName_South': 'radiant' }[field('OutpostName')];
        }
        if (!id || !team || position?.length !== 3 || !position.every(Number.isFinite)
            || ![dayVision, nightVision].every(value => Number.isFinite(value) && value >= 0)) {
            throw new Error(`Incomplete building data: ${name || unitClass}`);
        }
        buildings.push({ id, unitClass, name, team, position, dayVision, nightVision,
            // Native building auras; these are separate from normal ground sight.
            trueSight: { npc_dota_tower: 700, npc_dota_fort: 900, ent_dota_fountain: 1200 }[unitClass] || 0 });
    }
    if (!buildings.length || new Set(buildings.map(building => building.id)).size !== buildings.length) {
        throw new Error('Missing or duplicate building instances');
    }
    return buildings.sort((a, b) => a.id.localeCompare(b.id));
}

export function importBuildingVision({ patch, resourceTool, game: gameDirectory, assetDirectory = path.join(root, 'assets'),
    captureDirectory = path.join(root, 'map-captures', patch, 'buildings') } = {}) {
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
    const buildings = readBuildings(entities, parseKeyValues(unitsBytes.toString('utf8')));
    const data = { buildings, source: { gridnavSha256, mapEntitiesSha256: hash(entityBytes), unitsSha256: hash(unitsBytes),
        entities: 'maps/dota/entities/default_ents.vents_c', units: 'scripts/npc/npc_units.txt' } };
    fs.writeFileSync(path.join(directory, 'building_vision.json'), `${JSON.stringify(data, null, 2)}\n`);
    console.log(`Imported ${buildings.length} buildings with teams and sight ranges.`);
    return data;
}

function main(argv = process.argv.slice(2)) {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
        game: { type: 'string' }, 'resource-tool': { type: 'string' },
    } });
    const [patch] = positionals;
    if (positionals.length !== 1) throw new Error('Usage: npm run import:building-vision -- <patch> --resource-tool <Source2Viewer-CLI> [--game <directory>]');
    importBuildingVision({ patch, resourceTool: values['resource-tool'], game: values.game });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
