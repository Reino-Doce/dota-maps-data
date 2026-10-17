import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mapTreeIds } from '../scripts/import-live-trees.mjs';
import { compareRuntimeTreePositions, createTerrainCapture, inferCaptureGrid, resolvePatchScanPlan, verifyRuntimeEntities } from '../scripts/scan-mapdata.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const cstring = value => Buffer.concat([Buffer.from(value), Buffer.from([0])]);

function makeVpk(resourcePath, resourceBytes) {
    const extension = path.posix.extname(resourcePath).slice(1);
    const withoutExtension = resourcePath.slice(0, -(extension.length + 1));
    const directory = path.posix.dirname(withoutExtension);
    const name = path.posix.basename(withoutExtension);
    const entry = Buffer.alloc(18);
    entry.writeUInt16LE(0, 4);
    entry.writeUInt16LE(0x7fff, 6);
    entry.writeUInt32LE(0, 8);
    entry.writeUInt32LE(resourceBytes.length, 12);
    entry.writeUInt16LE(0xffff, 16);
    const tree = Buffer.concat([cstring(extension), cstring(directory), cstring(name), entry,
        cstring(''), cstring(''), cstring('')]);
    const header = Buffer.alloc(12);
    header.writeUInt32LE(0x55aa1234, 0);
    header.writeUInt32LE(1, 4);
    header.writeUInt32LE(tree.length, 8);
    return Buffer.concat([header, tree, resourceBytes]);
}

test('maps without a source GNV can still capture exact terrain and tree data on aligned bounds', () => {
    assert.deepEqual(inferCaptureGrid({ worldMinX: -8288, worldMaxX: 8288, worldMinY: -8288, worldMaxY: 8288 }), {
        cellSize: 64, width: 260, height: 260, origin: [-8320, -8320],
    });
    assert.throws(() => inferCaptureGrid({ worldMinX: -8200, worldMaxX: 8200, worldMinY: -8000, worldMaxY: 8000 }),
        /do not align to 64-unit cells/);
});

test('runtime structure positions must match the selected patch entity data', () => {
    const mapData = { data: {
        npc_dota_lotus_pool: [{ x: 1, y: 2, z: 3 }],
        npc_dota_unit_twin_gate: [],
        npc_dota_watch_tower: [{ x: 4, y: 5, z: 6 }],
    } };
    const grid = { entities: [
        { classname: 'npc_dota_lotus_pool', origin: [1, 2, 256] },
        { classname: 'npc_dota_watch_tower', origin: [4, 5, -128] },
    ] };
    assert.deepEqual(verifyRuntimeEntities(grid, mapData), {
        npc_dota_lotus_pool: 1, npc_dota_unit_twin_gate: 0, npc_dota_watch_tower: 1,
    });
    assert.throws(() => verifyRuntimeEntities({ entities: [
        { classname: 'npc_dota_lotus_pool', origin: [8, 9, 10] },
        grid.entities[1],
    ] }, mapData), /exact patch archive/);
});

test('runtime tree mismatches report exact set differences for preserved unvalidated captures', () => {
    const expected = [{ x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 }];
    assert.deepEqual(compareRuntimeTreePositions([[1, 2, 3], [4, 5, 6]], expected), {
        matches: true,
        expectedCount: 2,
        capturedCount: 2,
        missingCount: 0,
        unexpectedCount: 0,
        duplicateExpectedCount: 0,
        duplicateCapturedCount: 0,
        shiftedMatchCount: 0,
        maxShiftDistance: 0,
        missingSample: [],
        unexpectedSample: [],
        shiftedSample: [],
    });
    const shifted = compareRuntimeTreePositions([[1, 2, 3], [4, 5, 0]], expected);
    assert.equal(shifted.matches, true);
    assert.equal(shifted.shiftedMatchCount, 1);
    assert.equal(shifted.maxShiftDistance, 6);
    const mismatch = compareRuntimeTreePositions([[1, 2, 3], [1000, 1000, 1000]], expected);
    assert.equal(mismatch.matches, false);
    assert.equal(mismatch.missingCount, 1);
    assert.equal(mismatch.unexpectedCount, 1);
    assert.deepEqual(mismatch.missingSample, ['4,5,6']);
    assert.deepEqual(mismatch.unexpectedSample, ['1000,1000,1000']);
});

test('live tree IDs map small runtime-origin changes only when the nearest map tree is unambiguous', () => {
    const trees = [{ x: 0, y: 0, z: 256 }, { x: 256, y: 0, z: 256 }];
    assert.deepEqual(mapTreeIds([[0, 8, 0, 256], [1, 256, 0, 256]], trees), [0, 1]);
    assert.deepEqual(mapTreeIds([[0, 8, 0, 256], [2, 256, 0, 256]], trees), [0, null, 1]);
    assert.throws(() => mapTreeIds([[0, 20, 0, 256], [1, 256, 0, 256]], [
        { x: 0, y: 0, z: 256 }, { x: 40, y: 0, z: 256 },
    ]), /unambiguously match/);
});

test('installed terrain capture carries its exact patch provenance without duplicating tree IDs', () => {
    const terrain = createTerrainCapture({
        patch: '728', mapName: 'dota_728', archiveSha256: 'a'.repeat(64), navigationSha256: null,
        source: { resources: {
            map: { path: 'maps/dota_728.vmap_c' },
            entities: { sha256: 'b'.repeat(64) },
        } },
    }, {
        width: 1, height: 1, cellSize: 64, origin: [0, 0],
        source: { map: 'dota_728' }, heights: [[0]], trees: [], treeIds: [[0, 1, 2, 3]], entities: [], pits: [],
    });
    assert.equal(terrain.treeIds, undefined);
    assert.deepEqual(terrain.source, {
        map: 'dota_728', patch: '728', mapArchiveSha256: 'a'.repeat(64),
        mapResource: 'maps/dota_728.vmap_c', mapEntitiesSha256: 'b'.repeat(64), navigationSha256: null,
    });
});

test('patch scan plan verifies the exact map archive and records its patch-specific map identity', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mapdata-scan-plan-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const game = path.join(directory, 'game');
    const assets = path.join(directory, 'assets');
    const data = path.join(assets, 'data', '728');
    fs.mkdirSync(path.join(game, 'dota'), { recursive: true });
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(game, 'dota', 'pak01_dir.vpk'), 'directory marker');
    const mapPath = 'maps/dota_728.vmap_c';
    const mapBytes = Buffer.from('exact patch map resource');
    const archivePath = path.join(directory, 'dota_728.vpk');
    const archiveBytes = makeVpk(mapPath, mapBytes);
    fs.writeFileSync(archivePath, archiveBytes);
    fs.writeFileSync(path.join(data, 'source.json'), JSON.stringify({
        patch: '728', mapName: 'dota_728', archive: 'dota_728.vpk', archiveSha256: sha256(archiveBytes),
        resources: {
            map: { path: mapPath, available: true, sha256: sha256(mapBytes) },
            entities: { path: 'maps/dota_728/entities/default_ents.vents_c', available: false },
            navigation: { path: 'maps/dota_728.gnv', available: false },
        },
    }));
    fs.writeFileSync(path.join(data, 'worlddata.json'), JSON.stringify({
        worldMinX: -8288, worldMaxX: 8288, worldMinY: -8288, worldMaxY: 8288,
    }));

    const plan = resolvePatchScanPlan({ patch: '728', game, archive: archivePath, assetDirectory: assets });
    assert.equal(plan.mapName, 'dota_728');
    assert.equal(plan.archiveSha256, sha256(archiveBytes));
    assert.equal(plan.navigationBytes, undefined);
    assert.deepEqual(plan.grid, { cellSize: 64, width: 260, height: 260, origin: [-8320, -8320] });

    fs.appendFileSync(archivePath, 'changed');
    assert.throws(() => resolvePatchScanPlan({ patch: '728', game, archive: archivePath, assetDirectory: assets }),
        /archive SHA-256 mismatch/);
});
