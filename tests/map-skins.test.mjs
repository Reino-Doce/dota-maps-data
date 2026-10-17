import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { PNG } from 'pngjs';
import sharp from 'sharp';
import { openVpk, parseKeyValues, terrainItems } from '../src/node/game-files.mjs';
import { compareTerrain, createGridCollector, scanConsole } from '../scripts/game-scan.mjs';
import { assertUsableImage, decodeTga } from '../scripts/terrain-image.mjs';
import { createSfmSession, createSfmSweepSession } from '../scripts/sfm-session.mjs';
import { importSkin } from '../scripts/map-skins.mjs';

test('terrain discovery follows item overrides and excludes previews/non-terrain items', () => {
    const schema = `"items_game" { "items" {
        "590" { "prefab" "terrain" "name" "Default Terrain" }
        "21441" { "prefab" "terrain" "name" "Sanctums of the Divine" "visuals" {
            "asset_modifier0" { "type" "map_override" "asset" "maps/dota.vmap" "modifier" "maps/dota_ti10.vmap" }
            "asset_modifier1" { "type" "map_override" "asset" "maps/hero_demo.vmap" "modifier" "maps/terrain_preview.vmap" }
        } }
        "3" { "prefab" "courier" "name" "Not a terrain" }
    } }`;
    assert.deepEqual(terrainItems(schema), [
        { itemId: '590', name: 'Default Terrain', map: 'dota' },
        { itemId: '21441', name: 'Sanctums of the Divine', map: 'dota_ti10' },
    ]);
    assert.equal(parseKeyValues('// comment\nplain "a \\"quote\\""').plain, 'a "quote"');
    assert.throws(() => parseKeyValues('root { key }'), /Missing/);
    assert.throws(() => parseKeyValues('root { key value'), /Unclosed/);
});

test('VPK reads embedded and numbered resources with preload bytes; truncated files fail', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'map-skins-vpk-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const entry = (archive, offset, length, preload) => {
        const record = Buffer.alloc(18);
        record.writeUInt16LE(preload.length, 4);
        record.writeUInt16LE(archive, 6);
        record.writeUInt32LE(offset, 8);
        record.writeUInt32LE(length, 12);
        record.writeUInt16LE(0xffff, 16);
        return Buffer.concat([record, Buffer.from(preload)]);
    };
    const tree = Buffer.concat([
        Buffer.from('txt\0scripts\0embedded\0'), entry(0x7fff, 0, 4, 'pre'),
        Buffer.from('external\0'), entry(0, 0, 6, ''), Buffer.from('\0\0\0'),
    ]);
    const header = Buffer.alloc(28);
    header.writeUInt32LE(0x55aa1234, 0);
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(tree.length, 8);
    const file = path.join(directory, 'pak01_dir.vpk');
    fs.writeFileSync(file, Buffer.concat([header, tree, Buffer.from('load')]));
    fs.writeFileSync(path.join(directory, 'pak01_000.vpk'), 'packed');
    const archive = openVpk(file);
    assert.equal(archive.read('scripts/embedded.txt').toString(), 'preload');
    assert.equal(archive.read('scripts/external.txt').toString(), 'packed');
    assert.throws(() => archive.read('missing'), /not found/);
    fs.truncateSync(file, 10);
    assert.throws(() => openVpk(file), /beyond/);
});

const messages = [
    '[MAP_GRID_BEGIN]{"width":2,"height":2,"cellSize":64,"origin":[-64,-64],"map":"dota"}',
    '[MAP_GRID_HEIGHT][0,128]', '[MAP_GRID_HEIGHT][256,384]',
    '[MAP_GRID_TREE][1,2,3]',
    '[MAP_GRID_TREE_ID][0,1,2,3]',
    '[MAP_GRID_ENTITY]{"classname":"npc_dota_lotus_pool","origin":[4,5,6],"hullRadius":96,"bounds":[[-96,-96,0],[96,96,50]]}',
    '[MAP_GRID_EXPORT_COMPLETE]',
];

function sampleGrid() {
    const collector = createGridCollector();
    let grid;
    for (const line of messages) grid = collector.accept(line);
    return grid;
}

test('scan collector rejects incomplete and overlapping scans and retains runtime ward hulls', () => {
    const grid = sampleGrid();
    assert.equal(grid.entities[0].hullRadius, 96);
    assert.deepEqual(grid.treeIds, [[0, 1, 2, 3]]);
    assert.equal(grid.source.map, 'dota');
    const incomplete = createGridCollector();
    incomplete.accept(messages[0]);
    assert.throws(() => incomplete.accept(messages.at(-1)), /Incomplete/);
    assert.throws(() => incomplete.accept(messages[0]), /Overlapping/);
    assert.throws(() => createGridCollector().accept(messages[1]), /no header/);
    const invalidTreeId = createGridCollector();
    invalidTreeId.accept(messages[0]);
    assert.throws(() => invalidTreeId.accept('[MAP_GRID_TREE_ID][1,"x",2,3]'), /Invalid native tree ID/);
});

test('console scan handles fragmented packets, ignores unrelated output and never quits the client', async t => {
    let received = '';
    const server = net.createServer(socket => {
        socket.on('data', bytes => {
            received += bytes;
            if (bytes.toString().includes('script_reload_code')) {
                socket.write('unrelated session information\n');
                const data = messages.join('\n') + '\n';
                socket.write(data.slice(0, 23));
                setImmediate(() => socket.write(data.slice(23)));
            }
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    const grid = await scanConsole({ port: server.address().port, script: 'test_export', map: 'dota', timeout: 3000 });
    assert.equal(grid.heights.length, 2);
    assert.equal(received.includes('quit'), false);
    assert.equal(JSON.stringify(grid).includes('session information'), false);
});

test('skin compatibility detects height, tree and structure changes independently', () => {
    const grid = sampleGrid();
    assert.equal(compareTerrain(grid, structuredClone(grid)).overlaysCompatible, true);
    const candidate = structuredClone(grid);
    candidate.heights[1][1] += 128;
    candidate.trees[0][0] += 1;
    candidate.entities[0].hullRadius += 1;
    assert.deepEqual(compareTerrain(grid, candidate), {
        changedHeightCells: 1, maxHeightDelta: 128, treePositionsMatch: false, wardHullsMatch: false, overlaysCompatible: false,
    });
});

test('scan compatibility includes structure rotation, scale and Tormentor pit traces', () => {
    const base = sampleGrid();
    Object.assign(base.entities[0], { model: 'models/pool.vmdl', modelScale: 1.1, angles: [0, 60, 0] });
    base.pits = [{ name: 'miniboss_location_1', blockedRows: [[2, 5]] }];
    for (const change of [candidate => {
        candidate.entities[0].angles[1] += 5;
    },
    candidate => {
        candidate.entities[0].modelScale += 0.1;
    },
    candidate => {
        candidate.entities[0].model = 'models/other.vmdl';
    },
    candidate => {
        candidate.pits[0].blockedRows[0][1] += 1;
    }]) {
        const candidate = structuredClone(base);
        change(candidate);
        assert.equal(compareTerrain(base, candidate).overlaysCompatible, false);
    }
    const collector = createGridCollector();
    for (const line of messages.slice(0, -1)) collector.accept(line);
    assert.throws(() => collector.accept('[MAP_GRID_PIT]{"name":"miniboss_location_1","width":2,"height":1,"cellSize":8,"origin":[0,0],"center":[4,4],"blockedRows":[[1,3]]}'), /Invalid Tormentor/);
});

test('Lotus Pool float serialization noise does not invalidate a matching scan', () => {
    const grid = sampleGrid();
    const candidate = structuredClone(grid);
    candidate.entities[0].origin[1] += 0.00390625;
    assert.equal(compareTerrain(grid, candidate).overlaysCompatible, true);
    candidate.entities[0].origin[1] += 1;
    assert.equal(compareTerrain(grid, candidate).wardHullsMatch, false);
});

test('TGA decoding preserves orientation and handles RLE without moving map pixels', () => {
    const header = Buffer.alloc(18);
    header[2] = 2;
    header.writeUInt16LE(2, 12);
    header.writeUInt16LE(2, 14);
    header[16] = 24;
    const pixels = Buffer.from([0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255]);
    const bottomOrigin = decodeTga(Buffer.concat([header, pixels]));
    assert.deepEqual([...bottomOrigin.data.subarray(0, 4)], [0, 0, 255, 255]);
    header[17] = 32;
    const topOrigin = decodeTga(Buffer.concat([header, pixels]));
    assert.deepEqual([...topOrigin.data.subarray(0, 4)], [255, 0, 0, 255]);
    header[2] = 10;
    assert.deepEqual(decodeTga(Buffer.concat([header, Buffer.from([3]), pixels])).data, topOrigin.data);
    assert.throws(() => decodeTga(Buffer.concat([header, Buffer.from([255, 0, 0, 0])])), /exceeds/);
});

test('SFM camera covers the complete game grid without resolution-dependent stretching', () => {
    const options = { map: 'dota_ti10', worldExtent: [-10240, -10752, 10240, 10240], outputPrefix: 'capture/map' };
    const low = createSfmSession({ ...options, size: 1024 });
    const high = createSfmSession({ ...options, size: 8192 });
    assert.deepEqual(low.nominalWorldExtent, [-10496, -10752, 10496, 10240]);
    assert.deepEqual(high.nominalWorldExtent, low.nominalWorldExtent);
    assert.equal(high.cameraHeight, low.cameraHeight);
    assert.ok(high.cameraHeight > 1_000_000);
    assert.match(high.text, /"mapname" "string" "maps\/dota_ti10.vmap"/);
    assert.match(high.text, /"clipType" "int" "3"/); // Film clip, not an empty audio track.
    assert.match(high.text, /"orientation" "quaternion" "-0.5 0.5 0.5 0.5"/);
    assert.match(high.text, /"UseMoviePostRenderCommand" "bool" "0"/);
    assert.throws(() => createSfmSession({ ...options, map: '../other' }), /Invalid/);
    assert.throws(() => createSfmSession({ ...options, worldExtent: [1, 1, 0, 0] }), /Invalid/);
});

test('SFM sweep creates a square-world 5 by 9 sequence of zoomed camera tiles', () => {
    const sweep = createSfmSweepSession({ map: 'dota', worldExtent: [-10208, -10720, 10208, 10208],
        outputPrefix: 'capture/tile' });
    assert.equal(sweep.tiles.length, 45);
    assert.equal(sweep.sequenceDuration, 45);
    assert.deepEqual(sweep.nominalWorldExtent, [-10464, -10720, 10464, 10208]);
    assert.equal(sweep.tiles[0].row, 0);
    assert.equal(sweep.tiles[0].column, 0);
    assert.equal(sweep.tiles.at(-1).index, 44);
    assert.ok(sweep.tiles[0].cameraHeight < 400_000);
    assert.ok(sweep.tiles[0].viewWidth < 5000);
    assert.match(sweep.text, /"TimeRangeEndTime" "float" "45"/);
    assert.match(sweep.text, /"DmeAnimationSet"/);
    assert.match(sweep.text, /"times" "time_array".*"44\.0000"/);
    assert.match(sweep.text, /"values" "vector3_array"/);
    assert.equal(sweep.tiles[4].column, 4);
    assert.equal(sweep.tiles[5].row, 1);
    assert.equal(sweep.tiles[5].column, 4);
    assert.equal(sweep.tiles[9].column, 0);
    assert.equal(sweep.tiles[0].cameraHeight,
        sweep.tiles[0].viewWidth / (2 * Math.tan(Math.PI / 360)));
    assert.throws(() => createSfmSweepSession({ map: 'dota', worldExtent: [0, 0, 10, 10], columns: 21 }), /Invalid/);
});

test('terrain import rejects magenta renderer errors while allowing isolated purple detail', () => {
    const png = new PNG({ width: 100, height: 100 });
    for (let i = 0; i < png.data.length; i += 4) png.data.set([50, 130, 80, 255], i);
    png.data.set([230, 20, 230, 255], 0);
    assert.doesNotThrow(() => assertUsableImage(png));
    for (let i = 0; i < 400; i += 4) png.data.set([230, 20, 230, 255], i);
    assert.throws(() => assertUsableImage(png), /magenta.*renderer/i);
});

test('skin import verifies scan provenance, calibration and registration before writing assets', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'map-skins-import-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const patchDirectory = path.join(directory, 'assets/data/test');
    const scanDirectory = path.join(directory, 'scan');
    fs.mkdirSync(patchDirectory, { recursive: true });
    fs.mkdirSync(scanDirectory);
    const hash = value => createHash('sha256').update(value).digest('hex');
    const terrain = { map: 'dota_ti10', name: 'Sanctums of the Divine', itemId: '21441' };
    const grid = JSON.stringify(sampleGrid());
    const nav = Buffer.from('identical source navigation');
    for (const location of [patchDirectory, scanDirectory]) {
        fs.writeFileSync(path.join(location, 'terrain_grid.json'), grid);
        fs.writeFileSync(path.join(location, 'gridnav.gnv'), nav);
    }
    const scan = { terrain, navigationSha256: hash(nav), terrainSha256: hash(grid), terrainArchiveSha256: 'archive-hash' };
    fs.writeFileSync(path.join(scanDirectory, 'scan.json'), JSON.stringify(scan));
    const png = new PNG({ width: 32, height: 32 });
    for (let i = 0; i < png.data.length; i += 4) png.data.set([i % 255, 30, 60, 255], i);
    const bytes = PNG.sync.write(png);
    const image = path.join(directory, 'image.png');
    const controls = path.join(directory, 'controls.json');
    fs.writeFileSync(image, bytes);
    const point = ([x, y]) => ({ world: [x * 64, (32 - y) * 64], pixel: [x, y] });
    const measured = {
        source: { sha256: hash(bytes), terrainMap: terrain.map, navigationSha256: hash(nav), terrainArchiveSha256: 'archive-hash' },
        width: 32, height: 32, maxErrorWorld: 32,
        anchors: [[2, 2], [29, 2], [2, 29], [29, 29]].map(point), checks: [[16, 16]].map(point),
    };
    const options = { terrain, image, controls, scanDirectory, patchDirectory, patch: 'test', repositoryRoot: directory };
    const writeControls = value => fs.writeFileSync(controls, JSON.stringify(value));
    writeControls({ ...measured, source: { ...measured.source, sha256: 'changed' } });
    await assert.rejects(() => importSkin(options), /Image differs/);
    writeControls({ ...measured, source: { ...measured.source, terrainArchiveSha256: 'another archive' } });
    await assert.rejects(() => importSkin(options), /different game files/);
    writeControls({ ...measured, checks: [{ ...measured.checks[0], pixel: [18, 16] }] });
    await assert.rejects(() => importSkin(options), /registration exceeds/);
    assert.equal(fs.existsSync(path.join(patchDirectory, 'skins.json')), false);
    writeControls(measured);
    await importSkin(options);
    const [registered] = JSON.parse(fs.readFileSync(path.join(patchDirectory, 'skins.json')));
    assert.equal(registered.id, 'skin-dota_ti10');
    assert.equal(registered.image, 'img/test/ti10.jpg');
    assert.deepEqual(registered.worldExtent, [0, 0, 2048, 2048]);
    const jpeg = fs.readFileSync(path.join(directory, 'assets', registered.image));
    assert.equal(jpeg.readUInt16BE(0), 0xffd8);
    assert.deepEqual(await sharp(jpeg).metadata().then(({ width, height }) => [width, height]), [32, 32]);
    assert.equal(registered.source.sha256, hash(bytes));
    assert.equal(fs.existsSync(path.join(directory, 'assets', 'img', 'test', 'ti10.source.png')), false);
    await assert.rejects(() => importSkin(options), /already registered/);
    fs.appendFileSync(path.join(scanDirectory, 'gridnav.gnv'), 'changed');
    await assert.rejects(() => importSkin(options), /Scan files changed/);
});
