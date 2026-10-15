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

for (const item of plan.packages) {
    const packageDirectory = path.join(outputDirectory, item.name.slice('@reino-doce/'.length));
    const packageJson = readJson(path.join(packageDirectory, 'package.json'));
    assert.equal(packageJson.name, item.name);
    assert.equal(packageJson.version, plan.sourcePackage.version);
    assert.equal(packageJson.dependencies, undefined, `${item.name} must not pull in the extractor or runtime`);
    assert.equal(packageJson.devDependencies, undefined, `${item.name} must not pull in development tooling`);
    assert.equal(fs.existsSync(path.join(packageDirectory, 'assets', 'data', item.patch.id)), true);

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
    const skinSubpath = './latest/' + item.id + '/' + path.posix.basename(item.image.path);
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
assert.deepEqual(Object.keys(aggregate.dependencies).sort(), plan.skinPackages.map(item => item.name).sort());

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dota-maps-package-resolution-'));
try {
    const scope = path.join(fixtureRoot, 'node_modules', '@reino-doce');
    fs.mkdirSync(scope, { recursive: true });
    const latestDirectory = path.join(outputDirectory, plan.latestPackage.name.slice('@reino-doce/'.length));
    fs.cpSync(latestDirectory, path.join(scope, 'dota-maps-data'), { recursive: true });
    fs.cpSync(latestDirectory, path.join(scope, plan.latestPackage.name.slice('@reino-doce/'.length)), { recursive: true });
    const skin = plan.skinPackages.find(item => item.id === 'autumn') ?? plan.skinPackages[0];
    fs.cpSync(path.join(outputDirectory, skin.name.slice('@reino-doce/'.length)),
        path.join(scope, skin.name.slice('@reino-doce/'.length)), { recursive: true });

    const runtimeRoot = path.join(fixtureRoot, 'runtime');
    const runtimeNode = path.join(runtimeRoot, 'src', 'node');
    fs.mkdirSync(runtimeNode, { recursive: true });
    fs.copyFileSync(path.join(coreDirectory, 'src', 'node', 'map-assets.mjs'),
        path.join(runtimeNode, 'map-assets.mjs'));
    fs.copyFileSync(path.join(coreDirectory, 'manifest.json'), path.join(runtimeRoot, 'manifest.json'));

    const mapDataSpecifier = '@reino-doce/dota-maps-data/latest/mapdata.json';
    const mapImageSpecifier = '@reino-doce/dota-maps-data/latest/dota-map.png';
    const skinImageSpecifier = skin.name + '/latest/' + skin.id + '/' + path.posix.basename(skin.image.path);
    const consumerScript = `
        import assert from 'node:assert/strict';
        import fs from 'node:fs';
        import { fileURLToPath } from 'node:url';
        import mapdata from ${JSON.stringify(mapDataSpecifier)} with { type: 'json' };
        import { resolveAssetPath } from './runtime/src/node/map-assets.mjs';
        assert.ok(mapdata && typeof mapdata === 'object');
        for (const specifier of [${JSON.stringify(mapDataSpecifier)}, ${JSON.stringify(mapImageSpecifier)}, ${JSON.stringify(skinImageSpecifier)}]) {
            assert.ok(fs.existsSync(fileURLToPath(import.meta.resolve(specifier))), specifier);
        }
        for (const assetPath of ['data/latest/mapdata.json', 'latest/dota-map.png', ${JSON.stringify('latest/' + skin.id + '/' + path.posix.basename(skin.image.path))}]) {
            assert.ok(fs.existsSync(resolveAssetPath(assetPath)), assetPath);
        }
    `;
    const consumerFile = path.join(fixtureRoot, 'consumer.mjs');
    fs.writeFileSync(consumerFile, consumerScript);
    const result = spawnSync(process.execPath, [consumerFile], { cwd: fixtureRoot, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout || 'installed package resolution failed');

    const versionOnlyRoot = path.join(fixtureRoot, 'version-only');
    const versionScope = path.join(versionOnlyRoot, 'node_modules', '@reino-doce');
    const currentPatch = plan.patchPackages.find(item => item.id === plan.manifest.currentPatch);
    fs.mkdirSync(versionScope, { recursive: true });
    fs.cpSync(path.join(outputDirectory, currentPatch.name.slice('@reino-doce/'.length)),
        path.join(versionScope, currentPatch.name.slice('@reino-doce/'.length)), { recursive: true });
    const versionRuntime = path.join(versionOnlyRoot, 'runtime');
    const versionRuntimeNode = path.join(versionRuntime, 'src', 'node');
    fs.mkdirSync(versionRuntimeNode, { recursive: true });
    fs.copyFileSync(path.join(coreDirectory, 'src', 'node', 'map-assets.mjs'),
        path.join(versionRuntimeNode, 'map-assets.mjs'));
    fs.copyFileSync(path.join(coreDirectory, 'manifest.json'), path.join(versionRuntime, 'manifest.json'));
    const fallbackScript = `
        import assert from 'node:assert/strict';
        import fs from 'node:fs';
        import { resolveAssetPath } from './runtime/src/node/map-assets.mjs';
        for (const assetPath of ['data/latest/mapdata.json', 'latest/dota-map.png']) {
            assert.ok(fs.existsSync(resolveAssetPath(assetPath)), assetPath);
        }
    `;
    const fallbackFile = path.join(versionOnlyRoot, 'consumer.mjs');
    fs.writeFileSync(fallbackFile, fallbackScript);
    const fallbackResult = spawnSync(process.execPath, [fallbackFile], { cwd: versionOnlyRoot, encoding: 'utf8' });
    assert.equal(fallbackResult.status, 0,
        fallbackResult.stderr || fallbackResult.stdout || 'version package latest fallback failed');
} finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

console.log(`Verified the runtime package, ${plan.patchPackages.length} version packages, latest data, ${plan.skinPackages.length} optional skin packages, and the skin metapackage.`);
