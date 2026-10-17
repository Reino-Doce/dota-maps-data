import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PNG } from 'pngjs';
import sharp from 'sharp';
import { prepareDefaultImageCapture, restoreDefaultImageSource, stageDefaultImageSource, stitchDefaultImage } from '../scripts/generate-default-images.mjs';

function renderedTile(width, height, tileIndex) {
    const png = new PNG({ width, height });
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const offset = (y * width + x) * 4;
            png.data.set([20 + x % 220, 20 + y % 220, 45 + tileIndex * 40, 255], offset);
        }
    }
    return PNG.sync.write(png);
}

function mapVpk(map, payload) {
    const entry = Buffer.alloc(18);
    entry.writeUInt16LE(0x7fff, 6);
    entry.writeUInt32LE(0, 8);
    entry.writeUInt32LE(payload.length, 12);
    entry.writeUInt16LE(0xffff, 16);
    const tree = Buffer.concat([Buffer.from(`vmap_c\0maps\0${map}\0`), entry, Buffer.from([0, 0, 0])]);
    const header = Buffer.alloc(12);
    header.writeUInt32LE(0x55aa1234, 0);
    header.writeUInt32LE(1, 4);
    header.writeUInt32LE(tree.length, 8);
    return Buffer.concat([header, tree, payload]);
}

test('prepared capture selects the map path embedded in the patch VPK', async t => {
    const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dota-map-capture-prepare-'));
    const gameDirectory = path.join(repositoryRoot, 'game');
    const sourceArchive = path.join(gameDirectory, 'dota', 'maps', 'dota_706.vpk');
    t.after(() => fs.rmSync(repositoryRoot, { recursive: true, force: true }));
    fs.mkdirSync(path.dirname(sourceArchive), { recursive: true });
    fs.mkdirSync(path.join(gameDirectory, 'dota'), { recursive: true });
    fs.mkdirSync(path.join(repositoryRoot, 'assets', 'data', '706'), { recursive: true });
    fs.writeFileSync(path.join(gameDirectory, 'dota', 'pak01_dir.vpk'), 'fixture');
    fs.writeFileSync(sourceArchive, mapVpk('dota', Buffer.from('706 game map')));
    fs.writeFileSync(path.join(repositoryRoot, 'assets', 'data', '706', 'worlddata.json'), JSON.stringify({
        worldMinX: -100, worldMinY: -100, worldMaxX: 100, worldMaxY: 100,
    }));

    const prepared = prepareDefaultImageCapture({ patch: '706', gameDirectory, archivePath: sourceArchive, repositoryRoot });
    const session = fs.readFileSync(prepared.sessionPath, 'utf8');
    const manifest = JSON.parse(fs.readFileSync(prepared.manifestPath, 'utf8'));
    assert.equal(prepared.map, 'dota');
    assert.equal(prepared.sessionMap, 'dota');
    assert.match(path.basename(prepared.outputPrefix), /sweep-tile-706-dota-/);
    assert.match(session, /"mapname" "string" "maps\/dota\.vmap"/);
    assert.equal(manifest.sessionMap, 'dota');
});

test('default map image stitching validates every tile and writes a square JPEG', async t => {
    const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dota-default-image-'));
    t.after(() => fs.rmSync(repositoryRoot, { recursive: true, force: true }));
    const captureDirectory = path.join(repositoryRoot, 'map-captures/default-image-sweep/test');
    const outputPrefix = path.join(captureDirectory, 'tile');
    fs.mkdirSync(captureDirectory, { recursive: true });
    fs.writeFileSync(path.join(captureDirectory, 'capture.json'), JSON.stringify({
        patch: 'test',
        worldExtent: [0, 0, 100, 100],
        frame: { width: 200, height: 120, frameRate: 1 },
        tiles: { columns: 2, rows: 1, overlap: 1.1, prefix: outputPrefix,
            frames: [{ index: 0, row: 0, column: 1 }, { index: 1, row: 0, column: 0 }] },
        source: { archiveSha256: 'fixture' },
    }));
    fs.writeFileSync(`${outputPrefix}000000.png`, renderedTile(200, 120, 0));
    await assert.rejects(() => stitchDefaultImage({ patch: 'test', repositoryRoot, size: 256 }), /Missing rendered tile/);
    fs.writeFileSync(`${outputPrefix}000001.png`, renderedTile(200, 120, 1));

    const result = await stitchDefaultImage({ patch: 'test', repositoryRoot, size: 256 });
    assert.equal(result.tileCount, 2);
    assert.equal(result.archiveSha256, 'fixture');
    assert.deepEqual(await sharp(result.outputPath).metadata().then(({ format, width, height }) => [format, width, height]),
        ['jpeg', 256, 256]);
    const { data, info } = await sharp(result.outputPath).raw().toBuffer({ resolveWithObject: true });
    const leftBlue = data[(128 * info.width + 32) * info.channels + 2];
    const rightBlue = data[(128 * info.width + 224) * info.channels + 2];
    assert.ok(leftBlue > rightBlue + 25, 'snake-ordered frames must be placed into their declared map cells');
    await assert.rejects(() => stitchDefaultImage({ patch: 'test', repositoryRoot, size: 256 }), /already exists/);
});

test('default map image stitch rejects unusable render tiles', async t => {
    const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dota-default-image-empty-'));
    t.after(() => fs.rmSync(repositoryRoot, { recursive: true, force: true }));
    const captureDirectory = path.join(repositoryRoot, 'map-captures/default-image-sweep/test');
    const outputPrefix = path.join(captureDirectory, 'tile');
    fs.mkdirSync(captureDirectory, { recursive: true });
    fs.writeFileSync(path.join(captureDirectory, 'capture.json'), JSON.stringify({
        patch: 'test',
        worldExtent: [0, 0, 100, 100],
        frame: { width: 200, height: 120, frameRate: 1 },
        tiles: { columns: 1, rows: 1, overlap: 1.1, prefix: outputPrefix },
        source: { archiveSha256: 'fixture' },
    }));
    const empty = new PNG({ width: 200, height: 120 });
    empty.data.fill(0);
    fs.writeFileSync(`${outputPrefix}000000.png`, PNG.sync.write(empty));
    await assert.rejects(() => stitchDefaultImage({ patch: 'test', repositoryRoot, size: 256 }),
        /not a usable game render/);
});

test('default map image stitch permits only the two opposite black map-boundary corners', async t => {
    const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dota-default-image-corners-'));
    t.after(() => fs.rmSync(repositoryRoot, { recursive: true, force: true }));
    const captureDirectory = path.join(repositoryRoot, 'map-captures/default-image-sweep/test');
    const outputPrefix = path.join(captureDirectory, 'tile');
    fs.mkdirSync(captureDirectory, { recursive: true });
    fs.writeFileSync(path.join(captureDirectory, 'capture.json'), JSON.stringify({
        patch: 'test',
        worldExtent: [0, 0, 100, 100],
        frame: { width: 200, height: 120, frameRate: 1 },
        tiles: { columns: 2, rows: 2, overlap: 1.1, prefix: outputPrefix,
            frames: Array.from({ length: 4 }, (_, index) => ({ index, row: Math.floor(index / 2), column: index % 2 })) },
        source: { archiveSha256: 'fixture' },
    }));
    for (let index = 0; index < 4; index += 1) {
        const tile = index === 1 || index === 2 ? new PNG({ width: 200, height: 120 }) : null;
        if (tile) {
            for (let alpha = 3; alpha < tile.data.length; alpha += 4) tile.data[alpha] = 255;
            fs.writeFileSync(`${outputPrefix}${String(index).padStart(6, '0')}.png`, PNG.sync.write(tile));
        }
        else fs.writeFileSync(`${outputPrefix}${String(index).padStart(6, '0')}.png`, renderedTile(200, 120, index));
    }

    const result = await stitchDefaultImage({ patch: 'test', repositoryRoot, size: 256 });
    assert.equal(result.tileCount, 4);
    assert.deepEqual(await sharp(result.outputPath).metadata().then(({ format, width, height }) => [format, width, height]),
        ['jpeg', 256, 256]);
});

test('map archive staging replaces the add-on VPK with the exact patch and restores it safely', async t => {
    const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dota-map-package-stage-'));
    const gameDirectory = path.join(repositoryRoot, 'game');
    const addonArchivePath = path.join(gameDirectory, 'dota_addons', 'capture', 'maps', 'dota.vpk');
    const sourceArchive = path.join(gameDirectory, 'dota', 'maps', 'dota_706.vpk');
    const captureDirectory = path.join(repositoryRoot, 'map-captures/default-image-sweep/706');
    t.after(() => fs.rmSync(repositoryRoot, { recursive: true, force: true }));
    fs.mkdirSync(path.dirname(addonArchivePath), { recursive: true });
    fs.mkdirSync(path.dirname(sourceArchive), { recursive: true });
    fs.mkdirSync(captureDirectory, { recursive: true });
    fs.mkdirSync(path.join(gameDirectory, 'dota'), { recursive: true });
    fs.writeFileSync(path.join(gameDirectory, 'dota', 'pak01_dir.vpk'), 'fixture');

    const original = mapVpk('dota', Buffer.from('original workshop map'));
    const sourcePayload = Buffer.from('706 game map');
    const source = mapVpk('dota', sourcePayload);
    fs.writeFileSync(addonArchivePath, original);
    fs.writeFileSync(sourceArchive, source);
    const archiveSha256 = createHash('sha256').update(source).digest('hex');
    fs.writeFileSync(path.join(captureDirectory, 'capture.json'), JSON.stringify({
        patch: '706', map: 'dota', sessionMap: 'dota', source: { archiveSha256, mapResource: 'maps/dota.vmap_c' },
    }));
    const sessionPath = path.join(captureDirectory, 'session.dmx');
    fs.writeFileSync(sessionPath, '"mapname" "string" "maps/dota.vmap"\n');
    assert.throws(() => stageDefaultImageSource({ patch: '706', gameDirectory, archivePath: sourceArchive,
        addonArchivePath: path.join(path.dirname(addonArchivePath), 'dota_706.vpk'), repositoryRoot }), /must be named dota\.vpk/);
    fs.writeFileSync(sessionPath, '"mapname" "string" "maps/dota_706.vmap"\n');
    assert.throws(() => stageDefaultImageSource({ patch: '706', gameDirectory, archivePath: sourceArchive,
        addonArchivePath, repositoryRoot }), /does not select maps\/dota\.vmap/);
    fs.writeFileSync(sessionPath, '"mapname" "string" "maps/dota.vmap"\n');

    const staged = stageDefaultImageSource({ patch: '706', gameDirectory, archivePath: sourceArchive,
        addonArchivePath, repositoryRoot });
    assert.equal(staged.sourceSha256, archiveSha256);
    assert.equal(staged.stagedSha256, archiveSha256);
    assert.equal(staged.sessionMap, 'dota');
    assert.equal(staged.stagedArchive, addonArchivePath);
    assert.deepEqual(fs.readFileSync(addonArchivePath), source);
    const stageReceipt = JSON.parse(fs.readFileSync(staged.receiptPath, 'utf8'));
    assert.equal(stageReceipt.kind, 'map-image-vpk-stage');
    assert.equal(stageReceipt.source.archive, 'dota/maps/dota_706.vpk');
    assert.equal(stageReceipt.source.sha256, archiveSha256);
    assert.equal(stageReceipt.source.mapResource, 'maps/dota.vmap_c');
    assert.equal(stageReceipt.capture.manifestSha256,
        createHash('sha256').update(fs.readFileSync(path.join(captureDirectory, 'capture.json'))).digest('hex'));
    assert.equal(stageReceipt.session.sha256, createHash('sha256').update(fs.readFileSync(sessionPath)).digest('hex'));
    assert.equal(stageReceipt.destination.sha256, archiveSha256);

    fs.writeFileSync(addonArchivePath, 'unexpected change');
    assert.throws(() => restoreDefaultImageSource({ gameDirectory, addonArchivePath, repositoryRoot }),
        /Staged map VPK changed/);
    fs.writeFileSync(addonArchivePath, source);
    const restored = restoreDefaultImageSource({ gameDirectory, addonArchivePath, repositoryRoot });
    assert.equal(restored.restoredArchive, addonArchivePath);
    assert.equal(restored.restoredSha256, createHash('sha256').update(original).digest('hex'));
    assert.deepEqual(fs.readFileSync(addonArchivePath), original);
    const restoreReceipt = JSON.parse(fs.readFileSync(restored.receiptPath, 'utf8'));
    assert.equal(restoreReceipt.kind, 'map-image-vpk-restore');
    assert.equal(restoreReceipt.source.sha256, archiveSha256);
    assert.equal(restoreReceipt.destination.restoredSha256, restored.restoredSha256);
    assert.equal(fs.existsSync(path.join(repositoryRoot, 'map-captures/default-image-sweep/addon-map-vpk-overlay.json')), false);
    assert.equal(fs.existsSync(path.join(repositoryRoot, 'map-captures/default-image-sweep/addon-map.vpk.original')), false);
});

test('staging another patch keeps the original add-on VPK backup for final restoration', async t => {
    const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dota-versioned-map-stage-'));
    const gameDirectory = path.join(repositoryRoot, 'game');
    const addonArchivePath = path.join(gameDirectory, 'dota_addons', 'capture', 'maps', 'dota.vpk');
    const sourceArchive = path.join(gameDirectory, 'dota', 'maps', 'dota_728.vpk');
    const captureDirectory = path.join(repositoryRoot, 'map-captures/default-image-sweep/728');
    t.after(() => fs.rmSync(repositoryRoot, { recursive: true, force: true }));
    fs.mkdirSync(path.dirname(addonArchivePath), { recursive: true });
    fs.mkdirSync(path.dirname(sourceArchive), { recursive: true });
    fs.mkdirSync(captureDirectory, { recursive: true });
    fs.mkdirSync(path.join(gameDirectory, 'dota'), { recursive: true });
    fs.writeFileSync(path.join(gameDirectory, 'dota', 'pak01_dir.vpk'), 'fixture');

    const original = mapVpk('dota', Buffer.from('original workshop map'));
    const sourcePayload = Buffer.from('728 game map');
    const source = mapVpk('dota', sourcePayload);
    fs.writeFileSync(addonArchivePath, original);
    fs.writeFileSync(sourceArchive, source);
    const archiveSha256 = createHash('sha256').update(source).digest('hex');
    fs.writeFileSync(path.join(captureDirectory, 'capture.json'), JSON.stringify({
        patch: '728', map: 'dota', sessionMap: 'dota',
        source: { archiveSha256, mapResource: 'maps/dota.vmap_c' },
    }));
    fs.writeFileSync(path.join(captureDirectory, 'session.dmx'), '"mapname" "string" "maps/dota.vmap"\n');

    const staged = stageDefaultImageSource({ patch: '728', gameDirectory, archivePath: sourceArchive,
        addonArchivePath, repositoryRoot });
    assert.equal(staged.mapResource, 'maps/dota.vmap_c');
    assert.deepEqual(fs.readFileSync(addonArchivePath), source);
    const firstReceiptPath = staged.receiptPath;

    const nextCaptureDirectory = path.join(repositoryRoot, 'map-captures/default-image-sweep/729');
    fs.mkdirSync(nextCaptureDirectory, { recursive: true });
    const nextArchivePath = path.join(gameDirectory, 'dota', 'maps', 'dota_729.vpk');
    const nextSource = mapVpk('dota', Buffer.from('729 game map'));
    fs.writeFileSync(nextArchivePath, nextSource);
    const nextSha256 = createHash('sha256').update(nextSource).digest('hex');
    fs.writeFileSync(path.join(nextCaptureDirectory, 'capture.json'), JSON.stringify({
        patch: '729', map: 'dota', sessionMap: 'dota', source: { archiveSha256: nextSha256, mapResource: 'maps/dota.vmap_c' },
    }));
    fs.writeFileSync(path.join(nextCaptureDirectory, 'session.dmx'), '"mapname" "string" "maps/dota.vmap"\n');
    const nextStaged = stageDefaultImageSource({ patch: '729', gameDirectory, archivePath: nextArchivePath, addonArchivePath, repositoryRoot });
    assert.deepEqual(fs.readFileSync(addonArchivePath), nextSource);

    const restored = restoreDefaultImageSource({ gameDirectory, addonArchivePath, repositoryRoot });
    assert.deepEqual(fs.readFileSync(addonArchivePath), original);
    assert.equal(fs.existsSync(firstReceiptPath), true);
    assert.equal(fs.existsSync(nextStaged.receiptPath), true);
    assert.equal(fs.existsSync(restored.receiptPath), true);
    assert.equal(JSON.parse(fs.readFileSync(nextStaged.receiptPath, 'utf8')).source.sha256, nextSha256);
    assert.equal(JSON.parse(fs.readFileSync(restored.receiptPath, 'utf8')).destination.restoredSha256,
        createHash('sha256').update(original).digest('hex'));
});
