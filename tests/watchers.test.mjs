import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { readWatchers } from '../scripts/import-watchers.mjs';

const directory = new URL('../assets/data/741f/', import.meta.url);
const read = file => fs.readFileSync(new URL(file, directory));
const data = JSON.parse(read('watchers.json'));

test('Watcher data retains the installed map coordinates, current sight ranges and provenance', () => {
    assert.equal(data.unitClass, 'npc_dota_lantern');
    assert.equal(data.positions.length, 10);
    assert.equal(new Set(data.positions.map(point => point.slice(0, 2).join(','))).size, 10);
    assert.equal(data.dayVision, 800);
    assert.equal(data.nightVision, 450);
    // These centers were also checked against the running game's NPCs.
    for (const point of [[2717.693359, -657.453369, 256], [-3483.5, 34.375, 256], [768, -7648, 128]]) {
        assert.ok(data.positions.some(position => position.every((value, i) => value === point[i])));
    }
    assert.equal(data.source.gridnavSha256, createHash('sha256').update(read('gridnav.gnv')).digest('hex'));
    assert.equal(data.source.mapEntitiesSha256, JSON.parse(read('eyes_vision.json')).source.mapEntitiesSha256);
});

test('Watcher import preserves fractional coordinates and refuses partial or duplicate map extraction', () => {
    const units = { DOTAUnits: { npc_dota_lantern: { VisionDaytimeRange: '800', VisionNighttimeRange: '450' } } };
    const entity = 'classname = "npc_dota_lantern"\ncompile_source_id = 2725\norigin = [ 2717.693359, -657.453369, 256.0 ]';
    assert.deepEqual(readWatchers(entity, units).positions, [[2717.693359, -657.453369, 256]]);
    assert.throws(() => readWatchers(`${entity}\nclassname = "npc_dota_lantern"`, units), /Incomplete/);
    assert.throws(() => readWatchers(`${entity}\n${entity}`, units), /Incomplete/);
    assert.throws(() => readWatchers(entity.replace('256.0', 'NaN'), units), /Incomplete/);
    assert.throws(() => readWatchers(entity, {}), /Incomplete/);
    assert.throws(() => readWatchers(entity.replace('npc_dota_lantern', 'npc_dota_watch_tower'), units), /Incomplete/);
});
