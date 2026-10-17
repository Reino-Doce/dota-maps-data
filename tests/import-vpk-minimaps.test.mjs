import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { collectRejectedCandidates, getOverviewMaterialEntries, parseOverviewMapConfig, parseOverviewMaterialTexture, resolveOverviewMaterialPath,
    isPatchSpecificOverviewMaterial, selectConfiguredOverviewMaterial, selectOverviewConfigs }
    from '../scripts/import-vpk-minimaps.mjs';

test('overview configs expose their detailed and optional simple materials', () => {
    assert.deepEqual(parseOverviewMapConfig(`
        dota_test
        {
            material materials/overviews/dota_737.vmat // detailed map image
            simple_material materials/overviews/dota_minimal_737.vmat // simplified map image
        }
    `), {
        material: 'materials/overviews/dota_737.vmat',
        simpleMaterial: 'materials/overviews/dota_minimal_737.vmat',
    });
    assert.deepEqual(parseOverviewMapConfig(`
        dota
        {
            material materials/overviews/dota.vmat
        }
    `), {
        material: 'materials/overviews/dota.vmat',
        simpleMaterial: null,
    });
});

test('overview material texture comes from its compiled color binding', () => {
    assert.equal(parseOverviewMaterialTexture(`
        "Compiled Textures"
        {
            "g_tColor" "materials/overviews/dota_minimal_psd_f4e53729.vtex"
        }
    `, 'materials/overviews/dota_minimal.vmat'),
    'materials/overviews/dota_minimal_psd_f4e53729.vtex');
    assert.throws(() => parseOverviewMaterialTexture('"Compiled Textures" {}', 'missing.vmat'), /g_tColor/);
});

test('683 config resolves to its uniquely versioned retained VPK material', () => {
    const available = new Set(['materials/overviews/dotamap683.vmat_c']);
    assert.equal(resolveOverviewMaterialPath('materials/overviews/dota_683.vmat', '683', available),
        'materials/overviews/dotamap683.vmat');
    assert.throws(() => resolveOverviewMaterialPath('materials/overviews/dota_681.vmat', '681', available),
        /No installed VPK/);
});

test('683 retained overview material is classified as the simple minimap', () => {
    const config = {
        material: 'materials/overviews/dota_683.vmat',
        simpleMaterial: null,
    };
    assert.deepEqual(getOverviewMaterialEntries(config, '683'), [
        ['simple', 'materials/overviews/dota_683.vmat'],
    ]);
    assert.deepEqual(getOverviewMaterialEntries({
        material: 'materials/overviews/dota_737.vmat',
        simpleMaterial: 'materials/overviews/dota_minimal_737.vmat',
    }, '737'), [
        ['detailed', 'materials/overviews/dota_737.vmat'],
        ['simple', 'materials/overviews/dota_minimal_737.vmat'],
    ]);
});

test('historical minimap materials must name their patch instead of reusing the generic current material', () => {
    assert.equal(isPatchSpecificOverviewMaterial('materials/overviews/dota_728.vmat', '728'), true);
    assert.equal(isPatchSpecificOverviewMaterial('materials/overviews/dota_minimal_722.vmat', '722'), true);
    assert.equal(isPatchSpecificOverviewMaterial('materials/overviews/dota.vmat', '728'), false);
    assert.equal(isPatchSpecificOverviewMaterial('materials/overviews/dota_minimal.vmat', '728'), false);
});

test('historical overview import refuses retained patch materials not selected by its config', () => {
    const available = new Set([
        'materials/overviews/dota.vmat_c',
        'materials/overviews/dota_728.vmat_c',
        'materials/overviews/dotamap683.vmat_c',
    ]);
    assert.equal(selectConfiguredOverviewMaterial('materials/overviews/dota.vmat', '728', '741', available), null);
    assert.equal(selectConfiguredOverviewMaterial('materials/overviews/dota_728.vmat', '728', '741', available),
        'materials/overviews/dota_728.vmat');
    assert.equal(selectConfiguredOverviewMaterial('materials/overviews/dota.vmat', '741', '741', available),
        'materials/overviews/dota.vmat');
    assert.equal(selectConfiguredOverviewMaterial('materials/overviews/dota_683.vmat', '683', '741', available),
        'materials/overviews/dotamap683.vmat');
});

test('overwriting minimap provenance preserves the hashes and reasons of rejected candidates', () => {
    const rejected = collectRejectedCandidates({ omittedImages: {
        detailed: { path: 'img/728/minimaps/detailed.png', sha256: 'old-detailed', reason: 'matched 741' },
        simple: { path: 'img/728/minimaps/simple.png', sha256: 'old-simple', reason: 'matched 741' },
    } }, { detailed: { sha256: 'new-detailed' } });
    assert.deepEqual(Object.keys(rejected).sort(), ['detailed', 'simple']);
    assert.equal(rejected.detailed.sha256, 'old-detailed');
    assert.equal(rejected.detailed.historicalReason, 'matched 741');
    assert.equal(rejected.detailed.reason, 'Earlier candidate retained for audit; it is not the replacement currently listed under images.detailed.');
    assert.equal(rejected.simple.sha256, 'old-simple');
    assert.equal(rejected.simple.historicalReason, 'matched 741');
});

test('explicit historical patch requires its exact overview config; only current patch may use dota.txt', () => {
    const configs = new Map([
        ['resource/overviews/dota.txt', { resourcePath: 'resource/overviews/dota.txt' }],
        ['resource/overviews/dota_683.txt', { resourcePath: 'resource/overviews/dota_683.txt' }],
        ['resource/overviews/dota_685.txt', { resourcePath: 'resource/overviews/dota_685.txt' }],
    ]);
    assert.deepEqual(selectOverviewConfigs(configs, '685', '741'), [
        { resourcePath: 'resource/overviews/dota_685.txt' },
    ]);
    assert.deepEqual(selectOverviewConfigs(configs, '684', '741'), []);
    assert.deepEqual(selectOverviewConfigs(configs, '741', '741'), [
        { resourcePath: 'resource/overviews/dota.txt' },
    ]);
    assert.deepEqual(selectOverviewConfigs(configs, undefined, '741'), [
        { resourcePath: 'resource/overviews/dota_683.txt' },
        { resourcePath: 'resource/overviews/dota_685.txt' },
        { resourcePath: 'resource/overviews/dota.txt' },
    ]);
});

test('importing the VPK minimap importer does not write files or launch tools', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const script = `
        import { syncBuiltinESMExports } from 'node:module';
        import fs from 'node:fs';
        import childProcess from 'node:child_process';
        const forbidden = () => { throw new Error('import caused a side effect'); };
        for (const name of ['writeFile', 'writeFileSync', 'mkdir', 'mkdirSync', 'rename', 'renameSync', 'unlink', 'unlinkSync']) fs[name] = forbidden;
        for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[name] = forbidden;
        syncBuiltinESMExports();
        await import('./scripts/import-vpk-minimaps.mjs');
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
});
