import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { readBuildings } from '../scripts/import-building-vision.mjs';

const directory = new URL('../assets/data/741f/', import.meta.url);
const read = file => fs.readFileSync(new URL(file, directory));
const data = JSON.parse(read('building_vision.json'));

test('current buildings retain native ownership, all base fillers, and current sight ranges', () => {
    assert.equal(data.buildings.length, 60);
    assert.equal(new Set(data.buildings.map(building => building.id)).size, 60);
    for (const team of ['radiant', 'dire']) {
        const buildings = data.buildings.filter(building => building.team === team);
        assert.equal(buildings.length, 27);
        assert.equal(buildings.filter(building => building.unitClass === 'npc_dota_filler').length, 7);
        assert.equal(buildings.filter(building => building.unitClass === 'npc_dota_tower').length, 11);
    }
    for (const building of data.buildings.filter(building => building.unitClass === 'npc_dota_watch_tower')) {
        assert.deepEqual([building.dayVision, building.nightVision, building.trueSight], [0, 0, 0]);
    }
    assert.equal(data.buildings.filter(building => building.team === 'neutral').length, 6);
    assert.equal(data.source.gridnavSha256, createHash('sha256').update(read('gridnav.gnv')).digest('hex'));
    assert.equal(data.source.mapEntitiesSha256, JSON.parse(read('watchers.json')).source.mapEntitiesSha256);
});

test('import reconciles placed classes and NPC templates and rejects incomplete instances', () => {
    const units = { DOTAUnits: {
        filler: { BaseClass: 'npc_dota_filler', TeamName: 'DOTA_TEAM_GOODGUYS', VisionDaytimeRange: '900', VisionNighttimeRange: '600' },
        rax: { BaseClass: 'npc_dota_building', TeamName: 'DOTA_TEAM_BADGUYS', VisionDaytimeRange: '900', VisionNighttimeRange: '600' },
    } };
    const entity = (classname, name, id, team = 0) => `values = { classname = "${classname}" MapUnitName = "${name}" teamnumber = "${team}" origin = [1.25, -2, 256] hammerUniqueId = "${id}" }`;
    const filler = entity('npc_dota_building', 'filler', '1');
    const rax = entity('npc_dota_barracks', 'rax', '2');
    const buildings = readBuildings(filler + rax, units);
    assert.deepEqual(buildings.map(building => [building.unitClass, building.team]), [['npc_dota_filler', 'radiant'], ['npc_dota_barracks', 'dire']]);
    assert.deepEqual(buildings[0].position, [1.25, -2, 256]);
    assert.equal(readBuildings(entity('npc_dota_building', 'filler', '1', 3), units)[0].team, 'dire');
    assert.throws(() => readBuildings(filler + filler, units), /duplicate/);
    assert.throws(() => readBuildings(rax, {}), /Incomplete/);
    assert.throws(() => readBuildings(filler.replace('1.25', 'NaN'), units), /Incomplete/);
});
