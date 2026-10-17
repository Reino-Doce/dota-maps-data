import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildLaneGeometry, importLaneGeometry } from '../scripts/import-lane-geometry.mjs';

const laneClasses = ['good_bot', 'good_mid', 'good_top', 'bad_bot', 'bad_mid', 'bad_top'];

function entities() {
    const result = [];
    for (const [index, lane] of laneClasses.entries()) {
        const start = `lane_${lane}_1`;
        const end = `lane_${lane}_2`;
        result.push({ classname: `npc_dota_spawner_${lane}`, origin: `${index} ${index + 1} 0`, npcfirstwaypoint: start });
        result.push({ classname: 'path_corner', targetname: start, target: end, origin: `${index + 2} ${index + 3} 4` });
        result.push({ classname: 'path_corner', targetname: end, origin: `${index + 4} ${index + 5} 8` });
    }
    return result;
}

test('lane geometry follows each spawner waypoint chain and stops at cycles', () => {
    const values = entities();
    values.find(entity => entity.targetname === 'lane_good_bot_2').target = 'lane_good_bot_1';
    const data = buildLaneGeometry(values);
    assert.equal(data.spawners.features.length, 6);
    assert.deepEqual(data.spawners.features[0], {
        type: 'Feature', id: 'npc_dota_spawner_bad_bot', geometry: { type: 'Point', coordinates: [3, 4] },
    });
    assert.deepEqual(data.paths.features.find(feature => feature.id === 'npc_dota_spawner_good_bot').geometry.coordinates,
        [[2, 3], [4, 5]]);
});

test('lane geometry rejects incomplete and ambiguous source entities', () => {
    assert.throws(() => buildLaneGeometry(entities().slice(1)), /six distinct lane spawners/);
    const duplicates = entities();
    duplicates.push({ classname: 'path_corner', targetname: 'lane_good_bot_1', origin: '0 0 0' });
    assert.throws(() => buildLaneGeometry(duplicates), /unique target names/);
    const missingTarget = entities();
    missingTarget.find(entity => entity.classname === 'npc_dota_spawner_good_bot').npcfirstwaypoint = 'missing';
    assert.throws(() => buildLaneGeometry(missingTarget), /missing corner/);
});

test('lane importer writes to the explicit patch directory and protects existing outputs', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dota-lanes-'));
    try {
        const input = path.join(directory, 'entities.txt');
        const output = path.join(directory, 'assets', 'data', '683');
        fs.writeFileSync(input, entities().map((entity, index) => `====${index}====\n`
            + Object.entries(entity).map(([key, value]) => `${key.padEnd(24)}${JSON.stringify(value)}`).join('\n')).join('\n'));
        assert.deepEqual(importLaneGeometry({ patch: '683', entitiesFile: input, outputDirectory: output }),
            { patch: '683', spawners: 6, pathFeatures: 6 });
        const before = fs.readFileSync(path.join(output, 'npc_dota_spawner.json'));
        assert.throws(() => importLaneGeometry({ patch: '683', entitiesFile: input, outputDirectory: output }), /Refusing to overwrite/);
        assert.deepEqual(fs.readFileSync(path.join(output, 'npc_dota_spawner.json')), before);
    }
    finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
