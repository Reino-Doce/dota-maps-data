// Prepare and assemble 16K game-map screenshots captured with Source Filmmaker.
// Importing this module is inert; only the explicit CLI commands write files.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { PNG } from 'pngjs';
import sharp from 'sharp';
import { openVpk, resolveGameDirectory } from '../src/node/game-files.mjs';
import { createSfmSweepSession } from './sfm-session.mjs';
import { assertUsableImage } from './terrain-image.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const columns = 5;
const rows = 9;
const frameWidth = 3840;
const frameHeight = 2160;
const overlap = 1.1;
const outputSize = 16_384;
const mapResourcePattern = /^maps\/(dota(?:_[a-z0-9_]+)?)\.vmap_c$/iu;

function sha256File(filename) {
    const hash = createHash('sha256');
    const descriptor = fs.openSync(filename, 'r');
    try {
        const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
        let count;
        while ((count = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
            hash.update(buffer.subarray(0, count));
        }
    }
    finally {
        fs.closeSync(descriptor);
    }
    return hash.digest('hex');
}

function currentPatch() {
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const patch = packageJson.dotaMapsData?.currentPatch;
    if (typeof patch !== 'string' || !/^[a-z0-9]+$/iu.test(patch)) {
        throw new Error('Set dotaMapsData.currentPatch in package.json before preparing the current map capture.');
    }
    return patch;
}

function archiveFile(game, patch) {
    const name = patch === currentPatch() ? 'dota.vpk' : `dota_${patch}.vpk`;
    const filename = path.join(game, 'dota', 'maps', name);
    if (!fs.existsSync(filename)) {
        throw new Error(`No ${name} was found in ${path.join(game, 'dota', 'maps')}. Pass a prepared archive with --archive.`);
    }
    return filename;
}

function mapInArchive(filename) {
    const archive = openVpk(filename);
    const maps = archive.files.map(resource => ({ resource, match: mapResourcePattern.exec(resource) }))
        .filter(value => value.match);
    if (maps.length !== 1) {
        throw new Error(`${path.basename(filename)} must contain exactly one Dota terrain map resource; found ${maps.length}.`);
    }
    return { archive, resource: maps[0].resource, map: maps[0].match[1] };
}

function addonMapArchive(game, map = 'dota') {
    return path.join(game, 'dota_addons', 'dota-map-coordinates', 'maps', `${map}.vpk`);
}

function overlayStatePath(repositoryRoot) {
    const directory = path.join(repositoryRoot, 'map-captures', 'default-image-sweep');
    return path.join(directory, 'addon-map-vpk-overlay.json');
}

function overlayBackupPath(repositoryRoot) {
    return path.join(path.dirname(overlayStatePath(repositoryRoot)), 'addon-map.vpk.original');
}

function writeOverlayState(filename, state) {
    fs.writeFileSync(filename, `${JSON.stringify(state, null, 2)}\n`);
}

function relativePath(filename, baseDirectory) {
    return path.relative(baseDirectory, filename).split(path.sep).join('/');
}

function writeStageReceipt(repositoryRoot, patch, kind, receipt) {
    const directory = path.join(repositoryRoot, 'map-captures', 'default-image-sweep', patch, 'stage-receipts');
    fs.mkdirSync(directory, { recursive: true });
    const timestamp = receipt.timestamp.replaceAll(':', '-');
    const filename = path.join(directory, `${kind}-${timestamp}-${randomUUID()}.json`);
    const temporaryFile = `${filename}.${randomUUID()}.tmp`;
    try {
        fs.writeFileSync(temporaryFile, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
        fs.renameSync(temporaryFile, filename);
    }
    finally {
        if (fs.existsSync(temporaryFile)) fs.unlinkSync(temporaryFile);
    }
    return filename;
}

function replaceFileAtomically(source, destination) {
    const temporaryFile = `${destination}.${randomUUID()}.tmp`;
    const displacedFile = `${destination}.${randomUUID()}.previous`;
    fs.copyFileSync(source, temporaryFile);
    let displaced = false;
    try {
        if (fs.existsSync(destination)) {
            fs.renameSync(destination, displacedFile);
            displaced = true;
        }
        fs.renameSync(temporaryFile, destination);
        if (displaced) fs.unlinkSync(displacedFile);
    }
    catch (error) {
        if (displaced && fs.existsSync(displacedFile) && !fs.existsSync(destination)) {
            fs.renameSync(displacedFile, destination);
        }
        throw error;
    }
    finally {
        if (fs.existsSync(temporaryFile)) fs.unlinkSync(temporaryFile);
    }
}

export function stageDefaultImageSource({ patch, gameDirectory, archivePath, addonArchivePath,
    repositoryRoot = root }) {
    if (typeof patch !== 'string' || !/^[a-z0-9]+$/iu.test(patch)) throw new Error('Pass a valid --patch ID.');
    const game = resolveGameDirectory(gameDirectory);
    const sourceArchive = archivePath ? path.resolve(archivePath) : archiveFile(game, patch);
    if (!fs.existsSync(sourceArchive)) throw new Error(`Map archive not found: ${sourceArchive}`);
    const { archive, resource, map } = mapInArchive(sourceArchive);
    const sourceSha256 = sha256File(sourceArchive);
    const capturePath = path.join(repositoryRoot, 'map-captures', 'default-image-sweep', patch, 'capture.json');
    const sessionPath = path.join(repositoryRoot, 'map-captures', 'default-image-sweep', patch, 'session.dmx');
    if (!fs.existsSync(capturePath)) throw new Error(`Missing ${capturePath}; prepare the capture first.`);
    const manifest = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
    const captureManifestSha256 = sha256File(capturePath);
    const sessionSha256 = fs.existsSync(sessionPath) ? sha256File(sessionPath) : null;
    const sessionMap = map;
    if (manifest.patch !== patch || manifest.source?.archiveSha256 !== sourceSha256
        || manifest.source?.mapResource !== resource || manifest.map !== map || manifest.sessionMap !== sessionMap) {
        throw new Error(`${path.basename(sourceArchive)} does not match the prepared ${patch} capture manifest. Regenerate it with prepare --patch ${patch} --overwrite.`);
    }
    if (!fs.existsSync(sessionPath)
        || !fs.readFileSync(sessionPath, 'utf8').includes(`"mapname" "string" "maps/${sessionMap}.vmap"`)) {
        throw new Error(`The ${patch} SFM session does not select maps/${sessionMap}.vmap. Regenerate it with prepare --patch ${patch} --overwrite.`);
    }

    const destination = path.resolve(addonArchivePath || addonMapArchive(game, map));
    const expectedName = `${map}.vpk`;
    if (path.basename(destination).toLowerCase() !== expectedName.toLowerCase()) {
        throw new Error(`The staged Workshop Tools map VPK must be named ${expectedName} so its internal ${resource} path resolves correctly.`);
    }
    const statePath = overlayStatePath(repositoryRoot);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const backupPath = overlayBackupPath(repositoryRoot);
    let previousState = null;
    if (fs.existsSync(statePath)) {
        previousState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        if (previousState.kind !== 'map-vpk-overlay' || path.resolve(previousState.addonArchivePath || '') !== destination) {
            throw new Error(`A different Workshop Tools map overlay is already recorded in ${statePath}.`);
        }
        if (previousState.status !== 'staged') {
            throw new Error('A map VPK overlay is only partly staged; run the restore command before staging another patch.');
        }
        if (!fs.existsSync(destination) || sha256File(destination) !== previousState.sourceSha256) {
            throw new Error(`Staged map VPK changed; refusing to replace it: ${destination}`);
        }
        if (previousState.originalExists
            && (!fs.existsSync(previousState.backupPath) || sha256File(previousState.backupPath) !== previousState.originalSha256)) {
            throw new Error(`The original add-on map VPK backup is missing or changed: ${previousState.backupPath}`);
        }
    }
    else if (fs.existsSync(backupPath)) {
        throw new Error(`An orphaned add-on map VPK backup exists at ${backupPath}; inspect it before staging.`);
    }

    const originalExists = previousState?.originalExists ?? fs.existsSync(destination);
    const originalSha256 = previousState?.originalSha256 ?? (originalExists ? sha256File(destination) : null);
    if (!previousState && originalExists) {
        fs.copyFileSync(destination, backupPath);
        if (sha256File(backupPath) !== originalSha256) {
            fs.unlinkSync(backupPath);
            throw new Error(`Could not verify the add-on map VPK backup: ${backupPath}`);
        }
    }
    const state = {
        schemaVersion: 1,
        kind: 'map-vpk-overlay',
        status: 'staging',
        addonArchivePath: destination,
        backupPath: originalExists ? (previousState?.backupPath || backupPath) : null,
        originalExists,
        originalSha256,
        previousStagedSha256: previousState?.sourceSha256 || null,
        patch,
        sourceArchive,
        sourceSha256,
        mapResource: resource,
        map,
        sessionMap,
    };
    writeOverlayState(statePath, state);
    replaceFileAtomically(sourceArchive, destination);
    const stagedSha256 = sha256File(destination);
    if (stagedSha256 !== sourceSha256) throw new Error(`Staged map VPK checksum did not match ${sourceArchive}.`);
    state.status = 'staged';
    writeOverlayState(statePath, state);
    const stagedAt = new Date().toISOString();
    const receiptPath = writeStageReceipt(repositoryRoot, patch, 'stage', {
        schemaVersion: 1,
        kind: 'map-image-vpk-stage',
        patch,
        map,
        timestamp: stagedAt,
        source: {
            archive: relativePath(sourceArchive, game),
            sha256: sourceSha256,
            mapResource: resource,
        },
        capture: {
            manifest: relativePath(capturePath, repositoryRoot),
            manifestSha256: captureManifestSha256,
        },
        session: {
            path: relativePath(sessionPath, repositoryRoot),
            sha256: sessionSha256,
            mapResource: `maps/${sessionMap}.vmap`,
        },
        destination: {
            archive: relativePath(destination, game),
            sha256: stagedSha256,
        },
        original: {
            exists: originalExists,
            sha256: originalSha256,
        },
    });
    return { patch, map, sessionMap, sessionPath, mapResource: resource, stagedArchive: destination,
        destination, sourceSha256, stagedSha256, originalSha256, fileCount: archive.files.length, statePath, receiptPath };
}

export function restoreDefaultImageSource({ gameDirectory, addonArchivePath, repositoryRoot = root }) {
    const game = resolveGameDirectory(gameDirectory);
    const statePath = overlayStatePath(repositoryRoot);
    if (!fs.existsSync(statePath)) throw new Error(`No staged Workshop Tools map VPK was recorded in ${statePath}.`);
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (state.kind !== 'map-vpk-overlay') {
        throw new Error(`The recorded overlay at ${statePath} is not a map VPK overlay; restore that overlay with its original tool.`);
    }
    const destination = path.resolve(addonArchivePath || state.addonArchivePath || addonMapArchive(game, state.map));
    if (destination !== path.resolve(state.addonArchivePath || '')) throw new Error(`Stage metadata does not match ${destination}.`);
    const currentHash = fs.existsSync(destination) ? sha256File(destination) : null;
    const permittedHashes = [state.sourceSha256, state.previousStagedSha256, state.originalSha256].filter(Boolean);
    if (currentHash && !permittedHashes.includes(currentHash)) {
        throw new Error(`Staged map VPK changed; refusing to restore over it: ${destination}`);
    }
    let restoredSha256 = null;
    if (state.originalExists) {
        if (!fs.existsSync(state.backupPath) || sha256File(state.backupPath) !== state.originalSha256) {
            throw new Error(`The original add-on map VPK backup is missing or changed: ${state.backupPath}`);
        }
        replaceFileAtomically(state.backupPath, destination);
        restoredSha256 = sha256File(destination);
        if (restoredSha256 !== state.originalSha256) throw new Error(`Restored add-on map VPK checksum did not match its original: ${destination}`);
    }
    else if (fs.existsSync(destination)) fs.unlinkSync(destination);
    const timestamp = new Date().toISOString();
    const receiptPath = writeStageReceipt(repositoryRoot, state.patch, 'restore', {
        schemaVersion: 1,
        kind: 'map-image-vpk-restore',
        patch: state.patch,
        map: state.map,
        timestamp,
        source: {
            archive: relativePath(state.sourceArchive, game),
            sha256: state.sourceSha256,
            mapResource: state.mapResource,
        },
        destination: {
            archive: relativePath(destination, game),
            stagedSha256: state.sourceSha256,
            restoredSha256,
        },
        original: {
            exists: state.originalExists,
            sha256: state.originalSha256,
        },
    });
    if (state.backupPath && fs.existsSync(state.backupPath)) fs.unlinkSync(state.backupPath);
    fs.unlinkSync(statePath);
    return { destination: path.dirname(destination), restoredArchive: destination, statePath, receiptPath, restoredSha256 };
}

function dataExtent(patch, repositoryRoot = root) {
    const filename = path.join(repositoryRoot, 'assets', 'data', patch, 'worlddata.json');
    if (!fs.existsSync(filename)) throw new Error(`Missing ${filename}; generate the version's map data first.`);
    const world = JSON.parse(fs.readFileSync(filename, 'utf8'));
    const bounds = [world.worldMinX, world.worldMinY, world.worldMaxX, world.worldMaxY];
    if (!bounds.every(Number.isFinite) || bounds[0] >= bounds[2] || bounds[1] >= bounds[3]) {
        throw new Error(`Invalid worlddata bounds in ${filename}.`);
    }
    const centerX = (bounds[0] + bounds[2]) / 2;
    const centerY = (bounds[1] + bounds[3]) / 2;
    const span = Math.max(bounds[2] - bounds[0], bounds[3] - bounds[1]);
    return [centerX - span / 2, centerY - span / 2, centerX + span / 2, centerY + span / 2];
}

function availablePatches(game) {
    const directory = path.join(game, 'dota', 'maps');
    const patches = new Set();
    for (const name of fs.readdirSync(directory)) {
        const match = /^dota_(\d+)\.vpk$/iu.exec(name);
        if (match) patches.add(match[1]);
    }
    if (fs.existsSync(path.join(directory, 'dota.vpk'))) patches.add(currentPatch());
    return [...patches].filter(patch => fs.existsSync(path.join(root, 'assets', 'data', patch, 'worlddata.json')))
        .sort((a, b) => Number(a) - Number(b));
}

export function prepareDefaultImageCapture({ patch, gameDirectory, archivePath, overwrite = false, repositoryRoot = root }) {
    if (typeof patch !== 'string' || !/^[a-z0-9]+$/iu.test(patch)) throw new Error('Pass a valid --patch ID.');
    const game = resolveGameDirectory(gameDirectory);
    const sourceArchive = archivePath ? path.resolve(archivePath) : archiveFile(game, patch);
    if (!fs.existsSync(sourceArchive)) throw new Error(`Map archive not found: ${sourceArchive}`);
    const { archive, resource, map } = mapInArchive(sourceArchive);
    const captureDirectory = path.join(repositoryRoot, 'map-captures', 'default-image-sweep', patch);
    const sessionPath = path.join(captureDirectory, 'session.dmx');
    const manifestPath = path.join(captureDirectory, 'capture.json');
    const finalImage = path.join(repositoryRoot, 'assets', 'img', patch, 'default.jpg');
    if (!overwrite && [sessionPath, manifestPath, finalImage].some(filename => fs.existsSync(filename))) {
        throw new Error(`Capture or ${finalImage} already exists; pass --overwrite to replace prepared inputs.`);
    }
    const worldExtent = dataExtent(patch, repositoryRoot);
    const archiveSha256 = sha256File(sourceArchive);
    const provenancePath = path.join(repositoryRoot, 'assets', 'data', patch, 'source.json');
    if (fs.existsSync(provenancePath)) {
        const provenance = JSON.parse(fs.readFileSync(provenancePath, 'utf8'));
        if (provenance.archiveSha256 && provenance.archiveSha256 !== archiveSha256) {
            throw new Error(`Installed ${path.basename(sourceArchive)} does not match ${patch}/source.json. Use the exact source archive for this patch.`);
        }
        if (provenance.resources?.map?.path && provenance.resources.map.path !== resource) {
            throw new Error(`The map resource in ${path.basename(sourceArchive)} differs from ${patch}/source.json.`);
        }
    }
    const sessionMap = map;
    const outputPrefix = path.join(captureDirectory,
        `sweep-tile-${patch}-${sessionMap}-${archiveSha256.slice(0, 12)}-`);
    const generated = createSfmSweepSession({ map: sessionMap, worldExtent, width: frameWidth, height: frameHeight,
        columns, rows, overlap, outputPrefix });
    fs.mkdirSync(captureDirectory, { recursive: true });
    fs.writeFileSync(sessionPath, generated.text);
    const manifest = {
        schemaVersion: 1,
        patch,
        map,
        sessionMap,
        source: { archive: path.basename(sourceArchive), archiveSha256, mapResource: resource },
        method: 'Source Filmmaker 5 by 9 camera sweep based on devilesk map-image method',
        worldExtent: generated.nominalWorldExtent,
        frame: { width: frameWidth, height: frameHeight, frameRate: 1 },
        tiles: {
            columns, rows, overlap, count: columns * rows, prefix: outputPrefix,
            frames: generated.tiles.map(({ index, row, column }) => ({ index, row, column })),
        },
        output: { path: finalImage, width: outputSize, height: outputSize, format: 'jpeg' },
    };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return { patch, map, sessionMap, sessionPath, manifestPath, outputPrefix, tileCount: columns * rows,
        archiveSha256, worldExtent: generated.nominalWorldExtent };
}

function validateFrame(filename, width, height, { allowBlackMapCorner = false } = {}) {
    if (!fs.existsSync(filename)) throw new Error(`Missing rendered tile ${filename}; export the complete SFM image sequence before stitching.`);
    const image = PNG.sync.read(fs.readFileSync(filename));
    if (image.width !== width || image.height !== height) {
        throw new Error(`${path.basename(filename)} is ${image.width}x${image.height}; expected ${width}x${height}.`);
    }
    try {
        assertUsableImage(image);
    }
    catch (error) {
        if (allowBlackMapCorner && error.message === 'Game renderer produced an empty image.'
            && image.data.every((value, index) => index % 4 === 3 ? value === 255 : value <= 8)) return;
        throw new Error(`${path.basename(filename)} is not a usable game render: ${error.message}`, { cause: error });
    }
}

export async function stitchDefaultImage({ patch, repositoryRoot = root, overwrite = false, size = outputSize }) {
    if (typeof patch !== 'string' || !/^[a-z0-9]+$/iu.test(patch)) throw new Error('Pass a valid --patch ID.');
    if (!Number.isInteger(size) || size < 256 || size > outputSize) throw new Error('Output size must be between 256 and 16384 pixels.');
    const captureDirectory = path.join(repositoryRoot, 'map-captures', 'default-image-sweep', patch);
    const manifestPath = path.join(captureDirectory, 'capture.json');
    if (!fs.existsSync(manifestPath)) throw new Error(`Missing ${manifestPath}; prepare the SFM sweep first.`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const { columns: tileColumns, rows: tileRows, overlap: tileOverlap, prefix } = manifest.tiles || {};
    const { width, height } = manifest.frame || {};
    if (manifest.patch !== patch || !Number.isInteger(tileColumns) || !Number.isInteger(tileRows)
        || !Number.isFinite(tileOverlap) || tileOverlap < 1 || !Number.isInteger(width) || !Number.isInteger(height)) {
        throw new Error(`Invalid sweep metadata in ${manifestPath}.`);
    }
    const frameLocations = new Map();
    const frameByCell = new Map();
    const frameCells = new Set();
    for (const frame of manifest.tiles.frames || []) {
        if (!Number.isInteger(frame.index) || frame.index < 0 || frame.index >= tileColumns * tileRows
            || !Number.isInteger(frame.row) || frame.row < 0 || frame.row >= tileRows
            || !Number.isInteger(frame.column) || frame.column < 0 || frame.column >= tileColumns
            || frameLocations.has(frame.index) || frameCells.has(`${frame.row}:${frame.column}`)) {
            throw new Error(`Invalid camera frame mapping in ${manifestPath}.`);
        }
        frameLocations.set(frame.index, frame);
        frameCells.add(`${frame.row}:${frame.column}`);
        frameByCell.set(`${frame.row}:${frame.column}`, frame);
    }
    if (frameLocations.size && frameLocations.size !== tileColumns * tileRows) {
        throw new Error(`Camera frame mapping is incomplete in ${manifestPath}.`);
    }
    const worldExtent = manifest.worldExtent;
    if (!Array.isArray(worldExtent) || worldExtent.length !== 4 || !worldExtent.every(Number.isFinite)) {
        throw new Error(`Missing camera bounds in ${manifestPath}.`);
    }
    const [minX, minY, maxX, maxY] = worldExtent;
    const spanX = maxX - minX;
    const spanY = maxY - minY;
    const viewHeight = spanY / tileRows * tileOverlap;
    const viewWidth = viewHeight * width / height;
    const outputPath = path.join(repositoryRoot, 'assets', 'img', patch, 'default.jpg');
    if (fs.existsSync(outputPath) && !overwrite) throw new Error(`${outputPath} already exists; pass --overwrite to replace it.`);

    const composites = [];
    for (let row = 0; row < tileRows; row += 1) {
        for (let column = 0; column < tileColumns; column += 1) {
            const index = row * tileColumns + column;
            const frame = frameLocations.size ? frameByCell.get(`${row}:${column}`) : { index, row, column };
            if (!frame) throw new Error(`No camera frame maps to tile row ${row}, column ${column}.`);
            const filename = `${prefix}${String(frame.index).padStart(6, '0')}.png`;
            const mapCornerVoid = tileColumns > 1 && tileRows > 1
                && ((row === 0 && column === tileColumns - 1) || (row === tileRows - 1 && column === 0));
            validateFrame(filename, width, height, { allowBlackMapCorner: mapCornerVoid });
            const centerX = minX + (column + 0.5) * spanX / tileColumns;
            const centerY = maxY - (row + 0.5) * spanY / tileRows;
            const cameraMinX = centerX - viewWidth / 2;
            const cameraMaxY = centerY + viewHeight / 2;
            const desiredMinX = minX + column * spanX / tileColumns;
            const desiredMaxX = minX + (column + 1) * spanX / tileColumns;
            const desiredMaxY = maxY - row * spanY / tileRows;
            const desiredMinY = maxY - (row + 1) * spanY / tileRows;
            const left = Math.round((desiredMinX - cameraMinX) / viewWidth * width);
            const top = Math.round((cameraMaxY - desiredMaxY) / viewHeight * height);
            const right = Math.round((desiredMaxX - cameraMinX) / viewWidth * width);
            const bottom = Math.round((cameraMaxY - desiredMinY) / viewHeight * height);
            const outputLeft = Math.round(column * size / tileColumns);
            const outputTop = Math.round(row * size / tileRows);
            const outputRight = Math.round((column + 1) * size / tileColumns);
            const outputBottom = Math.round((row + 1) * size / tileRows);
            composites.push({ input: filename, left: outputLeft, top: outputTop,
                width: outputRight - outputLeft, height: outputBottom - outputTop,
                extract: { left, top, width: right - left, height: bottom - top } });
        }
    }
    for (const item of composites) {
        if (item.extract.left < 0 || item.extract.top < 0 || item.extract.width < 1 || item.extract.height < 1
            || item.extract.left + item.extract.width > width || item.extract.top + item.extract.height > height) {
            throw new Error(`Tile crop exceeds its rendered frame (${item.input}). Check the camera overlap and world bounds.`);
        }
    }

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const temporary = `${outputPath}.${process.pid}.tmp.jpg`;
    try {
        const layers = await Promise.all(composites.map(async item => ({
            input: await sharp(item.input).extract(item.extract).resize(item.width, item.height,
                { fit: 'fill', kernel: 'lanczos3' }).png().toBuffer(),
            left: item.left,
            top: item.top,
        })));
        await sharp({ create: { width: size, height: size, channels: 3, background: { r: 0, g: 0, b: 0 } },
            limitInputPixels: false })
            .composite(layers)
            .jpeg({ quality: 82, chromaSubsampling: '4:2:0', mozjpeg: true })
            .toFile(temporary);
        const metadata = await sharp(temporary, { limitInputPixels: false }).metadata();
        if (metadata.format !== 'jpeg' || metadata.width !== size || metadata.height !== size) {
            throw new Error(`Stitched output verification failed: ${metadata.format} ${metadata.width}x${metadata.height}.`);
        }
        if (fs.existsSync(outputPath) && !overwrite) throw new Error(`${outputPath} appeared while stitching; refusing to overwrite it.`);
        fs.renameSync(temporary, outputPath);
    }
    finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
    return { patch, outputPath, size, tileCount: composites.length, archiveSha256: manifest.source.archiveSha256 };
}

async function main(argv = process.argv.slice(2)) {
    const command = argv[0] || 'prepare';
    if (!['prepare', 'stage', 'stitch', 'restore'].includes(command)) {
        throw new Error('Usage: node scripts/generate-default-images.mjs <prepare|stage|stitch|restore> --patch <id>|--all [--game <path>] [--archive <file>] [--addon-archive <file>] [--overwrite]');
    }
    const { values } = parseArgs({ args: argv.slice(1), options: {
        patch: { type: 'string' }, all: { type: 'boolean' }, game: { type: 'string' }, archive: { type: 'string' },
        'addon-archive': { type: 'string' },
        overwrite: { type: 'boolean' },
    } });
    if (values.all && (values.archive || values['addon-archive'])) {
        throw new Error('--archive and --addon-archive can only be used with one --patch.');
    }
    if (command === 'restore') {
        const result = restoreDefaultImageSource({ gameDirectory: values.game, addonArchivePath: values['addon-archive'] });
        console.log(`Restored the original add-on map archive at ${result.restoredArchive}.`);
        return;
    }
    const patches = values.all ? availablePatches(resolveGameDirectory(values.game)) : [values.patch || currentPatch()];
    if (patches.length === 0) throw new Error('No installed map archives have matching versioned worlddata.');
    for (const patch of patches) {
        if (command === 'prepare') {
            const result = prepareDefaultImageCapture({ patch, gameDirectory: values.game,
                archivePath: values.archive, overwrite: values.overwrite });
            console.log(`${result.patch} ${result.map}: ${result.tileCount} tiles; open ${result.sessionPath} in Source Filmmaker and export the image sequence.`);
        }
        else if (command === 'stage') {
        const result = stageDefaultImageSource({ patch, gameDirectory: values.game, archivePath: values.archive,
                addonArchivePath: values['addon-archive'] });
            console.log(`${result.patch} ${result.map}: staged the complete ${result.fileCount}-resource map VPK at ${result.stagedArchive}; open ${result.sessionPath} in Source Filmmaker.`);
        }
        else {
            const result = await stitchDefaultImage({ patch, overwrite: values.overwrite });
            console.log(`${result.patch}: ${result.tileCount} tiles stitched into ${result.size}x${result.size} ${result.outputPath}.`);
        }
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
