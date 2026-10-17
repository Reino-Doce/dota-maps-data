// Capture patch-matched terrain and native tree IDs through an isolated addon.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { openVpk, resolveGameDirectory } from '../src/node/game-files.mjs';
import { readGridNav } from './ward-grid.mjs';
import { scanConsole } from './game-scan.mjs';
import { mapTreeIds } from './import-live-trees.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const patchPattern = /^[a-z0-9]+$/iu;
const addonInfo = patch => `"AddonInfo"\n{\n\t"addontitle" "Map data scan ${patch}"\n\t"addontagline" "Temporary patch-matched map scan"\n\t"addonauthor" "Local map data tooling"\n\t"addonversion" "1"\n}\n`;

export function inferCaptureGrid(world) {
    const { worldMinX, worldMaxX, worldMinY, worldMaxY } = world || {};
    const bounds = [worldMinX, worldMaxX, worldMinY, worldMaxY];
    if (!bounds.every(Number.isFinite) || worldMinX >= worldMaxX || worldMinY >= worldMaxY) {
        throw new Error('Cannot infer a terrain sampling grid from invalid world bounds.');
    }
    const cellSize = 64;
    const intervalsX = (worldMaxX - worldMinX) / cellSize;
    const intervalsY = (worldMaxY - worldMinY) / cellSize;
    if (!Number.isInteger(intervalsX) || !Number.isInteger(intervalsY)) {
        throw new Error('This map has no native navigation grid and its world bounds do not align to 64-unit cells.');
    }
    const grid = {
        cellSize, width: intervalsX + 1, height: intervalsY + 1,
        origin: [worldMinX - cellSize / 2, worldMinY - cellSize / 2],
    };
    if (grid.width * grid.height > 4_000_000) throw new Error('Inferred terrain grid exceeds the scan limit.');
    return grid;
}

export function verifyRuntimeEntities(grid, mapData) {
    const classes = ['npc_dota_lotus_pool', 'npc_dota_unit_twin_gate', 'npc_dota_watch_tower'];
    const counts = {};
    for (const classname of classes) {
        const expected = mapData?.data?.[classname];
        if (!Array.isArray(expected)) throw new Error(`Exact map data is missing ${classname}; recapture the source archive first.`);
        const actual = grid.entities.filter(entity => entity.classname === classname);
        // The archive entity importer preserves only map-plane coordinates for
        // these gameplay structures; runtime entities additionally have a Z
        // height. Compare the source fields that exist in mapdata.json.
        const key = position => position.slice(0, 2).map(value => Math.fround(value)).join(',');
        const expectedPositions = new Set(expected.map(({ x, y }) => key([x, y])));
        const actualPositions = new Set(actual.map(entity => key(entity.origin)));
        if (actual.length !== expected.length || expectedPositions.size !== expected.length
            || actualPositions.size !== actual.length || actual.some(entity => !expectedPositions.has(key(entity.origin)))) {
            throw new Error(`Runtime ${classname} positions do not match the exact patch archive; capture was not installed.`);
        }
        counts[classname] = actual.length;
    }
    return counts;
}

export function createTerrainCapture(plan, grid) {
    const { treeIds, ...terrain } = grid;
    terrain.source = {
        ...grid.source,
        patch: plan.patch,
        mapArchiveSha256: plan.archiveSha256,
        mapResource: plan.source.resources.map.path,
        mapEntitiesSha256: plan.source.resources.entities?.sha256 || null,
        navigationSha256: plan.navigationSha256,
    };
    return terrain;
}

export function resolvePatchScanPlan({ patch, game: gameDirectory, archive: archiveInput, assetDirectory = path.join(root, 'assets') } = {}) {
    if (!patch || !patchPattern.test(patch)) throw new Error('A valid patch ID is required.');
    const directory = path.join(assetDirectory, 'data', patch);
    const source = JSON.parse(fs.readFileSync(path.join(directory, 'source.json'), 'utf8'));
    if (source.patch !== patch || !source.archiveSha256 || !source.resources?.map?.available) {
        throw new Error(`Patch ${patch} has incomplete archive provenance; re-import its exact map archive first.`);
    }
    const game = resolveGameDirectory(gameDirectory);
    const archivePath = path.resolve(archiveInput || path.join(game, 'dota/maps', source.archive));
    if (!fs.existsSync(archivePath)) {
        throw new Error(`Patch ${patch} archive is missing at ${archivePath}; provide the exact source with --archive <file>.`);
    }
    const archiveBytes = fs.readFileSync(archivePath);
    const archiveSha256 = sha256(archiveBytes);
    if (archiveSha256 !== source.archiveSha256) {
        throw new Error(`Patch ${patch} archive SHA-256 mismatch; refusing to scan a different map. Provide its exact archive with --archive.`);
    }
    const mapArchive = openVpk(archivePath);
    const mapBytes = mapArchive.read(source.resources.map.path);
    if (sha256(mapBytes) !== source.resources.map.sha256) {
        throw new Error(`Patch ${patch} map resource does not match source.json.`);
    }
    const entities = source.resources.entities;
    if (entities?.available) {
        if (sha256(mapArchive.read(entities.path)) !== entities.sha256) {
            throw new Error(`Patch ${patch} entity resource does not match source.json.`);
        }
    }

    let navigationBytes;
    let grid;
    if (source.resources.navigation?.available) {
        navigationBytes = mapArchive.read(source.resources.navigation.path);
        if (sha256(navigationBytes) !== source.resources.navigation.sha256) {
            throw new Error(`Patch ${patch} navigation grid does not match source.json.`);
        }
        const nav = readGridNav(navigationBytes);
        grid = { width: nav.width, height: nav.height, cellSize: nav.cellSize, origin: nav.origin };
    }
    else {
        const world = JSON.parse(fs.readFileSync(path.join(directory, 'worlddata.json'), 'utf8'));
        grid = inferCaptureGrid(world);
    }
    return {
        patch, mapName: source.mapName, source, game, archivePath, archiveSha256,
        navigationBytes, navigationSha256: navigationBytes ? sha256(navigationBytes) : null,
        grid, assetDirectory: path.resolve(assetDirectory),
    };
}

function assertNoDotaProcess() {
    if (process.platform === 'win32') {
        let output = '';
        try {
            output = execFileSync('tasklist.exe', ['/FI', 'IMAGENAME eq dota2.exe', '/FO', 'CSV', '/NH'], {
                encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
            });
        }
        catch (error) {
            if (error.code !== 'ENOENT') throw error;
            throw new Error('Could not verify that Dota Tools is closed; refusing to start a scan.');
        }
        if (/\bdota2\.exe\b/iu.test(output)) {
            throw new Error('Dota or Source Filmmaker is still running. Close it before starting the isolated map-data scan.');
        }
        return;
    }
    if (process.platform === 'linux') {
        try {
            const output = execFileSync('pgrep', ['-x', 'dota2'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
            if (output.trim()) throw new Error('Dota or Source Filmmaker is still running. Close it before starting the isolated map-data scan.');
        }
        catch (error) {
            if (error.status === 1) return;
            if (error.message.includes('still running')) throw error;
            throw new Error('Could not verify that Dota Tools is closed; refusing to start a scan.');
        }
    }
}

async function allocatePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address();
    await new Promise(resolve => server.close(resolve));
    return port;
}

async function waitForConsole(port, child, timeout = 120_000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
        if (child.scanFailed || child.exitCode !== null) throw new Error('The isolated map scan server exited before its console opened.');
        const connected = await new Promise(resolve => {
            const socket = net.createConnection({ host: '127.0.0.1', port });
            socket.setTimeout(500);
            const finish = value => {
                socket.destroy();
                resolve(value);
            };
            socket.once('connect', () => finish(true));
            socket.once('error', () => finish(false));
            socket.once('timeout', () => finish(false));
        });
        if (connected) return;
        await delay(500);
    }
    throw new Error('The isolated map scan server did not open its local console.');
}

export function compareRuntimeTreePositions(captured, expected) {
    const key = row => row.map(value => Math.fround(value)).join(',');
    const expectedRows = expected.map(({ x, y, z = 0 }) => [x, y, z]);
    const expectedPositions = new Set(expectedRows.map(key));
    const capturedPositions = new Set(captured.map(key));
    const duplicates = rows => {
        const seen = new Set();
        const result = [];
        for (const row of rows) {
            const position = key(row);
            if (seen.has(position)) result.push(position);
            seen.add(position);
        }
        return result;
    };
    const missing = expectedRows.filter(position => !capturedPositions.has(key(position))).map(key);
    const unexpected = captured.filter(position => !expectedPositions.has(key(position))).map(key);
    const duplicateExpected = duplicates(expectedRows);
    const duplicateCaptured = duplicates(captured);
    const missingRows = expectedRows.filter(position => !capturedPositions.has(key(position)));
    const unexpectedRows = captured.filter(position => !expectedPositions.has(key(position)));
    const nearest = (point, candidates) => candidates.map((candidate, index) => ({
        index,
        distance: Math.hypot(point[0] - candidate[0], point[1] - candidate[1], point[2] - candidate[2]),
    })).sort((a, b) => a.distance - b.distance);
    const forward = missingRows.map(point => nearest(point, unexpectedRows));
    const reverse = unexpectedRows.map(point => nearest(point, missingRows));
    const shiftedMatches = [];
    for (let i = 0; i < forward.length; i++) {
        const [best, second] = forward[i];
        if (!best || best.distance > 64 || (second && second.distance - best.distance <= 0.01)) continue;
        const [reverseBest, reverseSecond] = reverse[best.index] || [];
        if (reverseBest?.index === i && reverseBest.distance <= 64
            && (!reverseSecond || reverseSecond.distance - reverseBest.distance > 0.01)) {
            shiftedMatches.push({ from: key(missingRows[i]), to: key(unexpectedRows[best.index]), distance: best.distance });
        }
    }
    const spatiallyMatched = shiftedMatches.length === missingRows.length
        && shiftedMatches.length === unexpectedRows.length;
    const matches = captured.length === expectedRows.length && duplicateExpected.length === 0
        && duplicateCaptured.length === 0 && (missing.length === 0 || spatiallyMatched);
    return {
        matches,
        expectedCount: expectedRows.length,
        capturedCount: captured.length,
        missingCount: missing.length,
        unexpectedCount: unexpected.length,
        duplicateExpectedCount: duplicateExpected.length,
        duplicateCapturedCount: duplicateCaptured.length,
        shiftedMatchCount: shiftedMatches.length,
        maxShiftDistance: shiftedMatches.length ? Math.max(...shiftedMatches.map(match => match.distance)) : 0,
        missingSample: missing.slice(0, 5),
        unexpectedSample: unexpected.slice(0, 5),
        shiftedSample: shiftedMatches.slice(0, 5),
    };
}

function writeNewFile(filename, bytes) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, bytes, { flag: 'wx' });
}

function writeImportedFile(filename, bytes) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    if (!fs.existsSync(filename)) {
        fs.writeFileSync(filename, bytes, { flag: 'wx' });
        return;
    }
    const temporary = `${filename}.${randomBytes(8).toString('hex')}.tmp`;
    try {
        fs.writeFileSync(temporary, bytes, { flag: 'wx' });
        fs.renameSync(temporary, filename);
    }
    finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
}

function installCapture(plan, grid, overwrite) {
    const dataDirectory = path.join(plan.assetDirectory, 'data', plan.patch);
    const mapData = JSON.parse(fs.readFileSync(path.join(dataDirectory, 'mapdata.json'), 'utf8'));
    const treeValidation = compareRuntimeTreePositions(grid.trees, mapData.data.ent_dota_tree);
    if (!treeValidation.matches) {
        throw new Error(`Runtime tree positions do not match the exact patch map data: ${JSON.stringify(treeValidation)}; capture was not installed.`);
    }
    verifyRuntimeEntities(grid, mapData);
    const terrainCapture = createTerrainCapture(plan, grid);
    const terrainBytes = Buffer.from(`${JSON.stringify(terrainCapture, null, 2)}\n`);
    const terrainPath = path.join(dataDirectory, 'terrain_grid.json');
    const writes = [];
    if (fs.existsSync(terrainPath) && !overwrite) {
        if (sha256(fs.readFileSync(terrainPath)) !== sha256(terrainBytes)) {
            throw new Error(`Patch ${plan.patch} already has different terrain_grid.json; inspect it and rerun with --overwrite to replace it.`);
        }
    }
    else writes.push([terrainPath, terrainBytes]);

    if (plan.navigationBytes) {
        const navPath = path.join(dataDirectory, 'gridnav.gnv');
        if (!fs.existsSync(navPath)) writes.push([navPath, plan.navigationBytes]);
        else if (sha256(fs.readFileSync(navPath)) !== plan.navigationSha256) {
            throw new Error(`Patch ${plan.patch} gridnav.gnv differs from its source archive; refusing to overwrite the archive-derived file.`);
        }
    }

    let treeIndex;
    if (grid.treeIds.length === mapData.data.ent_dota_tree.length) {
        const mapIndices = mapTreeIds(grid.treeIds, mapData.data.ent_dota_tree);
        treeIndex = {
            source: {
                mapArchiveSha256: plan.archiveSha256,
                navigationSha256: plan.navigationSha256,
                method: 'GetTreeIdForEntityIndex on the patch-matched runtime map',
                nullEntries: 'Native tree-ID space may contain gaps where the runtime returned no corresponding tree entity.',
            },
            mapIndices,
        };
        const treeIndexPath = path.join(dataDirectory, 'live_tree_index.json');
        const bytes = Buffer.from(`${JSON.stringify(treeIndex, null, 2)}\n`);
        if (fs.existsSync(treeIndexPath) && !overwrite) {
            if (sha256(fs.readFileSync(treeIndexPath)) !== sha256(bytes)) {
                throw new Error(`Patch ${plan.patch} already has different live_tree_index.json; inspect it and rerun with --overwrite to replace it.`);
            }
        }
        else writes.push([treeIndexPath, bytes]);
    }

    const sourcePath = path.join(dataDirectory, 'source.json');
    const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
    const sourceWithCapture = {
        ...source,
        runtimeCapture: {
            mapName: plan.mapName,
            mapResource: plan.source.resources.map.path,
            mapArchiveSha256: plan.archiveSha256,
            mapEntitiesSha256: plan.source.resources.entities?.sha256 || null,
            navigationSha256: plan.navigationSha256,
            terrainSha256: sha256(terrainBytes),
            treeIndexSha256: treeIndex ? sha256(Buffer.from(`${JSON.stringify(treeIndex, null, 2)}\n`)) : null,
            treePositionValidation: treeValidation,
            method: 'Patch-matched isolated local dedicated-server scan.',
        },
        dataCoverage: {
            ...source.dataCoverage,
            terrainHeights: 'terrain_grid.json: patch-matched GetGroundHeight samples at native navigation cell centers, or aligned world-bound cells if no GNV exists',
            runtimeTreePositions: `${treeValidation.shiftedMatchCount} tree origins differ from exact map entity origins by at most ${treeValidation.maxShiftDistance} units; each mismatch was a unique reciprocal nearest match within one 64-unit cell`,
            liveTreeIds: treeIndex ? 'live_tree_index.json: patch-matched GetTreeIdForEntityIndex mapping; null entries preserve gaps in the native ID space' : 'not included: the runtime did not return a complete tree ID mapping',
        },
    };
    const sourceBytes = Buffer.from(`${JSON.stringify(sourceWithCapture, null, 2)}\n`);
    const existingCapture = source.runtimeCapture;
    if (existingCapture && !overwrite
        && (existingCapture.mapArchiveSha256 !== plan.archiveSha256
            || existingCapture.terrainSha256 !== sha256(terrainBytes))) {
        throw new Error(`Patch ${plan.patch} already records a different runtime capture in source.json; inspect it and rerun with --overwrite.`);
    }
    if (!existingCapture || existingCapture.mapArchiveSha256 !== plan.archiveSha256
        || existingCapture.terrainSha256 !== sha256(terrainBytes)) writes.push([sourcePath, sourceBytes]);

    for (const [filename, bytes] of writes) writeImportedFile(filename, bytes);
    return { terrainFile: terrainPath, treeIndex: !!treeIndex };
}

export async function scanPatchMapData({ patch, game, archive, assetDirectory = path.join(root, 'assets'),
    output, install = false, overwrite = false, timeout = 600_000 } = {}) {
    const plan = resolvePatchScanPlan({ patch, game, archive, assetDirectory });
    assertNoDotaProcess();
    const captureParent = path.join(root, 'map-captures', patch);
    fs.mkdirSync(captureParent, { recursive: true });
    const runId = `${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${randomBytes(3).toString('hex')}`;
    const captureDirectory = path.resolve(output || path.join(captureParent, `runtime-${runId}`));
    if (!captureDirectory.startsWith(`${path.resolve(root, 'map-captures')}${path.sep}`)) {
        throw new Error('Runtime scan output must be inside ignored map-captures/.');
    }
    fs.mkdirSync(captureDirectory, { recursive: false });

    const addonName = `interactive-map-scan-${patch}-${randomBytes(5).toString('hex')}`;
    const addonDirectory = path.join(plan.game, 'dota_addons', addonName);
    const expectedAddonParent = path.resolve(plan.game, 'dota_addons');
    if (path.dirname(path.resolve(addonDirectory)) !== expectedAddonParent || fs.existsSync(addonDirectory)) {
        throw new Error('Could not reserve a unique temporary scan add-on directory.');
    }
    const script = `interactive_map_grid_${randomBytes(8).toString('hex')}`;
    const scriptFile = path.join(plan.game, 'dota/scripts/vscripts', `${script}.lua`);
    const options = `INTERACTIVE_MAP_EXPORT = { width=${plan.grid.width}, height=${plan.grid.height}, cellSize=${plan.grid.cellSize}, minX=${plan.grid.origin[0]}, minY=${plan.grid.origin[1]} }\n`;
    const lua = options + fs.readFileSync(path.join(root, 'scripts/export-game-grid.lua'), 'utf8');
    const port = await allocatePort();
    let child;
    let addonCreated = false;
    let scriptCreated = false;
    try {
        fs.mkdirSync(addonDirectory);
        addonCreated = true;
        writeNewFile(path.join(addonDirectory, 'addoninfo.txt'), Buffer.from(addonInfo(patch)));
        fs.copyFileSync(plan.archivePath, path.join(addonDirectory, 'pak01_dir.vpk'));
        writeNewFile(scriptFile, Buffer.from(lua));
        scriptCreated = true;
        const executable = path.join(plan.game, 'bin/win64/dota2.exe');
        if (!fs.existsSync(executable)) throw new Error(`Dota executable not found at ${executable}.`);
        child = spawn(executable, ['-dedicated', '-dev', '-insecure', '-novid', '-nosound', '-nohltv',
            '-netconport', String(port), '-addon', addonName, '+sv_lan', '1', '+map', plan.mapName], {
            cwd: path.join(plan.game, 'dota'), windowsHide: true, stdio: 'ignore',
        });
        child.once('error', () => { child.scanFailed = true; });
        await waitForConsole(port, child);
        const grid = await scanConsole({ port, script, map: plan.mapName, timeout });
        if (grid.width !== plan.grid.width || grid.height !== plan.grid.height || grid.cellSize !== plan.grid.cellSize
            || JSON.stringify(grid.origin) !== JSON.stringify(plan.grid.origin)) {
            throw new Error('Runtime grid geometry differs from this patch archive; capture was not installed.');
        }
        const mapData = JSON.parse(fs.readFileSync(path.join(plan.assetDirectory, 'data', patch, 'mapdata.json'), 'utf8'));
        const treeValidation = compareRuntimeTreePositions(grid.trees, mapData.data.ent_dota_tree);
        let entityCounts;
        let entityValidationError = null;
        try {
            entityCounts = verifyRuntimeEntities(grid, mapData);
        }
        catch (error) {
            entityValidationError = error.message;
        }
        const terrainCapture = createTerrainCapture(plan, grid);
        const terrainBytes = Buffer.from(`${JSON.stringify(terrainCapture, null, 2)}\n`);
        const treeRowsBytes = Buffer.from(`${JSON.stringify(grid.treeIds, null, 2)}\n`);
        const validation = {
            treePositions: treeValidation,
            runtimeEntities: entityValidationError ? { matches: false, error: entityValidationError } : { matches: true, counts: entityCounts },
        };
        const installable = treeValidation.matches && !entityValidationError;
        writeNewFile(path.join(captureDirectory, 'terrain_grid.json'), terrainBytes);
        writeNewFile(path.join(captureDirectory, 'live_tree_ids.json'), treeRowsBytes);
        if (plan.navigationBytes) writeNewFile(path.join(captureDirectory, 'gridnav.gnv'), plan.navigationBytes);
        const captureManifest = {
            schemaVersion: 1, patch, mapName: plan.mapName, archive: path.basename(plan.archivePath),
            archiveSha256: plan.archiveSha256, navigationSha256: plan.navigationSha256,
            terrainSha256: sha256(terrainBytes), treeRowsSha256: sha256(treeRowsBytes),
            width: grid.width, height: grid.height, cellSize: grid.cellSize, origin: grid.origin,
            trees: grid.trees.length, nativeTreeIds: grid.treeIds.length,
            runtimeEntityCounts: entityCounts || null,
            validation,
            installable,
            source: 'Isolated local dedicated server mounting the exact map archive as a temporary add-on.',
        };
        writeNewFile(path.join(captureDirectory, 'capture.json'), Buffer.from(`${JSON.stringify(captureManifest, null, 2)}\n`));
        if (!installable) {
            throw new Error(`Patch-matched runtime capture failed validation and was preserved at ${captureDirectory}; inspect capture.json before retrying.`);
        }
        const installed = install ? installCapture(plan, grid, overwrite) : null;
        return { captureDirectory, captureManifest, installed };
    }
    finally {
        if (child && child.exitCode === null) {
            child.kill();
            await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(10_000)]);
        }
        if (scriptCreated && fs.existsSync(scriptFile)) fs.unlinkSync(scriptFile);
        if (addonCreated && fs.existsSync(path.join(addonDirectory, 'addoninfo.txt'))
            && path.basename(addonDirectory).startsWith(`interactive-map-scan-${patch}-`)) {
            fs.rmSync(addonDirectory, { recursive: true, force: false });
        }
    }
}

function main(argv = process.argv.slice(2)) {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
        game: { type: 'string' }, archive: { type: 'string' }, output: { type: 'string' },
        timeout: { type: 'string' }, install: { type: 'boolean' }, overwrite: { type: 'boolean' }, plan: { type: 'boolean' },
    } });
    const [patch] = positionals;
    if (!patch || positionals.length !== 1) {
        throw new Error('Usage: npm run map:scan-data -- <patch> [--game <game-directory>] [--archive <exact-vpk>] [--output <map-captures-directory>] [--install] [--overwrite] [--plan]');
    }
    const options = { patch, game: values.game, archive: values.archive };
    if (values.plan) {
        if (values.install || values.overwrite || values.output || values.timeout) throw new Error('--plan cannot be combined with scan or install options.');
        const plan = resolvePatchScanPlan(options);
        console.log(JSON.stringify({ patch, mapName: plan.mapName, archive: plan.archivePath,
            archiveSha256: plan.archiveSha256, navigationSha256: plan.navigationSha256,
            grid: plan.grid, installsNativeWardGrid: !!plan.navigationBytes }, null, 2));
        return;
    }
    const timeout = values.timeout === undefined ? 600_000 : Number(values.timeout);
    if (!Number.isSafeInteger(timeout) || timeout < 1_000 || timeout > 1_800_000) {
        throw new Error('--timeout must be between 1000 and 1800000 milliseconds.');
    }
    scanPatchMapData({ ...options, output: values.output, install: values.install, overwrite: values.overwrite, timeout })
        .then(result => {
            console.log(`Captured ${result.captureManifest.trees} patch-matched trees on ${patch} at ${result.captureDirectory}.`);
            console.log(`Native tree IDs: ${result.captureManifest.nativeTreeIds}/${result.captureManifest.trees}.`);
            if (result.installed) console.log(`Installed terrain_grid.json${result.installed.treeIndex ? ' and live_tree_index.json' : ''}.`);
            else console.log('Capture remains in ignored map-captures; pass --install after reviewing it to generate patch data.');
        })
        .catch(error => {
            console.error(error.message);
            process.exitCode = 1;
        });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
