import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildNpmPackagePlan as buildNodePackagePlan, prepareNpmPackages,
    readMapData, readMapManifest, resolveAssetPath } from '../src/node/index.mjs';
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
    assert.equal(typeof buildNodePackagePlan, 'function');
    assert.equal(typeof prepareNpmPackages, 'function');
    assert.equal(plan.corePackageJson.exports['./node'], './src/node/index.mjs');
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
        assert.equal(skin.packageName, `@reino-doce/dota-map-skin-${currentPatchPackage.id}-${skin.id}`);
    }
    const currentSkinSet = plan.skinSetPackages.find(item => item.patchId === currentPatchPackage.id);
    assert.ok(currentSkinSet);
    assert.equal(currentPatchPackage.packageJson.exports['./images/' + currentPatchPackage.id],
        './skin-exports/' + currentPatchPackage.id + '/index.mjs');
    assert.equal(plan.latestPackage.packageJson.exports['./images/latest'],
        './skin-exports/' + currentPatchPackage.id + '/latest.mjs');
    assert.equal(currentSkinSet.name, `@reino-doce/dota-map-skins-${currentPatchPackage.id}`);
    assert.deepEqual(Object.keys(currentSkinSet.packageJson.dependencies).sort(),
        currentPatchPackage.skins.map(skin => skin.packageName).sort());
    assert.deepEqual(Object.keys(plan.skinsAggregatePackage.packageJson.dependencies).sort(),
        currentPatchPackage.skins.map(skin => skin.packageName).sort());
    assert.ok(plan.skinsAggregatePackage.packageJson.files.includes('index.mjs'));
    assert.equal(plan.skinPackages.length, plan.manifest.skinPackages.length);
    assert.equal(plan.skinsAggregatePackage.name, '@reino-doce/dota-map-skins-latest');
    for (const skin of plan.skinPackages) {
        assert.equal(skin.packageJson.dependencies, undefined, skin.name);
        assert.equal(skin.packageJson.exports['./image/' + path.posix.basename(skin.image.path)],
            './assets/' + skin.image.path);
        assert.ok(skin.image.bytes < 100_000_000, `${skin.name} should remain an independently publishable package`);
    }
    for (const item of plan.patchPackages.filter(entry => entry.id !== plan.manifest.currentPatch)) {
        assert.equal(item.images.some(entry => entry.path.startsWith('img/skins/')), false, item.name);
    }
});

test('each patch publishes only the terrain skins generated for that patch', t => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dota-maps-skin-patches-'));
    t.after(() => fs.rmSync(sourceRoot, { recursive: true, force: true }));
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const manifest = readMapManifest();
    const olderPatchSkin = {
        path: 'img/skins/723/dota_frost.png',
        bytes: 123,
        sha256: 'f'.repeat(64),
    };
    manifest.images.push(olderPatchSkin);
    manifest.skinPackages.push({
        id: 'frost',
        patchId: '723',
        packageName: '@reino-doce/dota-map-skin-723-frost',
        file: olderPatchSkin,
    });
    manifest.skinSetPackages['723'] = '@reino-doce/dota-map-skins-723';
    fs.writeFileSync(path.join(sourceRoot, 'package.json'), JSON.stringify(packageJson));
    fs.writeFileSync(path.join(sourceRoot, 'manifest.json'), JSON.stringify(manifest));

    const plan = buildNpmPackagePlan({ sourceRoot });
    const olderPatch = plan.patchPackages.find(item => item.id === '723');
    const olderSkinSet = plan.skinSetPackages.find(item => item.patchId === '723');
    const currentSkinSet = plan.skinSetPackages.find(item => item.patchId === manifest.currentPatch);
    assert.equal(olderPatch.skins.length, 1);
    assert.equal(olderPatch.skins[0].id, 'frost');
    assert.equal(olderPatch.packageJson.exports['./images/723/frost'], './skin-exports/723/frost.mjs');
    assert.equal(olderPatch.packageJson.exports['./images/723'], './skin-exports/723/index.mjs');
    assert.equal(olderPatch.packageJson.exports['./images/latest'], undefined);
    assert.deepEqual(Object.keys(olderSkinSet.packageJson.dependencies), ['@reino-doce/dota-map-skin-723-frost']);
    assert.ok(currentSkinSet.skins.every(skin => skin.patchId === manifest.currentPatch));
    assert.equal(plan.skinsAggregatePackage.skins.some(skin => skin.patchId === '723'), false);
    assert.equal(plan.skinPackages.find(skin => skin.patchId === '723').packageJson.exports['./latest/frost/dota_frost.png'], undefined);
});

test('package generation writes separate skin sets and single-image packages per patch', t => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dota-maps-skin-package-generation-'));
    t.after(() => fs.rmSync(sourceRoot, { recursive: true, force: true }));
    const assetRoot = path.join(sourceRoot, 'assets');
    const outputRoot = path.join(sourceRoot, 'npm-packages');
    const writeAsset = (assetPath, content) => {
        const bytes = Buffer.from(content);
        const filename = path.join(assetRoot, ...assetPath.split('/'));
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        fs.writeFileSync(filename, bytes);
        return { path: assetPath, bytes: bytes.length, sha256: sha256(bytes) };
    };
    for (const directory of ['src', 'dist', 'scripts']) fs.mkdirSync(path.join(sourceRoot, directory));
    fs.mkdirSync(path.join(assetRoot, 'data', 'legacy'), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, 'README.md'), '# Package fixture\n');

    const shared = [writeAsset('data/legacy/worlddata.json', '{}')];
    const oldData = [writeAsset('data/700/mapdata.json', '{}')];
    const currentData = [writeAsset('data/741f/mapdata.json', '{}')];
    const images = [
        writeAsset('img/map_data_700.png', 'old-map-image'),
        writeAsset('img/map_data_741f.png', 'current-map-image'),
        writeAsset('img/skins/700/dota_autumn.png', 'old-autumn-skin'),
        writeAsset('img/skins/741f/dota_reef.png', 'current-reef-skin'),
    ];
    const packageJson = {
        name: '@reino-doce/dota-maps-data',
        version: '1.2.3',
        description: 'Fixture package',
        repository: { type: 'git', url: 'https://github.com/Reino-Doce/dota-maps-data.git' },
        homepage: 'https://github.com/Reino-Doce/dota-maps-data#readme',
        type: 'module',
        files: [],
        exports: { '.': './src/index.mjs', './node': './src/node/index.mjs', './latest/old.png': './assets/old.png' },
        scripts: { test: 'node --test' },
        devDependencies: { fixture: '1.0.0' },
        dotaMapsData: { currentPatch: '741f' },
    };
    const manifest = {
        schemaVersion: 1,
        currentPatch: '741f',
        latestPackage: {
            packageName: '@reino-doce/dota-maps-data-latest',
            sourcePatch: '741f',
            sourcePackageName: '@reino-doce/dota-maps-data-741f',
        },
        latestSkinsPackageName: '@reino-doce/dota-map-skins-latest',
        skinSetPackages: { '700': '@reino-doce/dota-map-skins-700', '741f': '@reino-doce/dota-map-skins-741f' },
        skinPackages: [
            { id: 'autumn', patchId: '700', packageName: '@reino-doce/dota-map-skin-700-autumn', file: images[2] },
            { id: 'reef', patchId: '741f', packageName: '@reino-doce/dota-map-skin-741f-reef', file: images[3] },
        ],
        patches: [
            { id: '700', packageName: '@reino-doce/dota-maps-data-700', files: oldData },
            { id: '741f', packageName: '@reino-doce/dota-maps-data-741f', files: currentData },
        ],
        shared,
        images,
    };
    fs.writeFileSync(path.join(sourceRoot, 'package.json'), JSON.stringify(packageJson));
    fs.writeFileSync(path.join(sourceRoot, 'manifest.json'), JSON.stringify(manifest));

    prepareNpmPackages({ sourceRoot, destination: outputRoot });
    const oldPatchDirectory = path.join(outputRoot, 'dota-maps-data-700');
    const oldSkinDirectory = path.join(outputRoot, 'dota-map-skin-700-autumn');
    const oldSkinSetDirectory = path.join(outputRoot, 'dota-map-skins-700');
    const latestSkinSetDirectory = path.join(outputRoot, 'dota-map-skins-latest');
    assert.ok(fs.existsSync(path.join(oldPatchDirectory, 'skin-exports', '700', 'index.mjs')));
    assert.ok(fs.readFileSync(path.join(oldPatchDirectory, 'skin-exports', '700', 'autumn.mjs'), 'utf8')
        .includes('@reino-doce/dota-map-skin-700-autumn'));
    assert.ok(fs.readFileSync(path.join(oldSkinSetDirectory, 'index.mjs'), 'utf8')
        .includes('@reino-doce/dota-map-skin-700-autumn/image/dota_autumn.png'));
    assert.doesNotMatch(fs.readFileSync(path.join(oldSkinSetDirectory, 'index.mjs'), 'utf8'), /741f-reef/u);
    assert.ok(fs.readFileSync(path.join(latestSkinSetDirectory, 'index.mjs'), 'utf8')
        .includes('@reino-doce/dota-map-skin-741f-reef/image/dota_reef.png'));
    assert.doesNotMatch(fs.readFileSync(path.join(latestSkinSetDirectory, 'index.mjs'), 'utf8'), /700-autumn/u);
    assert.ok(fs.existsSync(path.join(oldSkinDirectory, 'assets', 'img', 'skins', '700', 'dota_autumn.png')));
    assert.equal(fs.existsSync(path.join(oldPatchDirectory, 'assets', 'img', 'skins')), false);
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
