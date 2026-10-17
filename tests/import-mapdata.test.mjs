import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMapData, preserveMapDataAnnotations } from '../scripts/import-mapdata.mjs';
import { parseEntityBoolean, parseEntityVector, parseSource2EntityDump } from '../scripts/source2-entities.mjs';

test('parses Source 2 Viewer entity records without starting a process', () => {
    const dump = [
        '====0====',
        'classname  "ent_dota_tree"',
        'origin     "-1.5 2e2 3"',
        '====1====',
        'classname  "trigger_multiple"',
        'model      resource_name:"maps/dota/entities/neutralcamp_good_1.vmdl"',
    ].join('\n');
    const entities = parseSource2EntityDump(dump);

    assert.deepEqual(parseEntityVector(entities[0].origin), [-1.5, 200, 3]);
    assert.equal(entities[1].model, 'maps/dota/entities/neutralcamp_good_1.vmdl');
    assert.equal(parseEntityBoolean('1'), true);
    assert.equal(parseEntityBoolean(undefined, false), false);
});

test('builds a versioned map dataset from exact entity locations and FOW blocker sources', () => {
    const entities = [
        { classname: 'ent_dota_tree', origin: '1 2 3' },
        { classname: 'ent_dota_tree', origin: '1 2 3' },
        { classname: 'npc_dota_neutral_spawner', origin: '4 5 6', volumename: '[PR#]neutralcamp_good_1',
            neutraltype: '2', pulltype: '5' },
        { classname: 'npc_dota_lotus_pool', origin: '7 8 9' },
        { classname: 'npc_dota_tower', origin: '10 11 12', mapunitname: 'dota_badguys_tower1_top' },
        { classname: 'npc_dota_barracks', origin: '13 14 15', mapunitname: 'dota_badguys_melee_rax_top' },
        { classname: 'npc_dota_building', origin: '16 17 18', mapunitname: 'dota_goodguys_fillers' },
        { classname: 'ent_fow_blocker_node', origin: '19 20 21' },
        { classname: 'dota_item_rune_spawner', origin: '22 23 24' },
    ];
    const { mapdata, blockers } = buildMapData(entities);

    assert.deepEqual(mapdata.data.ent_dota_tree, [{ x: 1, y: 2, z: 3 }]);
    assert.deepEqual(mapdata.data.npc_dota_neutral_spawner, [{
        triggerName: 'neutralcamp_good_1', neutralType: '2', pullType: '5', x: 4, y: 5,
    }]);
    assert.deepEqual(mapdata.data.npc_dota_lotus_pool, [{ x: 7, y: 8 }]);
    assert.deepEqual(mapdata.data.npc_dota_tower, [{ x: 10, y: 11, subType: 'tower1' }]);
    assert.deepEqual(mapdata.data.npc_dota_barracks, [{ x: 13, y: 14, subType: 'melee' }]);
    assert.deepEqual(mapdata.data.npc_dota_filler, [{ x: 16, y: 17 }]);
    assert.deepEqual(mapdata.data.dota_item_rune_spawner_powerup, [{ x: 22, y: 23 }]);
    assert.equal(Object.hasOwn(mapdata.data, 'dota_item_rune_spawner'), false);
    for (const classname of ['npc_dota_lotus_pool', 'npc_dota_unit_twin_gate', 'npc_dota_lantern',
        'npc_dota_base_blocker', 'npc_dota_miniboss_spawner', 'ent_dota_tree']) {
        assert.ok(Array.isArray(mapdata.data[classname]), `${classname} must be explicit even when this map has none`);
    }
    assert.deepEqual(blockers, [[19, 20, 21]]);
});

test('map refresh retains stats and exact-location runtime annotations', () => {
    const mapdata = { data: { npc_dota_lotus_pool: [{ x: 7.0000003, y: 8 }],
        ent_dota_tree: [{ x: 1, y: 2, z: 3 }] }, stats: {} };
    const previous = { data: { npc_dota_lotus_pool: [{ x: 7, y: 8, hullRadius: 96 },
        { x: 70, y: 80, hullRadius: 12 }], ent_dota_tree: [{ x: 9, y: 9, z: 9, hullRadius: 2 }] },
    stats: { npc_dota_lotus_pool: { dayVision: 0 }, npc_dota_tower_tower1: { dayVision: 1900 } } };
    preserveMapDataAnnotations(mapdata, previous);
    assert.deepEqual(mapdata.data.npc_dota_lotus_pool, [{ x: 7, y: 8, hullRadius: 96 }]);
    assert.deepEqual(mapdata.data.ent_dota_tree, [{ x: 1, y: 2, z: 3 }]);
    assert.deepEqual(mapdata.stats, previous.stats);
});

test('fails closed when an entity cannot be assigned to a versioned data category', () => {
    assert.throws(() => buildMapData([{ classname: 'npc_dota_tower', origin: '1 2 3' }]), /contains no tree entities/i);
    assert.throws(() => buildMapData([
        { classname: 'ent_dota_tree', origin: '1 2 3' },
        { classname: 'npc_dota_tower', origin: '4 5 6', mapunitname: 'unknown_tower' },
    ]), /tower-tier/);
});
