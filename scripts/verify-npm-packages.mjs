import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildNpmPackagePlan } from './prepare-npm-packages.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = path.join(root, 'npm-packages');
const plan = buildNpmPackagePlan();
const readJson = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const sha256 = filename => createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
const filesIn = (directory, base = directory) => {
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const filename = path.join(directory, entry.name);
        return entry.isDirectory()
            ? filesIn(filename, base)
            : entry.isFile() ? [path.relative(base, filename).replaceAll('\\', '/')] : [];
    }).sort();
};

const coreDirectory = path.join(outputDirectory, 'core');
assert.equal(readJson(path.join(coreDirectory, 'package.json')).name, plan.sourcePackage.name);
assert.equal(fs.existsSync(path.join(coreDirectory, 'assets', 'data', '688')), false,
    'the runtime package must not include an individual patch dataset');
assert.equal(fs.existsSync(path.join(coreDirectory, 'assets', 'data', 'legacy')), false,
    'the runtime package must not include shared legacy bounds');

for (const item of plan.packages) {
    const packageDirectory = path.join(outputDirectory, item.name.slice('@reino-doce/'.length));
    const packageJson = readJson(path.join(packageDirectory, 'package.json'));
    assert.equal(packageJson.name, item.name);
    assert.equal(packageJson.version, plan.sourcePackage.version);
    assert.equal(packageJson.dependencies, undefined, `${item.name} must not pull in the extractor or runtime`);
    assert.equal(packageJson.devDependencies, undefined, `${item.name} must not pull in development tooling`);
    assert.equal(fs.existsSync(path.join(packageDirectory, 'assets', 'data', item.patch.id)), true);
    assert.ok(item.patch.files.some(entry => entry.path === `data/${item.patch.id}/worlddata.json`),
        `${item.name} must include its own world bounds`);
    assert.equal(fs.existsSync(path.join(packageDirectory, 'assets', 'data', 'legacy')), false,
        `${item.name} must not require shared legacy data`);
    assert.equal(packageJson.exports['./latest/worlddata.json'],
        './assets/data/' + item.patch.id + '/worlddata.json');

    for (const [subpath, target] of Object.entries(packageJson.exports)) {
        if (target.includes('*')) continue;
        assert.equal(fs.existsSync(path.join(packageDirectory, target.replace(/^\.\//u, ''))), true,
            item.name + ' export ' + subpath + ' points to missing file ' + target);
    }

    for (const entry of [...item.shared, ...item.patch.files, ...item.images]) {
        const source = path.join(root, 'assets', ...entry.path.split('/'));
        const output = path.join(packageDirectory, 'assets', ...entry.path.split('/'));
        assert.equal(fs.existsSync(output), true, `${item.name} omitted ${entry.path}`);
        assert.equal(fs.statSync(output).size, entry.bytes, `${item.name}: ${entry.path} byte count changed`);
        assert.equal(await sha256(output), entry.sha256, `${item.name}: ${entry.path} checksum changed`);
        assert.equal(await sha256(source), entry.sha256, `source asset checksum changed: ${entry.path}`);
    }
    for (const skin of item.skins) {
        const wrapper = path.join(packageDirectory, 'skin-exports', item.patch.id, skin.id + '.mjs');
        assert.equal(fs.existsSync(wrapper), true, `${item.name} omitted the ${skin.id} skin import wrapper`);
        assert.ok(fs.readFileSync(wrapper, 'utf8').includes(skin.packageName),
            `${item.name} skin wrapper must reference ${skin.packageName}`);
        assert.equal(item.packageJson.dependencies, undefined,
            `${item.name} must leave optional skin packages to the consumer`);
    }
    if (item.skins.length > 0) {
        assert.equal(item.packageJson.exports['./images/' + item.patch.id],
            './skin-exports/' + item.patch.id + '/index.mjs');
        const allSkinsWrapper = path.join(packageDirectory, 'skin-exports', item.patch.id, 'index.mjs');
        assert.equal(fs.existsSync(allSkinsWrapper), true, `${item.name} omitted its all-skins wrapper`);
        const set = plan.skinSetPackages.find(skinSet => skinSet.patchId === item.patch.id);
        assert.ok(set, `${item.name} has skins but no matching all-skins package`);
        assert.ok(fs.readFileSync(allSkinsWrapper, 'utf8').includes(set.name));
        if (item.patch.id === plan.manifest.currentPatch) {
            assert.equal(item.packageJson.exports['./images/latest'],
                './skin-exports/' + item.patch.id + '/latest.mjs');
        }
    }
}

assert.equal(plan.manifest.latestPackage.sourcePackageName,
    `@reino-doce/dota-maps-data-${plan.manifest.currentPatch}`);
assert.equal(plan.latestPackage.name, '@reino-doce/dota-maps-data-latest');
assert.equal(plan.patchPackages.length, plan.manifest.patches.length);

for (const item of plan.skinPackages) {
    const packageDirectory = path.join(outputDirectory, item.name.slice('@reino-doce/'.length));
    const packageJson = readJson(path.join(packageDirectory, 'package.json'));
    const output = path.join(packageDirectory, 'assets', ...item.image.path.split('/'));
    const source = path.join(root, 'assets', ...item.image.path.split('/'));
    assert.equal(packageJson.name, item.name);
    assert.equal(packageJson.dependencies, undefined, item.name + ' must remain data-only');
    assert.equal(fs.existsSync(path.join(packageDirectory, 'assets', 'data')), false,
        item.name + ' must not include map data');
    assert.deepEqual(filesIn(path.join(packageDirectory, 'assets')), [item.image.path],
        item.name + ' must contain only its registered skin image');
    const skinSubpath = item.patchId === plan.manifest.currentPatch
        ? './latest/' + item.id + '/' + path.posix.basename(item.image.path)
        : './' + item.patchId + '/' + item.id;
    const exportTarget = packageJson.exports[skinSubpath];
    assert.equal(exportTarget, './assets/' + item.image.path);
    assert.equal(fs.existsSync(path.join(packageDirectory, exportTarget.replace(/^\.\//u, ''))), true,
        item.name + ' export ' + skinSubpath + ' points to a missing image');
    assert.equal(fs.existsSync(output), true, `${item.name} omitted ${item.image.path}`);
    assert.equal(fs.statSync(output).size, item.image.bytes, `${item.name}: image byte count changed`);
    assert.equal(sha256(output), item.image.sha256, `${item.name}: image checksum changed`);
    assert.equal(sha256(source), item.image.sha256, `source image checksum changed: ${item.image.path}`);
}

const aggregate = readJson(path.join(outputDirectory,
    plan.skinsAggregatePackage.name.slice('@reino-doce/'.length), 'package.json'));
assert.deepEqual(Object.keys(aggregate.dependencies).sort(), plan.skinsAggregatePackage.skins.map(item => item.name).sort());

for (const item of plan.skinsAggregatePackages) {
    const packageDirectory = path.join(outputDirectory, item.name.slice('@reino-doce/'.length));
    const packageJson = readJson(path.join(packageDirectory, 'package.json'));
    assert.equal(packageJson.name, item.name);
    assert.equal(packageJson.exports['.'], './index.mjs');
    assert.deepEqual(Object.keys(packageJson.dependencies).sort(), item.skins.map(skin => skin.name).sort());
    assert.deepEqual(filesIn(packageDirectory).filter(file => file.startsWith('assets/')), [],
        `${item.name} should contain dependency declarations, not duplicate skin image bytes`);
    const moduleSource = fs.readFileSync(path.join(packageDirectory, 'index.mjs'), 'utf8');
    for (const skin of item.skins) {
        assert.ok(moduleSource.includes(skin.name + '/image/' + path.posix.basename(skin.image.path)));
        if (skin.id === 'default') {
            assert.match(moduleSource, /"default": skin\d+/u, `${item.name} must include the default image in its skin map`);
        }
        else assert.ok(moduleSource.includes('as ' + skin.id), `${item.name} must export ${skin.id} by name`);
    }
}

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dota-maps-package-resolution-'));
try {
    const scope = path.join(fixtureRoot, 'node_modules', '@reino-doce');
    fs.mkdirSync(scope, { recursive: true });
    const latestDirectory = path.join(outputDirectory, plan.latestPackage.name.slice('@reino-doce/'.length));
    fs.cpSync(latestDirectory, path.join(scope, 'dota-maps-data'), { recursive: true });
    fs.cpSync(latestDirectory, path.join(scope, plan.latestPackage.name.slice('@reino-doce/'.length)), { recursive: true });
    const skin = plan.skinPackages.find(item => item.patchId === plan.manifest.currentPatch) ?? plan.skinPackages[0];
    fs.cpSync(path.join(outputDirectory, skin.name.slice('@reino-doce/'.length)),
        path.join(scope, skin.name.slice('@reino-doce/'.length)), { recursive: true });

    const runtimeRoot = path.join(fixtureRoot, 'runtime');
    const runtimeNode = path.join(runtimeRoot, 'src', 'node');
    fs.mkdirSync(runtimeNode, { recursive: true });
    fs.copyFileSync(path.join(coreDirectory, 'src', 'node', 'map-assets.mjs'),
        path.join(runtimeNode, 'map-assets.mjs'));
    fs.copyFileSync(path.join(coreDirectory, 'manifest.json'), path.join(runtimeRoot, 'manifest.json'));

    const mapDataSpecifier = '@reino-doce/dota-maps-data/latest/mapdata.json';
    const worldDataSpecifier = '@reino-doce/dota-maps-data/latest/worlddata.json';
    const mapImageSpecifier = '@reino-doce/dota-maps-data/latest/minimaps/detailed.png';
    const versionDataSpecifier = '@reino-doce/dota-maps-data/' + plan.manifest.currentPatch + '/mapdata.json';
    const versionWorldDataSpecifier = '@reino-doce/dota-maps-data/' + plan.manifest.currentPatch + '/worlddata.json';
    const versionSkinSpecifier = '@reino-doce/dota-maps-data/images/' + plan.manifest.currentPatch + '/' + skin.id;
    const versionAllSkinsSpecifier = '@reino-doce/dota-maps-data/images/' + plan.manifest.currentPatch;
    const latestSkinSpecifier = '@reino-doce/dota-maps-data/images/latest/' + skin.id;
    const latestAllSkinsSpecifier = '@reino-doce/dota-maps-data/images/latest';
    const skinImageSpecifier = skin.name + '/latest/' + skin.id + '/' + path.posix.basename(skin.image.path);
    const consumerScript = `
        import assert from 'node:assert/strict';
        import fs from 'node:fs';
        import { fileURLToPath } from 'node:url';
        import mapdata from ${JSON.stringify(mapDataSpecifier)} with { type: 'json' };
        import worlddata from ${JSON.stringify(worldDataSpecifier)} with { type: 'json' };
        import { resolveAssetPath } from './runtime/src/node/map-assets.mjs';
        assert.ok(mapdata && typeof mapdata === 'object');
        assert.ok(worlddata && worlddata.worldMaxX > worlddata.worldMinX);
        for (const specifier of [${JSON.stringify(mapDataSpecifier)}, ${JSON.stringify(worldDataSpecifier)}, ${JSON.stringify(mapImageSpecifier)}, ${JSON.stringify(versionDataSpecifier)}, ${JSON.stringify(versionWorldDataSpecifier)}, ${JSON.stringify(versionSkinSpecifier)}, ${JSON.stringify(versionAllSkinsSpecifier)}, ${JSON.stringify(latestSkinSpecifier)}, ${JSON.stringify(latestAllSkinsSpecifier)}, ${JSON.stringify(skinImageSpecifier)}]) {
            assert.ok(fs.existsSync(fileURLToPath(import.meta.resolve(specifier))), specifier);
        }
        const skinWrapper = fs.readFileSync(fileURLToPath(import.meta.resolve(${JSON.stringify(latestSkinSpecifier)})), 'utf8');
        assert.ok(skinWrapper.includes(${JSON.stringify(skin.name + '/image/' + path.posix.basename(skin.image.path))}));
        const allSkinsWrapper = fs.readFileSync(fileURLToPath(import.meta.resolve(${JSON.stringify(versionAllSkinsSpecifier)})), 'utf8');
        assert.ok(allSkinsWrapper.includes(${JSON.stringify(plan.skinSetPackages.find(item => item.patchId === plan.manifest.currentPatch).name)}));
        for (const assetPath of ['data/latest/mapdata.json', 'data/latest/worlddata.json', 'latest/minimaps/detailed.png', ${JSON.stringify('latest/' + skin.id + '/' + path.posix.basename(skin.image.path))}]) {
            assert.ok(fs.existsSync(resolveAssetPath(assetPath)), assetPath);
        }
    `;
    const consumerFile = path.join(fixtureRoot, 'consumer.mjs');
    fs.writeFileSync(consumerFile, consumerScript);
    const result = spawnSync(process.execPath, [consumerFile], { cwd: fixtureRoot, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout || 'installed package resolution failed');

    const versionOnlyRoot = path.join(fixtureRoot, 'version-only');
    const versionScope = path.join(versionOnlyRoot, 'node_modules', '@reino-doce');
    const selectedPatch = plan.patchPackages.find(item => item.id !== plan.manifest.currentPatch)
        ?? plan.patchPackages.find(item => item.id === plan.manifest.currentPatch);
    fs.mkdirSync(versionScope, { recursive: true });
    const selectedPackageDirectory = path.join(outputDirectory, selectedPatch.name.slice('@reino-doce/'.length));
    fs.cpSync(selectedPackageDirectory,
        path.join(versionScope, selectedPatch.name.slice('@reino-doce/'.length)), { recursive: true });
    fs.cpSync(selectedPackageDirectory, path.join(versionScope, 'dota-maps-data'), { recursive: true });
    const versionRuntime = path.join(versionOnlyRoot, 'runtime');
    const versionRuntimeNode = path.join(versionRuntime, 'src', 'node');
    fs.mkdirSync(versionRuntimeNode, { recursive: true });
    fs.copyFileSync(path.join(coreDirectory, 'src', 'node', 'map-assets.mjs'),
        path.join(versionRuntimeNode, 'map-assets.mjs'));
    fs.copyFileSync(path.join(coreDirectory, 'manifest.json'), path.join(versionRuntime, 'manifest.json'));
    const standaloneMapDataSpecifier = '@reino-doce/dota-maps-data/' + selectedPatch.id + '/mapdata.json';
    const standaloneWorldDataSpecifier = '@reino-doce/dota-maps-data/' + selectedPatch.id + '/worlddata.json';
    const fallbackScript = `
        import assert from 'node:assert/strict';
        import fs from 'node:fs';
        import mapdata from ${JSON.stringify(standaloneMapDataSpecifier)} with { type: 'json' };
        import worlddata from ${JSON.stringify(standaloneWorldDataSpecifier)} with { type: 'json' };
        import { resolveAssetPath } from './runtime/src/node/map-assets.mjs';
        assert.ok(mapdata && typeof mapdata === 'object');
        assert.ok(worlddata && worlddata.worldMaxX > worlddata.worldMinX);
        for (const assetPath of [${JSON.stringify('data/' + selectedPatch.id + '/mapdata.json')}, ${JSON.stringify('data/' + selectedPatch.id + '/worlddata.json')}]) {
            assert.ok(fs.existsSync(resolveAssetPath(assetPath)), assetPath);
        }
    `;
    const fallbackFile = path.join(versionOnlyRoot, 'consumer.mjs');
    fs.writeFileSync(fallbackFile, fallbackScript);
    const fallbackResult = spawnSync(process.execPath, [fallbackFile], { cwd: versionOnlyRoot, encoding: 'utf8' });
    assert.equal(fallbackResult.status, 0,
        fallbackResult.stderr || fallbackResult.stdout || 'standalone version package resolution failed');
} finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

console.log(`Verified the runtime package, ${plan.patchPackages.length} version packages, latest data, ${plan.skinPackages.length} optional skin packages, and ${plan.skinsAggregatePackages.length} all-skins packages.`);
