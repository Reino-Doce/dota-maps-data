import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { discoverAvailableMapImages, planTileGrid, reconstructAllAvailableMapImages,
    reconstructDefaultMapImage, reconstructMapImage } from '../scripts/reconstruct-default-images.mjs';

async function writeTile(directory, x, y, color) {
    await sharp({ create: { width: 8, height: 8, channels: 3, background: color } })
        .jpeg({ quality: 100, chromaSubsampling: '4:4:4' })
        .toFile(path.join(directory, `tile_${x}_${y}.jpg`));
}

test('version-4 tile planner orders a complete square grid and rejects gaps', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dota-map-tile-plan-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    for (const [x, y] of [[1, 1], [0, 1], [1, 0], [0, 0]]) {
        fs.writeFileSync(path.join(directory, `tile_${x}_${y}.jpg`), 'fixture');
    }
    const grid = planTileGrid(directory);
    assert.deepEqual(grid.tiles.map(({ x, y }) => [x, y]), [[0, 0], [1, 0], [0, 1], [1, 1]]);
    fs.unlinkSync(path.join(directory, 'tile_1_1.jpg'));
    assert.throws(() => planTileGrid(directory), /missing tile_1_1\.jpg/);
});

test('tile reconstruction writes a correctly ordered JPEG and preserves existing output by default', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dota-map-tile-reconstruction-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const tilesRoot = path.join(directory, 'tiles');
    const tileDirectory = path.join(tilesRoot, 'test42', 'default', '4');
    const outputDirectory = path.join(directory, 'assets', 'img');
    fs.mkdirSync(tileDirectory, { recursive: true });
    await writeTile(tileDirectory, 0, 0, { r: 240, g: 20, b: 30 });
    await writeTile(tileDirectory, 1, 0, { r: 20, g: 230, b: 40 });
    await writeTile(tileDirectory, 0, 1, { r: 30, g: 40, b: 220 });
    await writeTile(tileDirectory, 1, 1, { r: 230, g: 220, b: 20 });

    const result = await reconstructDefaultMapImage({ tilesRoot, patch: 'test42', outputDirectory });
    assert.deepEqual([result.width, result.height, result.tileCount], [16, 16, 4]);
    assert.equal(path.basename(result.destination), 'default.jpg');
    const { data, info } = await sharp(result.destination).raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual([info.width, info.height], [16, 16]);
    const pixel = (x, y) => [...data.subarray((y * info.width + x) * info.channels,
        (y * info.width + x) * info.channels + 3)];
    const closeTo = (actual, expected) => actual.every((value, index) => Math.abs(value - expected[index]) < 12);
    assert.ok(closeTo(pixel(4, 4), [240, 20, 30]));
    assert.ok(closeTo(pixel(12, 4), [20, 230, 40]));
    assert.ok(closeTo(pixel(4, 12), [30, 40, 220]));
    assert.ok(closeTo(pixel(12, 12), [230, 220, 20]));

    const previousBytes = fs.readFileSync(result.destination);
    await assert.rejects(() => reconstructDefaultMapImage({ tilesRoot, patch: 'test42', outputDirectory }), /Refusing to overwrite/);
    assert.deepEqual(fs.readFileSync(result.destination), previousBytes);
});

test('tile reconstruction does not fall back when a matching patch has no version-4 source', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dota-map-tile-missing-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    await assert.rejects(() => reconstructDefaultMapImage({ tilesRoot: directory, patch: '723' }), /Missing matching version-4 tile directory/);
});

test('tile reconstruction preserves patch and skin identity and discovers all exact version-4 sources', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dota-map-tile-skins-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const tilesRoot = path.join(directory, 'tiles');
    const outputDirectory = path.join(directory, 'assets', 'img');
    for (const skin of ['default', 'autumn', 'reef']) {
        const tileDirectory = path.join(tilesRoot, '706', skin, '4');
        fs.mkdirSync(tileDirectory, { recursive: true });
        await writeTile(tileDirectory, 0, 0, { r: 80, g: 100, b: 120 });
    }
    assert.deepEqual(discoverAvailableMapImages(tilesRoot), [
        { patch: '706', skin: 'autumn' },
        { patch: '706', skin: 'default' },
        { patch: '706', skin: 'reef' },
    ]);
    const skin = await reconstructMapImage({ tilesRoot, patch: '706', skin: 'autumn', outputDirectory });
    assert.equal(skin.destination, path.join(outputDirectory, '706', 'autumn.jpg'));
    const results = await reconstructAllAvailableMapImages({ tilesRoot, outputDirectory });
    assert.deepEqual(results.map(({ skin: name, skipped }) => [name, skipped ?? false]), [
        ['autumn', true], ['default', false], ['reef', false],
    ]);
});
