import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { openVpk, resolveGameDirectory } from '../src/node/game-files.mjs';
import { buildNeutralSpawnBoxes, mergeNeutralSpawnBoxes, parseNeutralSpawnEntities,
    parseSource2PhysicsHull } from './neutral-spawn-boxes.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resourceVersion = /^[\w.+-]{1,128}$/;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function resourceFileName(resourcePath) {
    return `${resourcePath.replaceAll('/', '__')}.txt`;
}

function writeAtomic(filename, content) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const temporary = `${filename}.${randomBytes(8).toString('hex')}.tmp`;
    try {
        fs.writeFileSync(temporary, content, { flag: 'wx' });
        fs.renameSync(temporary, filename);
    }
    finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
}

function decodeResource(resourceTool, input, block) {
    return execFileSync(resourceTool, ['-i', input, '-b', block], {
        windowsHide: true,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        timeout: 120_000,
    });
}

function runCapture({ archive, entityBytes, entityResourcePath, patch, archiveSha256, navigationSha256,
    resourceTool, resourceToolVersion, captureRoot }) {
    const runRoot = fs.mkdtempSync(path.join(captureRoot, 'run-'));
    const resourceDirectory = path.join(runRoot, 'resources');
    const decodedDirectory = path.join(runRoot, 'decoded');
    fs.mkdirSync(resourceDirectory, { recursive: true });
    fs.mkdirSync(decodedDirectory, { recursive: true });
    const resources = new Map();
    const decodedResources = [];
    const decode = (resourcePath, bytes, block) => {
        const input = path.join(resourceDirectory, resourceFileName(resourcePath).replace(/\.txt$/, ''));
        const output = path.join(decodedDirectory, `${resourceFileName(resourcePath)}.${block.toLowerCase()}.txt`);
        fs.writeFileSync(input, bytes, { flag: 'wx' });
        const text = decodeResource(resourceTool, input, block);
        fs.writeFileSync(output, text, { flag: 'wx' });
        resources.set(resourcePath, { resourcePath, bytes: bytes.length, sha256: sha256(bytes) });
        decodedResources.push({ resourcePath, block, bytes: Buffer.byteLength(text), sha256: sha256(text) });
        return text;
    };

    const entityText = decode(entityResourcePath, entityBytes, 'DATA');
    const entities = parseNeutralSpawnEntities(entityText);
    const triggerModels = [...new Set(entities.filter(entity => entity.classname === 'trigger_multiple'
        && entity.targetname?.startsWith('[PR#]neutralcamp_')).map(entity => entity.model))].sort();
    if (!triggerModels.length) throw new Error('Source map has no neutral camp trigger models.');
    const models = new Map();
    for (const modelPath of triggerModels) {
        const resourcePath = `${modelPath}_c`;
        const bytes = archive.read(resourcePath);
        const text = decode(resourcePath, bytes, 'PHYS');
        models.set(modelPath, { ...parseSource2PhysicsHull(text), sha256: sha256(bytes) });
    }
    const toolBytes = fs.readFileSync(resourceTool);
    const manifest = {
        patch, archiveSha256, navigationSha256, entityResourcePath,
        source2ViewerCli: resourceToolVersion,
        source2ViewerCliSha256: sha256(toolBytes),
        resources: [...resources.values()].sort((a, b) => a.resourcePath.localeCompare(b.resourcePath)),
        decodedResources: decodedResources.sort((a, b) => a.resourcePath.localeCompare(b.resourcePath)
            || a.block.localeCompare(b.block)),
    };
    writeAtomic(path.join(runRoot, 'source-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    return { entities, models, source2ViewerCli: resourceToolVersion,
        source2ViewerCliSha256: manifest.source2ViewerCliSha256 };
}

function readCaptured({ archive, entityBytes, entityResourcePath, captureRoot, patch, archiveSha256, navigationSha256 }) {
    const manifestPath = path.join(captureRoot, 'source-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const capturedNavigationSha256 = manifest.navigationSha256 ?? manifest.gridnavSha256 ?? null;
    if (manifest.patch !== patch
        || (manifest.archiveSha256 && manifest.archiveSha256 !== archiveSha256)
        || (manifest.entityResourcePath && manifest.entityResourcePath !== entityResourcePath)
        || capturedNavigationSha256 !== navigationSha256
        || (manifest.sourceArchive && manifest.sourceArchive !== 'dota/maps/dota.vpk'
            && manifest.archiveSha256 === undefined)
        || !resourceVersion.test(manifest.source2ViewerCli || '')) {
        throw new Error('Captured neutral spawn resources do not match the selected patch archive.');
    }
    const decodedDirectory = path.join(captureRoot, 'decoded');
    const captureFile = resourcePath => path.join(captureRoot, resourcePath);
    const decodedFile = resourcePath => path.join(decodedDirectory, resourceFileName(resourcePath));
    const sourceResources = new Map((manifest.resources || []).map(resource => [resource.resourcePath, resource]));
    const modelResources = new Map();
    const decodedResources = [];
    const readDecoded = (resourcePath, block) => {
        const bytes = archive.read(resourcePath);
        const capturedBytes = fs.readFileSync(captureFile(resourcePath));
        if (sha256(bytes) !== sha256(capturedBytes)) {
            throw new Error('Captured source resource differs from the installed Dota archive: ' + resourcePath);
        }
        const sourceEntry = sourceResources.get(resourcePath);
        if (sourceEntry && (sourceEntry.sha256 !== sha256(bytes) || sourceEntry.bytes !== bytes.length)) {
            throw new Error('Captured resource manifest does not match the installed Dota archive: ' + resourcePath);
        }
        const text = fs.readFileSync(decodedFile(resourcePath), 'utf8');
        const expectedDecoded = (manifest.decodedResources || []).find(entry => entry.resourcePath === resourcePath
            && entry.block === block);
        if (expectedDecoded && (expectedDecoded.sha256 !== sha256(text)
            || expectedDecoded.bytes !== Buffer.byteLength(text))) {
            throw new Error('Captured decoded resource differs from its manifest: ' + resourcePath);
        }
        decodedResources.push({ resourcePath, block, bytes: Buffer.byteLength(text), sha256: sha256(text) });
        return { bytes, text };
    };

    const { text: entityText } = readDecoded(entityResourcePath, 'DATA');
    const entities = parseNeutralSpawnEntities(entityText);
    const triggerModels = [...new Set(entities.filter(entity => entity.classname === 'trigger_multiple'
        && entity.targetname?.startsWith('[PR#]neutralcamp_')).map(entity => entity.model))].sort();
    if (!triggerModels.length) throw new Error('Captured map has no neutral camp trigger models.');
    const models = new Map();
    for (const modelPath of triggerModels) {
        const resourcePath = `${modelPath}_c`;
        const { bytes, text } = readDecoded(resourcePath, 'PHYS');
        modelResources.set(resourcePath, { resourcePath, bytes: bytes.length, sha256: sha256(bytes) });
        models.set(modelPath, { ...parseSource2PhysicsHull(text), sha256: sha256(bytes) });
    }
    const nextManifest = {
        ...manifest,
        archiveSha256,
        navigationSha256,
        entityResourcePath,
        resources: [...new Map([
            ...(manifest.resources || []).map(resource => [resource.resourcePath, resource]),
            [entityResourcePath, { resourcePath: entityResourcePath, bytes: entityBytes.length, sha256: sha256(entityBytes) }],
            ...modelResources,
        ]).values()].sort((a, b) => a.resourcePath.localeCompare(b.resourcePath)),
        decodedResources: [...new Map([
            ...(manifest.decodedResources || []).map(resource => [`${resource.resourcePath}:${resource.block}`, resource]),
            ...decodedResources.map(resource => [`${resource.resourcePath}:${resource.block}`, resource]),
        ]).values()].sort((a, b) => a.resourcePath.localeCompare(b.resourcePath) || a.block.localeCompare(b.block)),
    };
    return { entities, models, source2ViewerCli: manifest.source2ViewerCli,
        source2ViewerCliSha256: manifest.source2ViewerCliSha256 || null, nextManifest };
}

export async function importNeutralSpawnBoxes({ patch, game: gameDirectory, archive: archiveInput, resourceTool, resourceToolVersion,
    captureRoot: captureRootOption, assetDirectory = path.join(root, 'assets'),
    mapCaptureDirectory = path.join(root, 'map-captures') } = {}) {
    const useCapture = Boolean(captureRootOption);
    if (!patch || !/^[a-z0-9]+$/iu.test(patch)
        || (useCapture && resourceTool)
        || (!useCapture && (!resourceTool || !resourceVersion.test(resourceToolVersion || '')))) {
        throw new Error('A valid patch and either a verified captureRoot or resourceTool plus resourceToolVersion are required.');
    }
    const directory = path.join(assetDirectory, 'data', patch);
    const mapdataPath = path.join(directory, 'mapdata.json');
    const patchSource = JSON.parse(fs.readFileSync(path.join(directory, 'source.json'), 'utf8'));
    if (patchSource.patch !== patch || !patchSource.archiveSha256 || !patchSource.resources?.entities?.available) {
        throw new Error(`Patch ${patch} is missing exact map archive or entity provenance; re-import its map data first.`);
    }
    const game = archiveInput ? null : resolveGameDirectory(gameDirectory);
    const archivePath = path.resolve(archiveInput || path.join(game, 'dota/maps', patchSource.archive));
    if (!fs.existsSync(archivePath)) throw new Error(`Exact patch ${patch} map archive is missing; pass --archive <file>.`);
    const archiveBytes = fs.readFileSync(archivePath);
    const archiveSha256 = sha256(archiveBytes);
    if (archiveSha256 !== patchSource.archiveSha256) {
        throw new Error(`Patch ${patch} map archive SHA-256 mismatch; refusing to use a different version.`);
    }
    const archive = openVpk(archivePath);
    const entityResourcePath = patchSource.resources.entities.path;
    const entityBytes = archive.read(entityResourcePath);
    if (sha256(entityBytes) !== patchSource.resources.entities.sha256) {
        throw new Error(`Patch ${patch} entity resource does not match source.json.`);
    }
    let gridnavSha256 = null;
    if (patchSource.resources.navigation?.available) {
        const gridnav = archive.read(patchSource.resources.navigation.path);
        gridnavSha256 = sha256(gridnav);
        if (gridnavSha256 !== patchSource.resources.navigation.sha256
            || gridnavSha256 !== sha256(fs.readFileSync(path.join(directory, 'gridnav.gnv')))) {
            throw new Error('Exact archive navigation differs from this patch data; re-import the map archive first.');
        }
    }
    else if (fs.existsSync(path.join(directory, 'gridnav.gnv'))) {
        throw new Error(`Patch ${patch} archive has no native navigation, but data contains gridnav.gnv.`);
    }
    const captureRoot = useCapture ? path.resolve(captureRootOption)
        : path.join(mapCaptureDirectory, patch, 'neutral-spawn-boxes');
    fs.mkdirSync(captureRoot, { recursive: true });
    const capture = useCapture
        ? readCaptured({ archive, entityBytes, entityResourcePath, captureRoot, patch, archiveSha256, navigationSha256: gridnavSha256 })
        : runCapture({ archive, entityBytes, entityResourcePath, patch, archiveSha256,
            navigationSha256: gridnavSha256, resourceTool, resourceToolVersion, captureRoot });
    const mapdata = JSON.parse(fs.readFileSync(mapdataPath, 'utf8'));
    if (!Array.isArray(mapdata.data?.npc_dota_neutral_spawner)
        || mapdata.data.npc_dota_neutral_spawner.length === 0) {
        throw new Error('Selected map data has no neutral spawner sites.');
    }
    const source = {
        patch,
        gameClientVersion: patchSource.gameClientVersion || null,
        mapArchiveSha256: archiveSha256,
        gridnavSha256,
        entityResource: { path: entityResourcePath, sha256: sha256(entityBytes) },
        source2ViewerCli: capture.source2ViewerCli,
        ...(capture.source2ViewerCliSha256 ? { source2ViewerCliSha256: capture.source2ViewerCliSha256 } : {}),
    };
    const boxes = buildNeutralSpawnBoxes({ camps: mapdata.data.npc_dota_neutral_spawner,
        entities: capture.entities, models: capture.models, source });
    const merged = mergeNeutralSpawnBoxes(mapdata, boxes);
    const output = `${JSON.stringify(merged)}\n`;
    const destination = path.join(directory, 'mapdata.json');
    if (useCapture) writeAtomic(path.join(captureRoot, 'source-manifest.json'),
        `${JSON.stringify(capture.nextManifest, null, 2)}\n`);
    writeAtomic(destination, output);
    console.log(`Imported ${boxes.length} neutral spawn boxes from ${capture.models.size} verified PHYS models for patch ${patch}.`);
    return merged;
}

async function main(argv = process.argv.slice(2)) {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
        game: { type: 'string' }, archive: { type: 'string' }, 'resource-tool': { type: 'string' },
        'resource-tool-version': { type: 'string' }, 'capture-root': { type: 'string' },
    } });
    const [patch] = positionals;
    if (positionals.length !== 1) {
        throw new Error('Usage: npm run import:neutral-spawn-boxes -- <patch> --resource-tool <Source2Viewer-CLI> --resource-tool-version <version> [--archive <exact-map-vpk>] [--game <directory>] | --capture-root <capture-directory> [--archive <exact-map-vpk>] [--game <directory>]');
    }
    await importNeutralSpawnBoxes({ patch, game: values.game, archive: values.archive, resourceTool: values['resource-tool'],
        resourceToolVersion: values['resource-tool-version'], captureRoot: values['capture-root'] });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
