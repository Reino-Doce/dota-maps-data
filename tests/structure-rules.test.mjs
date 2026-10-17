import assert from 'node:assert/strict';
import { test } from 'node:test';
import mapdata from '../assets/data/741/mapdata.json' with { type: 'json' };
import { buildStructureRules } from '../src/structureRules.mjs';

const records = Object.entries(mapdata.data).flatMap(([id, entries]) => {
    if (!['npc_dota_tower', 'npc_dota_barracks', 'npc_dota_fort', 'npc_dota_lotus_pool',
        'npc_dota_watch_tower', 'npc_dota_healer', 'ent_dota_shop', 'ent_dota_fountain'].includes(id)) return [];
    return entries.map(props => ({ ...props, id, key: `${id}:${props.x},${props.y}`,
        team: props.team || (props.x + props.y < 0 ? 'radiant' : 'dire') }));
});
const rules = buildStructureRules(records);
const at = (id, point) => records.find(record => record.id === id && Math.hypot(record.x - point[0], record.y - point[1]) < 80);

test('structure destruction rules protect noncombat structures and link each lane tier', () => {
    assert.equal(records.filter(record => rules.get(record.key).destroyable).length, 36);
    assert.equal(rules.get(at('npc_dota_lotus_pool', [-7548, 4209]).key).destroyable, false);
    assert.equal(rules.get(at('npc_dota_watch_tower', [-4096, -448]).key).destroyable, false);
    assert.equal(rules.get(at('ent_dota_fountain', [-7456, -6938]).key).destroyable, false);

    const t1 = at('npc_dota_tower', [-1544, -1408]);
    const t2 = at('npc_dota_tower', [-3190, -2926]);
    const t3 = at('npc_dota_tower', [-4640, -4144]);
    const barracks = at('npc_dota_barracks', [-4672, -4552]);
    assert.deepEqual(rules.get(t2.key).requirements, [{ mode: 'all', keys: [t1.key] }]);
    assert.deepEqual(rules.get(t3.key).requirements, [{ mode: 'all', keys: [t2.key] }]);
    assert.deepEqual(rules.get(barracks.key).requirements, [{ mode: 'all', keys: [t3.key] }]);
});

test('tier-four towers need a barracks and the Ancient needs both tier-four towers', () => {
    const radiantBarracks = records.filter(record => record.id === 'npc_dota_barracks' && record.team === 'radiant');
    const radiantT4 = records.filter(record => record.id === 'npc_dota_tower' && record.team === 'radiant' && record.subType === 'tower4');
    const ancient = at('npc_dota_fort', [-5919, -5351]);
    assert.equal(radiantT4.length, 2);
    for (const tower of radiantT4) {
        const requirement = rules.get(tower.key).requirements[0];
        assert.equal(requirement.mode, 'any');
        assert.deepEqual([...requirement.keys].sort(), radiantBarracks.map(item => item.key).sort());
    }
    const requirement = rules.get(ancient.key).requirements[0];
    assert.equal(requirement.mode, 'all');
    assert.deepEqual([...requirement.keys].sort(), radiantT4.map(item => item.key).sort());
});
