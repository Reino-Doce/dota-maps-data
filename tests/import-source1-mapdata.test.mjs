import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildSource1MapData, importSource1MapData, parseSource1EntityLump, parseSource1Models } from '../scripts/import-source1-mapdata.mjs';

function entity(values) {
    return `{\n${Object.entries(values).map(([key, value]) => `"${key}" "${value}"`).join('\n')}\n}`;
}

function makeBsp(entitySource, models) {
    const headerSize = 8 + 64 * 16;
    const entityBytes = Buffer.from(`${entitySource}\0`, 'latin1');
    const modelBytes = Buffer.alloc(models.length * 48);
    models.forEach((model, modelIndex) => {
        const offset = modelIndex * 48;
        [...model.min, ...model.max, 0, 0, 0].forEach((value, index) => modelBytes.writeFloatLE(value, offset + index * 4));
        modelBytes.writeInt32LE(0, offset + 36);
        modelBytes.writeInt32LE(0, offset + 40);
        modelBytes.writeInt32LE(0, offset + 44);
    });
    const bsp = Buffer.alloc(headerSize + entityBytes.length + modelBytes.length);
    bsp.write('VBSP', 0, 'ascii');
    bsp.writeInt32LE(21, 4);
    const setLump = (index, start, length) => {
        const offset = 8 + index * 16;
        bsp.writeInt32LE(start, offset);
        bsp.writeInt32LE(length, offset + 4);
    };
    setLump(0, headerSize, entityBytes.length);
    setLump(14, headerSize + entityBytes.length, modelBytes.length);
    entityBytes.copy(bsp, headerSize);
    modelBytes.copy(bsp, headerSize + entityBytes.length);
    return bsp;
}

function sampleEntities() {
    return [
        entity({ classname: 'worldspawn', world_mins: '-100 -200 -16', world_maxs: '100 200 256' }),
        entity({ classname: 'ent_dota_tree', origin: '10 20 30' }),
        entity({ classname: 'npc_dota_neutral_spawner', origin: '3 4 5', neutraltype: '2' }),
        entity({ classname: 'trigger_multiple', targetname: 'neutralcamp_good_1', origin: '0 0 0', model: '*1' }),
        entity({ classname: 'npc_dota_tower', targetname: 'dota_goodguys_tower2_mid', origin: '20 30 40' }),
        entity({ classname: 'npc_dota_barracks', targetname: 'good_rax_range_bot', origin: '30 40 50' }),
        entity({ classname: 'npc_dota_building', targetname: 'good_filler_1', origin: '40 50 60' }),
        entity({ classname: 'ent_dota_fountain', origin: '50 60 70' }),
    ].join('\n');
}

function sampleModels() {
    return [{ min: [-100, -200, -16], max: [100, 200, 256] },
        { min: [-8, -12, -16], max: [8, 12, 16] }];
}

test('parses Source 1 BSP entity and model lumps with strict bounds', () => {
    const bsp = makeBsp(sampleEntities(), sampleModels());
    const offset = 8;
    const entityStart = bsp.readInt32LE(offset);
    const entityLength = bsp.readInt32LE(offset + 4);
    const modelOffset = 8 + 14 * 16;
    const modelStart = bsp.readInt32LE(modelOffset);
    const modelLength = bsp.readInt32LE(modelOffset + 4);
    const entities = parseSource1EntityLump(bsp.subarray(entityStart, entityStart + entityLength));
    const models = parseSource1Models(bsp.subarray(modelStart, modelStart + modelLength));

    assert.equal(entities.length, 8);
    assert.equal(entities[0].world_mins, '-100 -200 -16');
    assert.equal(models.length, 2);
    assert.deepEqual(models[1].min, [-8, -12, -16]);
    assert.throws(() => parseSource1Models(Buffer.alloc(47)), /invalid length/i);
});

test('builds versioned locations and neutral trigger bounds from Source 1 BSP entities', () => {
    const entities = parseSource1EntityLump(Buffer.from(sampleEntities(), 'latin1'));
    const result = buildSource1MapData(entities, sampleModels().map(model => ({ ...model, origin: [0, 0, 0] })), 'a'.repeat(64));

    assert.deepEqual(result.worlddata, { worldMinX: -100, worldMaxX: 100, worldMinY: -200, worldMaxY: 200 });
    assert.deepEqual(result.mapdata.data.ent_dota_tree, [{ x: 10, y: 20, z: 30 }]);
    assert.deepEqual(result.mapdata.data.npc_dota_neutral_spawner, [{ x: 3, y: 4, triggerName: 'neutralcamp_good_1',
        neutralType: '2' }]);
    assert.equal(result.mapdata.data.trigger_multiple[0].campType, 'large');
    assert.deepEqual(result.mapdata.data.trigger_multiple[0].points,
        [{ x: -8, y: -12 }, { x: 8, y: -12 }, { x: 8, y: 12 }, { x: -8, y: 12 }]);
    assert.deepEqual(result.mapdata.data.npc_dota_tower, [{ x: 20, y: 30, subType: 'tower2' }]);
    assert.deepEqual(result.mapdata.data.npc_dota_barracks, [{ x: 30, y: 40, subType: 'range' }]);
    assert.deepEqual(result.mapdata.data.npc_dota_filler, [{ x: 40, y: 50 }]);
    assert.deepEqual(result.mapdata.stats, {});
});

test('imports only explicit Source 1 inputs, preserves provenance, and protects existing output', t => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dota-source1-mapdata-'));
    t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
    const sourceRoot = path.join(tempRoot, '670');
    const mapsDirectory = path.join(sourceRoot, 'dota', 'maps');
    const outputDirectory = path.join(tempRoot, 'out');
    fs.mkdirSync(mapsDirectory, { recursive: true });
    const mapPath = path.join(mapsDirectory, 'dota.bsp');
    const navBytes = Buffer.from('fixture navigation');
    fs.writeFileSync(mapPath, makeBsp(sampleEntities(), sampleModels()));
    fs.writeFileSync(path.join(mapsDirectory, 'dota.gnv'), navBytes);
    fs.writeFileSync(path.join(sourceRoot, 'dota', 'steam.inf'), 'ProductName=dota\nappID=570\nPatchVersion=37\n');

    const result = importSource1MapData({ patch: '670', mapPath, outputDirectory });
    const source = JSON.parse(fs.readFileSync(path.join(outputDirectory, 'source.json'), 'utf8'));
    assert.equal(result.entityCount, 8);
    assert.equal(result.hasNavigation, true);
    assert.equal(source.sourceEngine, 'Source 1');
    assert.equal(source.steamInfo.patchVersion, '37');
    assert.equal(source.files.map.path, 'dota/maps/dota.bsp');
    assert.deepEqual(fs.readFileSync(path.join(outputDirectory, 'gridnav.gnv')), navBytes);
    assert.throws(() => importSource1MapData({ patch: '670', mapPath, outputDirectory }), /Refusing to overwrite/);
});
