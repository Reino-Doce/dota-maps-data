import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { buildNpmPackagePlan as buildNodePackagePlan, prepareNpmPackages,
    readMapData, readMapManifest, resolveAssetPath } from '../src/node/index.mjs';
import { importOverview } from '../scripts/import-overview.mjs';
import { importScreenshot } from '../scripts/import-screenshot.mjs';
import { buildNpmPackagePlan } from '../scripts/prepare-npm-packages.mjs';
import { readPreparedWorldData } from '../src/node/patch-inputs.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

test('manifest checksums cover every map asset and registered image', () => {
    const manifest = readMapManifest();
    const entries = [...manifest.patches.flatMap(patch => patch.files), ...manifest.shared,
        ...manifest.minimaps.map(minimap => minimap.sourceFile), ...manifest.images];
    assert.ok(manifest.patches.length >= 12);
    assert.equal(manifest.currentPatch, '741');
    assert.ok(manifest.patches.some(patch => patch.id === '670'), 'the Source 1 extraction is registered by its Dota patch');
    assert.deepEqual(manifest.shared, [], 'all data assets belong to a version package');
    assert.equal(manifest.latestPackage.sourcePackageName, `@reino-doce/dota-maps-data-${manifest.currentPatch}`);
    for (const patch of manifest.patches) {
        const worldPath = `data/${patch.id}/worlddata.json`;
        assert.ok(patch.files.some(entry => entry.path === worldPath), `${patch.id} owns its world bounds`);
        const world = readMapData(patch.id, 'worlddata.json');
        for (const axis of ['X', 'Y']) {
            assert.ok(Number.isFinite(world[`worldMin${axis}`]), `${patch.id} worldMin${axis}`);
            assert.ok(Number.isFinite(world[`worldMax${axis}`]), `${patch.id} worldMax${axis}`);
            assert.ok(world[`worldMax${axis}`] > world[`worldMin${axis}`], `${patch.id} world ${axis} extent`);
        }
        const imagePath = path.join(root, 'assets', 'img', patch.id, 'map_data.png');
        if (fs.existsSync(imagePath)) {
            const raster = PNG.sync.read(fs.readFileSync(imagePath));
            const gridWidth = (world.worldMaxX - world.worldMinX) / 64 + 1;
            const gridHeight = (world.worldMaxY - world.worldMinY) / 64 + 1;
            assert.equal(raster.width, gridWidth * 5, `${patch.id} vision raster width matches its world bounds`);
            assert.equal(raster.height, gridHeight, `${patch.id} vision raster height matches its world bounds`);
        }
    }
    assert.equal(new Set(entries.map(entry => entry.path)).size, entries.length);
    assert.ok(manifest.minimaps.length >= 8, 'installed VPK overview configs provide historical minimaps');
    const minimap728 = manifest.minimaps.find(minimap => minimap.patch === '728');
    assert.ok(minimap728);
    assert.deepEqual(Object.keys(minimap728.images), []);
    assert.match(minimap728.omittedImages.detailed.reason, /rejected/u);
    assert.match(minimap728.source.source2ViewerSha256, /^[a-f0-9]{64}$/u);
    assert.deepEqual(Object.keys(minimap728.omittedImages).sort(), ['detailed', 'simple']);
    assert.deepEqual(Object.keys(minimap728.rejectedCandidates).sort(), ['detailed', 'detailedPrior', 'simple']);
    assert.equal(manifest.images.some(image => image.path === 'img/728/minimaps/detailed.png'), false);
    const map728Source = readMapData('728', 'source.json');
    const map728Image = map728Source.terrainImage;
    const map728ImageEntry = manifest.images.find(image => image.path === 'img/728/default.jpg');
    assert.ok(map728ImageEntry, 'the verified 728 game-map render is registered');
    assert.equal(map728Image.path, map728ImageEntry.path);
    assert.equal(map728Image.sha256, map728ImageEntry.sha256);
    assert.equal(map728Image.sourceArchiveSha256, map728Source.archiveSha256);
    assert.equal(map728Image.sourceMapResource, map728Source.resources.map.path);
    assert.deepEqual(map728Image.tiles, { columns: 5, rows: 9, count: 45, width: 3840, height: 2160 });
    assert.ok(manifest.skinPackages.some(skin => skin.patchId === '728' && skin.id === 'default'),
        'the verified 728 render is available as an optional terrain skin');
    for (const minimap of manifest.minimaps) {
        assert.match(minimap.sourceFile.path, /^provenance\/minimaps\/[0-9]+(?:_[0-9]+)?[a-z]*\.json$/iu);
        assert.ok(Object.keys(minimap.images).length > 0 || Object.keys(minimap.omittedImages || {}).length > 0,
            `${minimap.patch} has an extracted or explicitly omitted minimap`);
        if (minimap.patch === '683') {
            assert.ok(minimap.images.simple, '683 retained minimap is correctly classified as simple');
            assert.equal(minimap.images.detailed, undefined);
        }
        else if (Object.keys(minimap.images).length > 0) {
            assert.ok(minimap.images.detailed, `${minimap.patch} detailed minimap`);
        }
        for (const image of Object.values(minimap.images)) {
            assert.match(image.path, /^img\/[0-9]+(?:_[0-9]+)?[a-z]*\/minimaps\/(?:simple|detailed)\.png$/iu);
            assert.ok(manifest.images.some(entry => entry.path === image.path
                && entry.sha256 === image.sha256 && entry.bytes === image.bytes), image.path);
        }
    }
    assert.deepEqual(manifest.images.filter(entry => path.posix.basename(entry.path) === 'default.jpg')
        .map(entry => path.posix.basename(path.posix.dirname(entry.path))).sort(),
    ['681', '682', '683', '684', '685', '687', '688', '700', '706', '707', '709', '715', '719', '720',
        '722', '723', '727', '728', '729', '732', '737', '741']);
    assert.equal(manifest.images.some(image => image.path === 'img/684/default.png'), false,
        'unstored PNG stitching intermediates are not part of the asset manifest');
    assert.equal(manifest.skinPackages.some(skin => skin.file.path === 'img/684/default.png'), false,
        'large PNG stitching intermediates are not published as terrain skins');
    assert.deepEqual(manifest.skinPackages.filter(skin => skin.patchId === '706').map(skin => skin.id).sort(),
        ['autumn', 'default', 'default_smaller', 'desert', 'immortalgardens', 'journey', 'reef', 'spring', 'winter']);
    for (const entry of entries) {
        const bytes = fs.readFileSync(resolveAssetPath(entry.path));
        assert.equal(bytes.length, entry.bytes, entry.path);
        assert.equal(sha256(bytes), entry.sha256, entry.path);
    }
    for (const skin of readMapData('741', 'skins.json')) assert.ok(fs.existsSync(resolveAssetPath(skin.image)), skin.image);
    const screenshot = readMapData('741', 'screenshot.json');
    assert.ok(fs.existsSync(resolveAssetPath(screenshot.image)), screenshot.image);
    assert.deepEqual(readMapData('latest', 'overview.json'), readMapData(manifest.currentPatch, 'overview.json'));
});

test('latest import paths resolve current map data, standard images, and selected skin images', () => {
    const manifest = readMapManifest();
    const cases = [
        ['@reino-doce/dota-maps-data/latest/mapdata.json', 'latest/mapdata.json'],
        ['@reino-doce/dota-maps-data/latest/worlddata.json', 'data/latest/worlddata.json'],
        ['@reino-doce/dota-maps-data/latest/detailed.png', 'latest/detailed.png'],
        ['@reino-doce/dota-maps-data/latest/simple.png', 'latest/simple.png'],
        ['@reino-doce/dota-maps-data/latest/minimaps/detailed.png', 'latest/minimaps/detailed.png'],
        ['@reino-doce/dota-maps-data/latest/autumn/autumn.jpg', 'latest/autumn/autumn.jpg'],
        ['@reino-doce/dota-maps-data/670/mapdata.json', 'data/670/mapdata.json'],
        ['@reino-doce/dota-maps-data/670/worlddata.json', 'data/670/worlddata.json'],
    ];
    for (const [specifier, assetPath] of cases) {
        assert.equal(
            path.resolve(fileURLToPath(import.meta.resolve(specifier))),
            path.resolve(resolveAssetPath(assetPath)),
            specifier,
        );
    }
    assert.deepEqual(readMapData('latest'), readMapData(manifest.currentPatch));
    assert.deepEqual(readMapData('latest', 'worlddata.json'), readMapData(manifest.currentPatch, 'worlddata.json'));
    const source1Map = readMapData('670');
    const source1Provenance = readMapData('670', 'source.json');
    assert.equal(source1Map.data.ent_dota_tree.length, 2476);
    assert.equal(source1Map.data.trigger_multiple.length, 12);
    assert.equal(source1Map.data.npc_dota_barracks.length, 12);
    assert.equal(source1Provenance.sourceEngine, 'Source 1');
    assert.equal(source1Provenance.steamInfo.patchVersion, '37');
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
        assert.equal(item.shared.length, 0, item.name + ' must not depend on shared legacy assets');
        assert.ok(item.patch.files.some(entry => entry.path === `data/${item.patch.id}/worlddata.json`), item.name);
        assert.equal(item.packageJson.exports['./data/legacy/*'], undefined, item.name);
        assert.equal(item.packageJson.exports['./latest/mapdata.json'],
            './assets/data/' + item.patch.id + '/mapdata.json');
        assert.equal(item.packageJson.exports['./latest/worlddata.json'],
            './assets/data/' + item.patch.id + '/worlddata.json');
        assert.equal(item.packageJson.exports['./' + item.patch.id + '/worlddata.json'],
            './assets/data/' + item.patch.id + '/worlddata.json');
        assert.equal(item.packageJson.exports['./' + item.patch.id + '/mapdata.json'],
            './assets/data/' + item.patch.id + '/mapdata.json');
        assert.equal(item.packageJson.exports['./' + item.patch.id + '/*'],
            './assets/data/' + item.patch.id + '/*');
        const hasMinimaps = item.images.some(image => image.path.startsWith('img/' + item.patch.id + '/minimaps/'));
        const minimapExport = hasMinimaps ? './assets/img/' + item.patch.id + '/minimaps/*' : undefined;
        assert.equal(item.packageJson.exports['./' + item.patch.id + '/minimaps/*'], minimapExport);
        assert.equal(item.packageJson.exports['./latest/minimaps/*'], minimapExport);
        for (const image of item.images) {
            assert.equal(item.packageJson.exports['./latest/' + path.posix.basename(image.path)],
                './assets/' + image.path);
        }
    }
    for (const item of plan.packages) {
        assert.equal(item.packageJson.dependencies, undefined, item.name);
        assert.equal(item.packageJson.devDependencies, undefined, item.name);
        assert.ok(item.patch.files.length > 0, item.name);
        assert.equal(item.packageJson.exports['./data/*'], `./assets/data/${item.patch.id}/*`);
    }
    assert.equal(plan.latestPackage.images.some(entry => !['map_data.png', 'illustrated.jpg', 'screenshot.jpg',
        'simple.png', 'detailed.png']
        .includes(path.posix.basename(entry.path))), false,
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
        assert.equal(item.images.some(entry => !['map_data.png', 'illustrated.jpg', 'screenshot.jpg',
            'simple.png', 'detailed.png']
            .includes(path.posix.basename(entry.path))), false, item.name);
    }
});

test('each patch publishes only the terrain skins generated for that patch', t => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dota-maps-skin-patches-'));
    t.after(() => fs.rmSync(sourceRoot, { recursive: true, force: true }));
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const manifest = readMapManifest();
    const patchId = manifest.patches.find(patch => !manifest.skinPackages.some(skin => skin.patchId === patch.id)).id;
    const olderPatchSkin = {
        path: `img/${patchId}/frost.jpg`,
        bytes: 123,
        sha256: 'f'.repeat(64),
    };
    manifest.images.push(olderPatchSkin);
    manifest.skinPackages.push({
        id: 'frost',
        patchId,
        packageName: `@reino-doce/dota-map-skin-${patchId}-frost`,
        file: olderPatchSkin,
    });
    manifest.skinSetPackages[patchId] = `@reino-doce/dota-map-skins-${patchId}`;
    fs.writeFileSync(path.join(sourceRoot, 'package.json'), JSON.stringify(packageJson));
    fs.writeFileSync(path.join(sourceRoot, 'manifest.json'), JSON.stringify(manifest));

    const plan = buildNpmPackagePlan({ sourceRoot });
    const olderPatch = plan.patchPackages.find(item => item.id === patchId);
    const olderSkinSet = plan.skinSetPackages.find(item => item.patchId === patchId);
    const currentSkinSet = plan.skinSetPackages.find(item => item.patchId === manifest.currentPatch);
    assert.equal(olderPatch.skins.length, 1);
    assert.equal(olderPatch.skins[0].id, 'frost');
    assert.equal(olderPatch.packageJson.exports[`./images/${patchId}/frost`], `./skin-exports/${patchId}/frost.mjs`);
    assert.equal(olderPatch.packageJson.exports[`./images/${patchId}`], `./skin-exports/${patchId}/index.mjs`);
    assert.equal(olderPatch.packageJson.exports['./images/latest'], undefined);
    assert.deepEqual(Object.keys(olderSkinSet.packageJson.dependencies), [`@reino-doce/dota-map-skin-${patchId}-frost`]);
    assert.ok(currentSkinSet.skins.every(skin => skin.patchId === manifest.currentPatch));
    assert.equal(plan.skinsAggregatePackage.skins.some(skin => skin.patchId === '723'), false);
    assert.equal(plan.skinPackages.find(skin => skin.patchId === patchId).packageJson.exports['./latest/frost/frost.jpg'], undefined);
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
    const oldData = [writeAsset('data/700/mapdata.json', '{}'), writeAsset('data/700/worlddata.json', '{}')];
    const currentData = [writeAsset('data/741/mapdata.json', '{}'), writeAsset('data/741/worlddata.json', '{}')];
    const images = [
        writeAsset('img/700/map_data.png', 'old-map-image'),
        writeAsset('img/741/map_data.png', 'current-map-image'),
        writeAsset('img/700/autumn.jpg', 'old-autumn-skin'),
        writeAsset('img/700/default.jpg', 'old-default-skin'),
        writeAsset('img/741/reef.jpg', 'current-reef-skin'),
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
        dotaMapsData: { currentPatch: '741' },
    };
    const manifest = {
        schemaVersion: 1,
        currentPatch: '741',
        latestPackage: {
            packageName: '@reino-doce/dota-maps-data-latest',
            sourcePatch: '741',
            sourcePackageName: '@reino-doce/dota-maps-data-741',
        },
        latestSkinsPackageName: '@reino-doce/dota-map-skins-latest',
        skinSetPackages: { '700': '@reino-doce/dota-map-skins-700', '741': '@reino-doce/dota-map-skins-741' },
        skinPackages: [
            { id: 'autumn', patchId: '700', packageName: '@reino-doce/dota-map-skin-700-autumn', file: images[2] },
            { id: 'default', patchId: '700', packageName: '@reino-doce/dota-map-skin-700-default', file: images[3] },
            { id: 'reef', patchId: '741', packageName: '@reino-doce/dota-map-skin-741-reef', file: images[4] },
        ],
        patches: [
            { id: '700', packageName: '@reino-doce/dota-maps-data-700', files: oldData },
            { id: '741', packageName: '@reino-doce/dota-maps-data-741', files: currentData },
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
        .includes('@reino-doce/dota-map-skin-700-autumn/image/autumn.jpg'));
    const oldSkinSetModule = path.join(oldSkinSetDirectory, 'index.mjs');
    const syntax = spawnSync(process.execPath, ['--check', oldSkinSetModule], { encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
    assert.match(fs.readFileSync(oldSkinSetModule, 'utf8'), /"default": skin\d+/u);
    assert.doesNotMatch(fs.readFileSync(oldSkinSetModule, 'utf8'), /as default/u);
    assert.doesNotMatch(fs.readFileSync(path.join(oldSkinSetDirectory, 'index.mjs'), 'utf8'), /741-reef/u);
    assert.ok(fs.readFileSync(path.join(latestSkinSetDirectory, 'index.mjs'), 'utf8')
        .includes('@reino-doce/dota-map-skin-741-reef/image/reef.jpg'));
    assert.doesNotMatch(fs.readFileSync(path.join(latestSkinSetDirectory, 'index.mjs'), 'utf8'), /700-autumn/u);
    assert.ok(fs.existsSync(path.join(oldSkinDirectory, 'assets', 'img', '700', 'autumn.jpg')));
    assert.equal(fs.existsSync(path.join(oldPatchDirectory, 'assets', 'img', 'skins')), false);
    assert.ok(fs.existsSync(path.join(oldPatchDirectory, 'assets', 'img', '700', 'map_data.png')));
    assert.ok(fs.existsSync(path.join(oldPatchDirectory, 'assets', 'data', '700', 'worlddata.json')));
    assert.equal(fs.existsSync(path.join(oldPatchDirectory, 'assets', 'data', 'legacy')), false,
        'version packages must include their own bounds instead of shared legacy data');
});

test('overview and screenshot importers generate an additional explicit patch from prepared sources', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dota-maps-data-input-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const assetDirectory = path.join(directory, 'assets');
    const patchDirectory = path.join(assetDirectory, 'data', 'test42');
    fs.mkdirSync(patchDirectory, { recursive: true });
    const legacyDirectory = path.join(assetDirectory, 'data', 'legacy');
    fs.mkdirSync(legacyDirectory, { recursive: true });
    fs.writeFileSync(path.join(legacyDirectory, 'worlddata.json'),
        JSON.stringify({ worldMinX: -8288, worldMinY: -8288, worldMaxX: 8288, worldMaxY: 8288 }));
    const patchImageDirectory = path.join(assetDirectory, 'img', 'test42');
    fs.mkdirSync(patchImageDirectory, { recursive: true });
    fs.copyFileSync(resolveAssetPath('img/741/minimaps/detailed.png'), path.join(patchImageDirectory, 'overview.png'));
    fs.copyFileSync(resolveAssetPath('data/741/screenshot-controls.json'), path.join(patchDirectory, 'screenshot-controls.json'));

    const overviewInput = path.join(directory, 'prepared-overview.txt');
    const screenshotInput = path.join(directory, 'prepared-screenshot.jpg');
    fs.copyFileSync(resolveAssetPath('data/741/overview.txt'), overviewInput);
    fs.copyFileSync(resolveAssetPath('img/741/screenshot.jpg'), screenshotInput);
    const overview = await importOverview({ patch: 'test42', sourceFile: path.relative(process.cwd(), overviewInput),
        imageFile: path.join(patchImageDirectory, 'overview.png'), sourceResourcePath: 'resource/overviews/dota_test42.txt',
        assetDirectory });
    const screenshot = importScreenshot({ patch: 'test42', input: path.relative(process.cwd(), screenshotInput), assetDirectory });

    const importedOverview = JSON.parse(fs.readFileSync(path.join(patchDirectory, 'overview.json'), 'utf8'));
    assert.equal(importedOverview.scale, overview.scale);
    assert.equal(importedOverview.source.file, 'resource/overviews/dota_test42.txt');
    assert.equal(screenshot.image, 'img/test42/screenshot.jpg');
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
