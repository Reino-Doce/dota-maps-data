// Extract the installed game's versioned simple and detailed minimaps. Importing this module is inert.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { openVpk, readInstalledClientVersion, resolveGameDirectory } from '../src/node/game-files.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const vpkSignature = 0x55aa1234;
const overviewConfigPattern = /^resource\/overviews\/dota(?:_([0-9]+))?\.txt$/iu;
const overviewResourcePattern = /^materials\/overviews\/dota[^/]*\.(?:vmat_c|vtex_c)$/iu;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function filesRecursively(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const filename = path.join(directory, entry.name);
        if (entry.isDirectory()) return filesRecursively(filename);
        return entry.isFile() ? [filename] : [];
    });
}

function hasVpkSignature(filename) {
    const descriptor = fs.openSync(filename, 'r');
    try {
        const header = Buffer.alloc(4);
        return fs.readSync(descriptor, header, 0, header.length, 0) === header.length
            && header.readUInt32LE(0) === vpkSignature;
    }
    finally {
        fs.closeSync(descriptor);
    }
}

function preferredSource(currentPath, candidatePath, gameDirectory) {
    const preferredArchive = path.join(gameDirectory, 'dota', 'pak01_dir.vpk');
    if (path.resolve(candidatePath) === path.resolve(preferredArchive)) return true;
    return path.resolve(currentPath) !== path.resolve(preferredArchive) && candidatePath.localeCompare(currentPath) < 0;
}

export function scanOverviewVpks(gameDirectory) {
    if (typeof gameDirectory !== 'string' || !path.isAbsolute(gameDirectory)
        || !fs.existsSync(path.join(gameDirectory, 'dota', 'pak01_dir.vpk'))) {
        throw new Error('Pass the absolute Dota game directory containing dota/pak01_dir.vpk.');
    }
    const configs = new Map();
    const materials = new Map();
    let archivesScanned = 0;
    for (const filename of filesRecursively(gameDirectory).filter(file => file.toLowerCase().endsWith('.vpk'))) {
        if (!hasVpkSignature(filename)) continue;
        archivesScanned += 1;
        let archive;
        try {
            archive = openVpk(filename);
        }
        catch (error) {
            throw new Error(`Could not read VPK index ${filename}: ${error.message}`, { cause: error });
        }
        for (const resourcePath of archive.files) {
            if (overviewConfigPattern.test(resourcePath)) {
                const previous = configs.get(resourcePath);
                if (!previous || preferredSource(previous.archivePath, filename, gameDirectory)) {
                    configs.set(resourcePath, { archivePath: filename, resourcePath });
                }
            }
            else if (overviewResourcePattern.test(resourcePath)) {
                const previous = materials.get(resourcePath);
                if (!previous || preferredSource(previous.archivePath, filename, gameDirectory)) {
                    materials.set(resourcePath, { archivePath: filename, resourcePath });
                }
            }
        }
    }
    return { archivesScanned, configs, materials };
}

export function parseOverviewMapConfig(source) {
    if (typeof source !== 'string' || source.length === 0) throw new Error('Empty Dota overview configuration.');
    const read = key => {
        const match = new RegExp('^\\s*' + key + '\\s+(?:"([^"]+)"|([^\\s]+))', 'im').exec(source);
        return match?.[1] ?? match?.[2] ?? null;
    };
    const material = read('material');
    if (!material || !/^materials\/overviews\/[a-z0-9_]+\.vmat$/iu.test(material)) {
        throw new Error('Dota overview config is missing a supported material path.');
    }
    const simpleMaterial = read('simple_material');
    if (simpleMaterial && !/^materials\/overviews\/[a-z0-9_]+\.vmat$/iu.test(simpleMaterial)) {
        throw new Error('Dota overview config has an unsupported simple material path.');
    }
    return { material, simpleMaterial };
}

export function parseOverviewMaterialTexture(source, materialPath) {
    if (typeof source !== 'string' || source.length === 0) {
        throw new Error(`Empty overview material ${materialPath}.`);
    }
    const match = /"g_tColor"\s+"(materials\/overviews\/[a-z0-9_]+\.vtex)"/iu.exec(source);
    if (!match) throw new Error(`Overview material ${materialPath} has no g_tColor texture.`);
    return match[1];
}

export function resolveOverviewMaterialPath(materialPath, patch, availableMaterials) {
    const compiled = materialPath.replace(/\.vmat$/iu, '.vmat_c');
    if (availableMaterials.has(compiled)) return materialPath;
    // The retained 683 overview config names a removed material; its VPK keeps the uniquely
    // versioned replacement under dotamap683.vmat.
    if (patch === '683' && materialPath === 'materials/overviews/dota_683.vmat'
        && availableMaterials.has('materials/overviews/dotamap683.vmat_c')) {
        return 'materials/overviews/dotamap683.vmat';
    }
    throw new Error(`No installed VPK contains overview material ${compiled}.`);
}

export function getOverviewMaterialEntries(config, patch) {
    // Patch 683's retained overview material is the schematic minimap, despite
    // the config placing it in the usual `material` field.
    if (patch === '683') {
        return [['simple', config.material]];
    }
    return [
        ['detailed', config.material],
        ...(config.simpleMaterial ? [['simple', config.simpleMaterial]] : []),
    ];
}

export function isPatchSpecificOverviewMaterial(materialPath, patch) {
    if (typeof materialPath !== 'string' || typeof patch !== 'string') return false;
    const basename = path.posix.basename(materialPath).replace(/\.vmat$/iu, '').toLowerCase();
    return basename.endsWith(`_${patch.toLowerCase()}`) || basename === `dotamap${patch.toLowerCase()}`;
}

export function selectConfiguredOverviewMaterial(materialPath, patch, currentPatch, availableMaterials) {
    if (patch !== currentPatch && !isPatchSpecificOverviewMaterial(materialPath, patch)) return null;
    return resolveOverviewMaterialPath(materialPath, patch, availableMaterials);
}

export function collectRejectedCandidates(previousProvenance, images) {
    const rejectedCandidates = { ...(previousProvenance?.rejectedCandidates ?? {}) };
    for (const [kind, candidate] of Object.entries(rejectedCandidates)) {
        rejectedCandidates[kind] = {
            ...candidate,
            historicalReason: candidate.historicalReason ?? candidate.reason,
            reason: `Earlier candidate retained for audit; it is not the replacement currently listed under images.${kind}.`,
        };
    }
    for (const [kind, candidate] of Object.entries(previousProvenance?.omittedImages ?? {})) {
        if (candidate.sha256 && (!images[kind] || candidate.sha256 !== images[kind].sha256)) {
            rejectedCandidates[kind] = {
                ...candidate,
                historicalReason: candidate.reason,
                reason: `Earlier candidate retained for audit; it is not the replacement currently listed under images.${kind}.`,
            };
        }
    }
    return rejectedCandidates;
}

export function selectOverviewConfigs(configs, patch, currentPatch) {
    if (patch !== undefined && (typeof patch !== 'string' || !/^[a-z0-9]+$/iu.test(patch))) {
        throw new Error('Pass a valid patch ID.');
    }
    if (typeof currentPatch !== 'string' || !/^[a-z0-9]+$/iu.test(currentPatch)) {
        throw new Error('Pass a valid currentPatch ID.');
    }
    const sources = [...configs.values()];
    const selected = patch === undefined
        ? sources.filter(source => overviewConfigPattern.exec(source.resourcePath)?.[1] !== undefined
            || source.resourcePath === 'resource/overviews/dota.txt')
        : sources.filter(source => overviewConfigPattern.exec(source.resourcePath)?.[1] === patch);
    if (patch === undefined || selected.length > 0) {
        return selected.sort((a, b) => a.resourcePath.localeCompare(b.resourcePath));
    }
    if (patch === currentPatch) {
        return sources.filter(source => source.resourcePath === 'resource/overviews/dota.txt');
    }
    return [];
}

function runSource2Viewer(resourceTool, archivePath, outputDirectory, gameInfo) {
    try {
        execFileSync(resourceTool, [
            '-i', archivePath,
            '--vpk_filepath', 'materials/overviews/dota',
            '--vpk_extensions', 'vmat_c,vtex_c',
            '-d',
            '-o', outputDirectory,
            '--game', gameInfo,
        ], { windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 180_000 });
    }
    catch (error) {
        const detail = error.stderr?.toString().trim() || error.message;
        throw new Error(`Source 2 Viewer could not decode overview textures in ${archivePath}: ${detail}`, { cause: error });
    }
}

function writeAtomic(filename, bytes) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const temporary = `${filename}.${process.pid}.tmp`;
    try {
        fs.writeFileSync(temporary, bytes, { flag: 'wx' });
        fs.renameSync(temporary, filename);
    }
    finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
}

function readTextureExport(exportDirectory, texturePath) {
    const imagePath = path.join(exportDirectory, ...texturePath.replace(/\.vtex$/iu, '.png').split('/'));
    if (!fs.existsSync(imagePath)) throw new Error(`Source 2 Viewer did not export ${texturePath} to PNG.`);
    const bytes = fs.readFileSync(imagePath);
    let image;
    try {
        image = PNG.sync.read(bytes);
    }
    catch (error) {
        throw new Error(`Source 2 Viewer produced an invalid PNG for ${texturePath}: ${error.message}`, { cause: error });
    }
    if (image.width !== image.height || image.width < 256) {
        throw new Error(`Overview texture ${texturePath} has unexpected dimensions ${image.width}x${image.height}.`);
    }
    return { bytes, width: image.width, height: image.height };
}

export function importVpkMinimaps({ gameDirectory, resourceTool, outputDirectory = path.join(root, 'assets'),
    patch,
    currentPatch = packageJson.dotaMapsData?.currentPatch, overwrite = false } = {}) {
    if (typeof gameDirectory !== 'string' || !path.isAbsolute(gameDirectory)
        || !fs.existsSync(path.join(gameDirectory, 'dota', 'pak01_dir.vpk'))) {
        throw new Error('Pass --game with the absolute Dota game directory containing dota/pak01_dir.vpk.');
    }
    if (typeof resourceTool !== 'string' || !path.isAbsolute(resourceTool) || !fs.existsSync(resourceTool)) {
        throw new Error('Pass --resource-tool with an existing absolute Source2Viewer-CLI path.');
    }
    if (typeof outputDirectory !== 'string' || !path.isAbsolute(outputDirectory)) {
        throw new Error('Pass --output with an absolute assets directory.');
    }
    const resourceToolSha256 = sha256(fs.readFileSync(resourceTool));
    const discovered = scanOverviewVpks(gameDirectory);
    const selectedConfigs = selectOverviewConfigs(discovered.configs, patch, currentPatch);
    if (!selectedConfigs.length) {
        throw new Error(patch
            ? `No overview config for patch ${patch} was found in the scanned VPKs.`
            : 'No versioned Dota overview configs were found in installed VPKs.');
    }

    const archivePaths = [...new Set([...selectedConfigs, ...discovered.materials.values()]
        .map(source => source.archivePath))];
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dota-vpk-minimaps-'));
    try {
        const exportsByArchive = new Map();
        for (const [index, archivePath] of archivePaths.entries()) {
            const exportDirectory = path.join(temporaryDirectory, `vpk-${index}`);
            runSource2Viewer(resourceTool, archivePath, exportDirectory, path.join(gameDirectory, 'dota', 'gameinfo.gi'));
            exportsByArchive.set(archivePath, exportDirectory);
        }

        const pending = new Map();
        const unavailableImages = [];
        const mainArchive = path.join(gameDirectory, 'dota', 'pak01_dir.vpk');
        const currentBuild = readInstalledClientVersion(gameDirectory);
        for (const source of selectedConfigs) {
            const config = parseOverviewMapConfig(openVpk(source.archivePath).read(source.resourcePath).toString('utf8'));
            const configName = path.posix.basename(source.resourcePath);
            const version = overviewConfigPattern.exec(source.resourcePath)[1];
            const patchId = version ?? patch ?? currentPatch;
            if (pending.has(patchId)) throw new Error(`More than one default Dota overview config resolves to patch ${patchId}.`);
            const entries = {};
            for (const [kind, materialPath] of getOverviewMaterialEntries(config, patchId)) {
                const selectedMaterialPath = selectConfiguredOverviewMaterial(
                    materialPath, patchId, currentPatch, discovered.materials);
                if (!selectedMaterialPath) {
                    unavailableImages.push({ patch: patchId, kind, material: materialPath });
                    continue;
                }
                const resolvedMaterialPath = resolveOverviewMaterialPath(selectedMaterialPath, patchId, discovered.materials);
                const compiledMaterial = resolvedMaterialPath.replace(/\.vmat$/iu, '.vmat_c');
                const materialSource = discovered.materials.get(compiledMaterial);
                const exportDirectory = exportsByArchive.get(materialSource.archivePath);
                const exportedMaterialPath = path.join(exportDirectory, ...compiledMaterial
                    .replace(/\.vmat_c$/iu, '.vmat').split('/'));
                if (!fs.existsSync(exportedMaterialPath)) {
                    throw new Error(`Source 2 Viewer did not export overview material ${compiledMaterial}.`);
                }
                const texturePath = parseOverviewMaterialTexture(fs.readFileSync(exportedMaterialPath, 'utf8'), resolvedMaterialPath);
                const textureResource = `${texturePath}_c`;
                const textureSource = discovered.materials.get(textureResource);
                if (!textureSource) {
                    throw new Error(`No installed VPK contains overview texture ${textureResource}.`);
                }
                const textureExportDirectory = exportsByArchive.get(textureSource.archivePath);
                const image = readTextureExport(textureExportDirectory, texturePath);
                const sourceArchive = openVpk(materialSource.archivePath);
                const compiledMaterialBytes = sourceArchive.read(compiledMaterial);
                const textureBytes = openVpk(textureSource.archivePath).read(textureResource);
                entries[kind] = {
                    path: `img/${patchId}/minimaps/${kind}.png`,
                    sourceMaterial: selectedMaterialPath,
                    configuredMaterial: materialPath,
                    materialSelection: 'overview-config',
                    resolvedMaterial: resolvedMaterialPath,
                    materialResource: compiledMaterial,
                    materialArchive: path.relative(gameDirectory, materialSource.archivePath).replaceAll('\\', '/'),
                    materialSha256: sha256(compiledMaterialBytes),
                    textureResource,
                    textureArchive: path.relative(gameDirectory, textureSource.archivePath).replaceAll('\\', '/'),
                    textureSha256: sha256(textureBytes),
                    sha256: sha256(image.bytes),
                    bytes: image.bytes.length,
                    width: image.width,
                    height: image.height,
                };
                entries[kind].bytesContent = image.bytes;
            }
            if (Object.keys(entries).length === 0) continue;
            pending.set(patchId, {
                configPath: source.resourcePath,
                configArchive: path.relative(gameDirectory, source.archivePath).replaceAll('\\', '/'),
                configSha256: sha256(openVpk(source.archivePath).read(source.resourcePath)),
                patch: patchId,
                entries,
                source: {
                    mapArchive: path.relative(gameDirectory, mainArchive).replaceAll('\\', '/'),
                    clientBuild: currentBuild,
                    currentPatchConfig: configName === 'dota.txt',
                    vpkIndexesScanned: discovered.archivesScanned,
                    resourceToolSha256,
                },
            });
        }

        if (patch !== undefined && !pending.has(patch)) {
            const unavailable = unavailableImages.filter(item => item.patch === patch);
            if (unavailable.length > 0) {
                const materials = unavailable.map(item => `${item.kind}: ${item.material}`).join(', ');
                throw new Error(`Patch ${patch} only references unversioned overview material(s) (${materials}); refusing to label shared/current minimap assets as historical. Supply the exact versioned overview materials.`);
            }
        }

        const outputFiles = [];
        for (const item of pending.values()) {
            for (const entry of Object.values(item.entries)) {
                outputFiles.push(path.join(outputDirectory, ...entry.path.split('/')));
            }
            outputFiles.push(path.join(outputDirectory, 'provenance', 'minimaps', `${item.patch}.json`));
        }
        if (!overwrite) {
            const existing = outputFiles.filter(filename => fs.existsSync(filename));
            if (existing.length) {
                throw new Error(`Refusing to overwrite ${existing.map(filename => path.relative(outputDirectory, filename).replaceAll('\\', '/')).join(', ')}; pass --overwrite explicitly.`);
            }
        }

        for (const item of pending.values()) {
            const images = {};
            for (const [kind, entry] of Object.entries(item.entries)) {
                const bytes = entry.bytesContent;
                delete entry.bytesContent;
                images[kind] = entry;
                writeAtomic(path.join(outputDirectory, ...entry.path.split('/')), bytes);
            }
            const provenancePath = path.join(outputDirectory, 'provenance', 'minimaps', `${item.patch}.json`);
            const previousProvenance = fs.existsSync(provenancePath)
                ? JSON.parse(fs.readFileSync(provenancePath, 'utf8')) : null;
            const rejectedCandidates = collectRejectedCandidates(previousProvenance, images);
            const omittedImages = Object.fromEntries(unavailableImages
                .filter(entry => entry.patch === item.patch)
                .map(entry => [entry.kind, {
                    path: `img/${item.patch}/minimaps/${entry.kind}.png`,
                    configuredMaterial: entry.material,
                    reason: `The overview config references an unversioned material and no exact patch-specific ${entry.kind} material was found.`,
                }]));
            const provenance = {
                schemaVersion: 1,
                patch: item.patch,
                source: {
                    archive: item.configArchive,
                    overviewConfig: item.configPath,
                    overviewConfigSha256: item.configSha256,
                    clientBuild: item.source.clientBuild,
                    vpkIndexesScanned: item.source.vpkIndexesScanned,
                    source2Viewer: 'Source2Viewer-CLI',
                    source2ViewerSha256: item.source.resourceToolSha256,
                },
                images,
                ...(Object.keys(omittedImages).length > 0 ? { omittedImages } : {}),
                ...(Object.keys(rejectedCandidates).length > 0 ? { rejectedCandidates } : {}),
            };
            writeAtomic(provenancePath, Buffer.from(JSON.stringify(provenance, null, 2) + '\n'));
        }
        return {
            archivesScanned: discovered.archivesScanned,
            unavailableImages,
            patches: [...pending.values()].map(item => ({
                patch: item.patch,
                config: item.configPath,
                images: Object.fromEntries(Object.entries(item.entries).map(([kind, entry]) => [kind, {
                    path: entry.path,
                    width: entry.width,
                    height: entry.height,
                    sha256: entry.sha256,
                }])),
            })),
        };
    }
    finally {
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
}

function main(argv = process.argv.slice(2)) {
    const { values, positionals } = parseArgs({ args: argv, options: {
        game: { type: 'string' },
        'resource-tool': { type: 'string' },
        output: { type: 'string' },
        patch: { type: 'string' },
        overwrite: { type: 'boolean' },
    }, allowPositionals: true });
    if (positionals.length > 0) {
        throw new Error('Usage: npm run import:minimaps -- --game <dota-game-dir> --resource-tool <Source2Viewer-CLI> [--patch <id>] [--output <assets-dir>] [--overwrite]');
    }
    const result = importVpkMinimaps({
        gameDirectory: resolveGameDirectory(values.game),
        resourceTool: values['resource-tool'],
        outputDirectory: values.output ? path.resolve(values.output) : path.join(root, 'assets'),
        patch: values.patch,
        overwrite: values.overwrite ?? false,
    });
    for (const patch of result.patches) {
        const imageSummary = Object.entries(patch.images)
            .map(([kind, image]) => `${kind} ${image.width}x${image.height}`).join(', ');
        console.log(`${patch.patch}: ${imageSummary}`);
    }
    for (const item of result.unavailableImages) {
        console.warn(`${item.patch}: omitted ${item.kind} minimap; ${item.material} is not version-specific. Exact historical source material is required.`);
    }
    console.log(`Scanned ${result.archivesScanned} indexed VPK archives.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        main();
    }
    catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
