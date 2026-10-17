import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PNG } from 'pngjs';
import { generateAllVisionAssets, generateVisionAssets } from '../scripts/import-vision-grid.mjs';
import { readGridNav } from '../scripts/ward-grid.mjs';

function copyCurrentVisionInputs(destinationDirectory) {
    const sourceDirectory = path.resolve('assets/data/741');
    fs.mkdirSync(destinationDirectory, { recursive: true });
    for (const filename of ['gridnav.gnv', 'terrain_grid.json', 'fow_blockers.json', 'mapdata.json', 'source.json']) {
        fs.copyFileSync(path.join(sourceDirectory, filename), path.join(destinationDirectory, filename));
    }
    const mapArchiveSha256 = 'a'.repeat(64);
    const mapEntitiesSha256 = 'b'.repeat(64);
    const navigationSha256 = createHash('sha256').update(fs.readFileSync(path.join(destinationDirectory, 'gridnav.gnv'))).digest('hex');
    const mapResource = 'maps/dota.vmap_c';
    const source = {
        patch: '741',
        archiveSha256: mapArchiveSha256,
        resources: {
            map: { path: mapResource },
            entities: { sha256: mapEntitiesSha256 },
            navigation: { available: true, sha256: navigationSha256 },
        },
    };
    const terrainPath = path.join(destinationDirectory, 'terrain_grid.json');
    const terrain = JSON.parse(fs.readFileSync(terrainPath, 'utf8'));
    terrain.origin = readGridNav(fs.readFileSync(path.join(destinationDirectory, 'gridnav.gnv'))).origin;
    terrain.source = {
        ...terrain.source,
        patch: '741',
        mapArchiveSha256,
        mapResource,
        mapEntitiesSha256,
        navigationSha256,
    };
    fs.writeFileSync(terrainPath, JSON.stringify(terrain));
    fs.writeFileSync(path.join(destinationDirectory, 'source.json'), JSON.stringify(source));
}

test('terrain generation writes map data under its patch and consumes matching prepared inputs', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dota-map-vision-import-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const fixtureDirectory = path.join(directory, 'assets', 'data', '741');
    copyCurrentVisionInputs(fixtureDirectory);

    const result = generateVisionAssets({ patch: '741', assetDirectory: path.join(directory, 'assets') });
    const imagePath = path.join(directory, 'assets', 'img', '741', 'map_data.png');
    const image = PNG.sync.read(fs.readFileSync(imagePath));
    assert.deepEqual([result.width, result.height, result.blockerCount], [320, 328, 393]);
    assert.deepEqual([image.width, image.height], [1600, 328]);
    assert.equal(fs.existsSync(path.join(directory, 'assets', 'img', 'map_data_741.png')), false);
    assert.equal(fs.existsSync(path.join(directory, 'assets', 'data', '741', 'worlddata.json')), true);
});

test('all-patch terrain generation imports complete datasets and reports missing exact inputs', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dota-map-vision-import-all-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const dataDirectory = path.join(directory, 'assets', 'data');
    copyCurrentVisionInputs(path.join(dataDirectory, '741'));
    fs.mkdirSync(path.join(dataDirectory, '706'), { recursive: true });
    fs.writeFileSync(path.join(dataDirectory, '706', 'mapdata.json'), '{}');
    fs.mkdirSync(path.join(directory, 'assets', 'img', '683'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'assets', 'img', '683', 'simple.png'), 'minimap');
    fs.writeFileSync(path.join(directory, 'assets', 'img', '683', 'illustrated.png'), 'minimap');

    const result = generateAllVisionAssets({ assetDirectory: path.join(directory, 'assets') });
    assert.deepEqual(result.generated.map(({ patch }) => patch), ['741']);
    assert.deepEqual(result.skipped, [
        { patch: '683', missing: ['assets/data/683/'], outputExists: false },
        { patch: '706', missing: ['terrain_grid.json', 'fow_blockers.json', 'source.json'], outputExists: false },
    ]);
    assert.deepEqual(result.failed, []);
    assert.equal(fs.existsSync(path.join(directory, 'assets', 'img', '741', 'map_data.png')), true);
});

test('terrain and FOW overlays remain available when the exact patch archive has no GNV', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dota-map-vision-no-gnv-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const assets = path.join(directory, 'assets');
    const dataDirectory = path.join(assets, 'data', '728');
    fs.mkdirSync(dataDirectory, { recursive: true });
    const source = JSON.parse(fs.readFileSync('assets/data/728/source.json', 'utf8'));
    fs.copyFileSync('assets/data/728/source.json', path.join(dataDirectory, 'source.json'));
    fs.copyFileSync('assets/data/728/mapdata.json', path.join(dataDirectory, 'mapdata.json'));
    fs.copyFileSync('assets/data/728/fow_blockers.json', path.join(dataDirectory, 'fow_blockers.json'));
    fs.writeFileSync(path.join(dataDirectory, 'terrain_grid.json'), JSON.stringify({
        width: 3, height: 2, cellSize: 64, origin: [-96, -64],
        heights: [[0, 128, 128], [0, 0, 256]], trees: [[0, 0, 0]], entities: [], pits: [],
        source: { patch: '728', mapArchiveSha256: source.archiveSha256,
            mapResource: source.resources.map.path, mapEntitiesSha256: source.resources.entities.sha256,
            navigationSha256: null },
    }));

    const result = generateVisionAssets({ patch: '728', assetDirectory: assets });
    assert.deepEqual([result.width, result.height, result.navigationAvailable], [3, 2, false]);
    assert.equal(fs.existsSync(path.join(dataDirectory, 'worlddata.json')), true);
    assert.equal(fs.existsSync(path.join(dataDirectory, 'elevation.json')), true);
    assert.equal(fs.existsSync(path.join(dataDirectory, 'ent_fow_blocker_node.json')), true);
    assert.equal(fs.existsSync(path.join(assets, 'img', '728', 'map_data.png')), false);
    const generatedSource = JSON.parse(fs.readFileSync(path.join(dataDirectory, 'source.json'), 'utf8'));
    assert.match(generatedSource.dataCoverage.mapDataRaster, /exact map archive has no GNV/u);
    assert.equal(fs.existsSync(path.join(dataDirectory, 'ward_grid.json')), false);
});
