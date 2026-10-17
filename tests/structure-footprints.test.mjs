import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { defaultMeshGroups, readModelTriangles, projectModelFootprint, pitFootprint } from '../scripts/structure-footprints.mjs';
import { importStructureFootprints, validateStructureCapture } from '../scripts/import-structure-footprints.mjs';
import { isWardBlocked } from '../src/wardGrid.mjs';

function modelFixture(extraGeometry = false) {
    // Source points (0,0,0), (100,0,0), (0,40,20), already converted by VRF.
    const floats = new Float32Array([0, 0, 0, 0, 0, 2.54, 1.016, 0.508, 0]);
    const binary = Buffer.from(floats.buffer);
    const json = JSON.stringify({ asset: { version: '2.0', generator: 'Source 2 Viewer 20' },
        buffers: [{ byteLength: binary.length }], bufferViews: [{ buffer: 0, byteLength: binary.length }],
        accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
        materials: [{ alphaMode: 'MASK' }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 } }, ...(extraGeometry ? [{ attributes: { POSITION: 0 }, material: 0 }] : [])] },
            ...(extraGeometry ? [{ primitives: [{ attributes: { POSITION: 0 } }] }] : [])],
        nodes: [{ mesh: 0 }, ...(extraGeometry ? [{ mesh: 1, translation: [5, 0, 0] }] : [])],
        scenes: [{ nodes: extraGeometry ? [0, 1] : [0] }] });
    const chunk = Buffer.from(json.padEnd(Math.ceil(json.length / 4) * 4));
    const header = Buffer.alloc(20);
    header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4);
    header.writeUInt32LE(28 + chunk.length + binary.length, 8);
    header.writeUInt32LE(chunk.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
    const binaryHeader = Buffer.alloc(8);
    binaryHeader.writeUInt32LE(binary.length, 0); binaryHeader.writeUInt32LE(0x004e4942, 4);
    return Buffer.concat([header, chunk, binaryHeader, binary]);
}

function blocked(geometry, x, y) {
    return isWardBlocked({ origin: [-2048, -2048], cellSize: 64, width: 64, height: 64,
        blockedRows: Array.from({ length: 64 }, () => []), structures: [{ geometry }] }, x, y);
}

test('model import undoes Source 2 Viewer axes and units before applying entity placement', () => {
    const triangles = readModelTriangles(modelFixture());
    const expected = [[0, 0, 0], [100, 0, 0], [0, 40, 20]];
    triangles[0].forEach((p, i) => p.forEach((v, axis) => assert.ok(Math.abs(v - expected[i][axis]) < 0.0001)));
    const geometry = projectModelFootprint(triangles, { origin: [1000, -500, 0], modelScale: 2, angles: [0, 90, 0] });
    assert.equal(blocked(geometry, 980, -440), true);
    assert.equal(blocked(geometry, 960, -480), true);
    assert.equal(blocked(geometry, 1040, -480), false, 'do not mirror the authored rotation');
    assert.equal(blocked(geometry, 980, -250), false, 'do not extend the model beyond its scale');
    assert.throws(() => readModelTriangles(modelFixture().subarray(0, -4)), /complete/);
});

test('footprints exclude inactive consumables and transparent foliage geometry', () => {
    const active = defaultMeshGroups('m_refMeshGroupMasks = [ 4, 2, ]\nm_nDefaultMeshGroupMask = 5');
    assert.deepEqual(active, [true, false]);
    assert.equal(readModelTriangles(modelFixture(true), active).length, 1);
    assert.equal(readModelTriangles(modelFixture(true)).length, 2, 'transparent quads never become solid footprint');
    assert.throws(() => readModelTriangles(modelFixture(true), [true]), /bodygroups/);
    assert.throws(() => defaultMeshGroups(''), /metadata/);
});

test('pit extraction keeps only the connected hole at the spawn marker and detects incomplete scans', () => {
    const pit = { name: 'miniboss_location_1', origin: [0, 0], center: [20, 20], cellSize: 8, width: 8, height: 6,
        blockedRows: [[], [1, 4, 6, 7], [1, 4, 6, 7], [1, 4], [], []] };
    const geometry = pitFootprint(pit);
    assert.equal(blocked(geometry, 20, 20), true);
    assert.equal(blocked(geometry, 52, 20), false, 'nearby disconnected depressions are not the pit');
    assert.equal(blocked(geometry, 40, 20), false, 'ground around the hole remains available');
    assert.equal(blocked(geometry, 8, 20), true, 'the pit boundary is included');
    assert.throws(() => pitFootprint({ ...pit, center: [40, 20] }), /No pit/);
    assert.throws(() => pitFootprint({ ...pit, blockedRows: [[1, 4], ...pit.blockedRows.slice(1)] }), /boundary/);
});

test('older maps without ward-blocking structures produce an exact-source empty footprint set', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dota-map-structure-import-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const assets = path.join(directory, 'assets');
    const dataDirectory = path.join(assets, 'data', 'test');
    const captureDirectory = path.join(directory, 'captures');
    fs.mkdirSync(dataDirectory, { recursive: true });
    const navigation = Buffer.alloc(36);
    navigation.writeUInt32LE(0xFADEBEAD, 0);
    navigation.writeFloatLE(64, 4);
    navigation.writeFloatLE(32, 8);
    navigation.writeFloatLE(32, 12);
    navigation.writeInt32LE(2, 16);
    navigation.writeInt32LE(2, 20);
    navigation.writeInt32LE(-1, 24);
    navigation.writeInt32LE(-1, 28);
    const navigationSha256 = createHash('sha256').update(navigation).digest('hex');
    const source = { patch: 'test', archiveSha256: 'a'.repeat(64),
        resources: { map: { path: 'maps/test.vmap_c' }, entities: { sha256: 'b'.repeat(64) },
            navigation: { available: true, path: 'maps/test.gnv', sha256: navigationSha256 } } };
    const mapData = { data: { npc_dota_lotus_pool: [], npc_dota_unit_twin_gate: [], npc_dota_watch_tower: [] } };
    const terrain = { source: { patch: 'test', mapArchiveSha256: source.archiveSha256,
        mapResource: source.resources.map.path, mapEntitiesSha256: source.resources.entities.sha256, navigationSha256 },
    entities: [], pits: [] };
    fs.writeFileSync(path.join(dataDirectory, 'source.json'), JSON.stringify(source));
    fs.writeFileSync(path.join(dataDirectory, 'mapdata.json'), JSON.stringify(mapData));
    fs.writeFileSync(path.join(dataDirectory, 'terrain_grid.json'), JSON.stringify(terrain));
    fs.writeFileSync(path.join(dataDirectory, 'gridnav.gnv'), navigation);

    const result = importStructureFootprints({ patch: 'test', assetDirectory: assets, captureDirectory });
    assert.deepEqual(result.features, []);
    assert.equal(result.source.mapArchiveSha256, source.archiveSha256);
    assert.equal(result.source.navigationPath, source.resources.navigation.path);
    assert.equal(result.source.modelArchive, undefined);
});

test('structure capture validation compares archived X/Y while preserving runtime height', () => {
    const source = { patch: '732', archiveSha256: 'a'.repeat(64),
        resources: { map: { path: 'maps/dota.vmap_c' }, entities: { sha256: 'b'.repeat(64) } } };
    const terrain = { source: { patch: '732', mapArchiveSha256: source.archiveSha256,
        mapResource: source.resources.map.path, mapEntitiesSha256: source.resources.entities.sha256,
        navigationSha256: 'c'.repeat(64) },
    entities: [{ classname: 'npc_dota_watch_tower', origin: [1, 2, 256] }], pits: [] };
    const mapData = { data: { npc_dota_lotus_pool: [], npc_dota_unit_twin_gate: [],
        npc_dota_watch_tower: [{ x: 1, y: 2 }] } };

    assert.doesNotThrow(() => validateStructureCapture('732', source, terrain, mapData, 'c'.repeat(64)));
    assert.throws(() => validateStructureCapture('732', source, terrain, { data: {
        ...mapData.data, npc_dota_watch_tower: [{ x: 9, y: 2 }],
    } }, 'c'.repeat(64)), /positions do not match/);
});
