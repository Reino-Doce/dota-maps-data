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
import { buildNpmPackagePlan } from '../scripts/prepare-npm-packages.mjs';
import { readPreparedWorldData } from '../src/node/patch-inputs.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

test('manifest checksums cover every committed map asset and registered image', () => {
    const manifest = readMapManifest();
    const entries = [...manifest.patches.flatMap(patch => patch.files), ...manifest.shared, ...manifest.images];
    assert.ok(manifest.patches.length >= 12);
    assert.equal(manifest.currentPatch, '741f');
    assert.equal(manifest.latestPackage.sourcePackageName, `@reino-doce/dota-maps-data-${manifest.currentPatch}`);
    assert.equal(new Set(entries.map(entry => entry.path)).size, entries.length);
    for (const entry of entries) {
        const bytes = fs.readFileSync(resolveAssetPath(entry.path));
        assert.equal(bytes.length, entry.bytes, entry.path);
        assert.equal(sha256(bytes), entry.sha256, entry.path);
    }
    for (const skin of readMapData('741f', 'skins.json')) assert.ok(fs.existsSync(resolveAssetPath(skin.image)), skin.image);
    const screenshot = readMapData('741f', 'screenshot.json');
    assert.ok(fs.existsSync(resolveAssetPath(screenshot.image)), screenshot.image);
    assert.deepEqual(readMapData('latest', 'overview.json'), readMapData(manifest.currentPatch, 'overview.json'));
});

test('latest import paths resolve current map data, standard images, and selected skin images', () => {
    const manifest = readMapManifest();
    const cases = [
        ['@reino-doce/dota-maps-data/latest/mapdata.json', 'latest/mapdata.json'],
        ['@reino-doce/dota-maps-data/latest/dota-map.png', 'latest/dota-map.png'],
        ['@reino-doce/dota-maps-data/latest/autumn/dota_autumn.png', 'latest/autumn/dota_autumn.png'],
    ];
    for (const [specifier, assetPath] of cases) {
        assert.equal(
            path.resolve(fileURLToPath(import.meta.resolve(specifier))),
            path.resolve(resolveAssetPath(assetPath)),
            specifier,
        );
    }
    assert.deepEqual(readMapData('latest'), readMapData(manifest.currentPatch));
});

test('npm map packages are self-contained and do not depend on generation tooling', () => {
    const plan = buildNpmPackagePlan();
    assert.equal(plan.patchPackages.length, plan.manifest.patches.length);
    assert.equal(plan.latestPackage.name, '@reino-doce/dota-maps-data-latest');
    assert.equal(plan.latestPackage.patch.id, plan.manifest.currentPatch);
    for (const item of plan.packages) {
        assert.equal(item.packageJson.exports['./latest/mapdata.json'],
            './assets/data/' + item.patch.id + '/mapdata.json');
        assert.equal(item.packageJson.exports['./' + item.patch.id + '/mapdata.json'],
            './assets/data/' + item.patch.id + '/mapdata.json');
        assert.equal(item.packageJson.exports['./' + item.patch.id + '/*'],
            './assets/data/' + item.patch.id + '/*');
        for (const image of item.images) {
            assert.equal(item.packageJson.exports['./latest/' + path.posix.basename(image.path)],
                './assets/' + image.path);
        }
    }
    for (const item of plan.packages) {
        assert.equal(item.packageJson.dependencies, undefined, item.name);
        assert.equal(item.packageJson.devDependencies, undefined, item.name);
        assert.ok(item.patch.files.length > 0, item.name);
        assert.ok(item.shared.some(entry => entry.path.startsWith('data/legacy/')), item.name);
        assert.equal(item.packageJson.exports['./data/*'], `./assets/data/${item.patch.id}/*`);
    }
    assert.equal(plan.latestPackage.images.some(entry => entry.path.startsWith('img/skins/')), false,
        'the latest data package keeps large optional terrain images separate');
    const currentPatchPackage = plan.patchPackages.find(item => item.id === plan.manifest.currentPatch);
    assert.ok(currentPatchPackage.skins.length > 0);
    for (const skin of currentPatchPackage.skins) {
        assert.equal(currentPatchPackage.packageJson.exports['./images/' + currentPatchPackage.id + '/' + skin.id],
            './skin-exports/' + currentPatchPackage.id + '/' + skin.id + '.mjs');
        assert.equal(plan.latestPackage.packageJson.exports['./images/latest/' + skin.id],
            './skin-exports/' + currentPatchPackage.id + '/' + skin.id + '.mjs');
    }
    assert.equal(plan.skinPackages.length, plan.manifest.skinPackages.length);
    assert.equal(plan.skinsAggregatePackage.name, '@reino-doce/dota-map-skins-latest');
    for (const skin of plan.skinPackages) {
        assert.equal(skin.packageJson.dependencies, undefined, skin.name);
        assert.equal(skin.packageJson.exports['./latest/' + skin.id + '/' + path.posix.basename(skin.image.path)],
            './assets/' + skin.image.path);
        assert.ok(skin.image.bytes < 100_000_000, `${skin.name} should remain an independently publishable package`);
    }
    for (const item of plan.patchPackages.filter(entry => entry.id !== plan.manifest.currentPatch)) {
        assert.equal(item.images.some(entry => entry.path.startsWith('img/skins/')), false, item.name);
    }
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
