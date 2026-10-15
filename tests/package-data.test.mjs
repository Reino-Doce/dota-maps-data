import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readMapData, readMapManifest, resolveAssetPath } from '../src/node/index.mjs';
import { importOverview } from '../scripts/import-overview.mjs';
import { importScreenshot } from '../scripts/import-screenshot.mjs';
import { readPreparedWorldData } from '../src/node/patch-inputs.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

test('manifest checksums cover every committed map asset and registered image', () => {
    const manifest = readMapManifest();
    const entries = [...manifest.patches.flatMap(patch => patch.files), ...manifest.shared, ...manifest.images];
    assert.ok(manifest.patches.length >= 12);
    assert.equal(new Set(entries.map(entry => entry.path)).size, entries.length);
    for (const entry of entries) {
        const bytes = fs.readFileSync(resolveAssetPath(entry.path));
        assert.equal(bytes.length, entry.bytes, entry.path);
        assert.equal(sha256(bytes), entry.sha256, entry.path);
    }
    for (const skin of readMapData('741f', 'skins.json')) assert.ok(fs.existsSync(resolveAssetPath(skin.image)), skin.image);
    const screenshot = readMapData('741f', 'screenshot.json');
    assert.ok(fs.existsSync(resolveAssetPath(screenshot.image)), screenshot.image);
});

test('overview and screenshot importers generate an additional explicit patch from prepared sources', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dota-maps-data-input-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const assetDirectory = path.join(directory, 'assets');
    const patchDirectory = path.join(assetDirectory, 'data', 'test42');
    fs.mkdirSync(patchDirectory, { recursive: true });
    fs.mkdirSync(path.join(assetDirectory, 'img'), { recursive: true });
    fs.copyFileSync(resolveAssetPath('img/dota-map-741f.png'), path.join(assetDirectory, 'img/dota-map-test42.png'));
    fs.copyFileSync(resolveAssetPath('data/741f/screenshot-controls.json'), path.join(patchDirectory, 'screenshot-controls.json'));

    const overviewInput = path.join(directory, 'prepared-overview.txt');
    const screenshotInput = path.join(directory, 'prepared-screenshot.jpg');
    fs.copyFileSync(resolveAssetPath('data/741f/overview.txt'), overviewInput);
    fs.copyFileSync(resolveAssetPath('img/dota-game-map-741f.jpg'), screenshotInput);
    const overview = importOverview({ patch: 'test42', sourceFile: path.relative(process.cwd(), overviewInput), assetDirectory });
    const screenshot = importScreenshot({ patch: 'test42', input: path.relative(process.cwd(), screenshotInput), assetDirectory });

    assert.equal(JSON.parse(fs.readFileSync(path.join(patchDirectory, 'overview.json'), 'utf8')).scale, overview.scale);
    assert.equal(screenshot.image, 'img/dota-game-map-test42.jpg');
    assert.ok(fs.existsSync(path.join(assetDirectory, screenshot.image)));
    assert.throws(() => readPreparedWorldData({ patch: 'test42', assetDirectory }), /missing its prepared worlddata\.json/);
});

test('importing the Node package entry point does not write files or launch processes', () => {
    const script = `
        import { syncBuiltinESMExports } from 'node:module';
        import fs from 'node:fs';
        import childProcess from 'node:child_process';
        const forbidden = () => { throw new Error('import caused a side effect'); };
        for (const name of ['writeFile', 'writeFileSync', 'mkdir', 'mkdirSync', 'rename', 'renameSync', 'unlink', 'unlinkSync']) fs[name] = forbidden;
        for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[name] = forbidden;
        syncBuiltinESMExports();
        await import('./src/node/index.mjs');
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
});
