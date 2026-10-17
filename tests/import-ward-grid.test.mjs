import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { importWardGrid } from '../scripts/import-ward-grid.mjs';

function copy(directory, relativePath) {
    const source = path.resolve('assets', relativePath);
    const target = path.join(directory, 'assets', relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
}

test('ward generation uses exact patch GNV provenance and the nested patch raster', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dota-map-ward-import-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    for (const filename of ['data/741/source.json', 'data/741/gridnav.gnv', 'data/741/terrain_grid.json',
        'data/741/ward_structures.json', 'data/741/worlddata.json', 'img/741/map_data.png']) copy(directory, filename);

    const result = importWardGrid({ patch: '741', assetDirectory: path.join(directory, 'assets') });
    const wardGrid = JSON.parse(fs.readFileSync(path.join(directory, 'assets/data/741/ward_grid.json'), 'utf8'));
    const source = JSON.parse(fs.readFileSync(path.join(directory, 'assets/data/741/source.json'), 'utf8'));
    assert.equal(result.width, 320);
    assert.equal(result.height, 328);
    assert.equal(wardGrid.source.file, source.resources.navigation.path);
    assert.equal(wardGrid.source.sha256, source.resources.navigation.sha256);
    assert.match(source.dataCoverage.wardRestrictions, /this patch ward_grid\.json/u);
    assert.equal(fs.existsSync(path.join(directory, 'assets/img/741/map_data.png')), true);
    assert.equal(fs.existsSync(path.join(directory, 'assets/img/map_data_741.png')), false);
});

test('a patch with no native navigation refuses to synthesize ward restrictions', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dota-map-ward-no-gnv-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const dataDirectory = path.join(directory, 'assets/data/728');
    fs.mkdirSync(dataDirectory, { recursive: true });
    fs.copyFileSync(path.resolve('assets/data/728/source.json'), path.join(dataDirectory, 'source.json'));
    assert.throws(() => importWardGrid({ patch: '728', assetDirectory: path.join(directory, 'assets') }), /no exact native navigation grid/u);
    assert.equal(fs.existsSync(path.join(dataDirectory, 'ward_grid.json')), false);
});
