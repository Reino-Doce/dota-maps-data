import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tileLevel = '4';

export function planTileGrid(sourceDirectory) {
    if (!fs.existsSync(sourceDirectory)) {
        throw new Error(`Missing matching version-${tileLevel} tile directory: ${sourceDirectory}`);
    }

    const tiles = new Map();
    for (const entry of fs.readdirSync(sourceDirectory, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const match = /^tile_(\d+)_(\d+)\.jpg$/iu.exec(entry.name);
        if (!match) continue;
        const x = Number(match[1]);
        const y = Number(match[2]);
        const key = `${x},${y}`;
        if (tiles.has(key)) throw new Error(`Duplicate tile coordinates in ${sourceDirectory}: ${key}`);
        tiles.set(key, { x, y, path: path.join(sourceDirectory, entry.name) });
    }

    if (tiles.size === 0) throw new Error(`No tile_*.jpg images found in ${sourceDirectory}`);
    const width = Math.max(...[...tiles.values()].map(tile => tile.x)) + 1;
    const height = Math.max(...[...tiles.values()].map(tile => tile.y)) + 1;
    if (width !== height) throw new Error(`Expected a square Dota tile grid in ${sourceDirectory}; found ${width}x${height}.`);

    const orderedTiles = [];
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const tile = tiles.get(`${x},${y}`);
            if (!tile) throw new Error(`Incomplete tile grid in ${sourceDirectory}; missing tile_${x}_${y}.jpg.`);
            orderedTiles.push(tile);
        }
    }
    if (orderedTiles.length !== tiles.size) {
        throw new Error(`Unexpected tile coordinates outside the ${width}x${height} grid in ${sourceDirectory}.`);
    }
    return { columns: width, rows: height, tiles: orderedTiles };
}

function assertSkin(skin) {
    if (typeof skin !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/iu.test(skin)) {
        throw new Error('A valid terrain skin name is required.');
    }
}

export function discoverAvailableMapImages(tilesRoot) {
    if (!tilesRoot || !fs.existsSync(tilesRoot)) throw new Error(`Missing map tile repository: ${tilesRoot}`);
    const images = [];
    for (const patchEntry of fs.readdirSync(tilesRoot, { withFileTypes: true })) {
        if (!patchEntry.isDirectory() || !/^[a-z0-9]+$/iu.test(patchEntry.name)) continue;
        const patchDirectory = path.join(tilesRoot, patchEntry.name);
        for (const skinEntry of fs.readdirSync(patchDirectory, { withFileTypes: true })) {
            if (!skinEntry.isDirectory() || !/^[a-z0-9][a-z0-9_-]*$/iu.test(skinEntry.name)) continue;
            const sourceDirectory = path.join(patchDirectory, skinEntry.name, tileLevel);
            if (!fs.existsSync(sourceDirectory)) continue;
            planTileGrid(sourceDirectory);
            images.push({ patch: patchEntry.name, skin: skinEntry.name });
        }
    }
    return images.sort((left, right) => left.patch.localeCompare(right.patch, 'en')
        || left.skin.localeCompare(right.skin, 'en'));
}

export async function reconstructMapImage({
    tilesRoot,
    patch,
    skin = 'default',
    outputDirectory = path.join(root, 'assets', 'img'),
    quality = 92,
    overwrite = false,
}) {
    if (typeof patch !== 'string' || !/^[a-z0-9]+$/iu.test(patch)) throw new Error('A valid patch ID is required.');
    assertSkin(skin);
    if (!tilesRoot) throw new Error('Pass the matching tile repository with --tiles-root.');
    if (!Number.isInteger(quality) || quality < 1 || quality > 100) throw new Error('JPEG quality must be an integer from 1 to 100.');

    const sourceDirectory = path.resolve(tilesRoot, patch, skin, tileLevel);
    const grid = planTileGrid(sourceDirectory);
    const firstTile = await sharp(grid.tiles[0].path).metadata();
    if (!firstTile.width || !firstTile.height || firstTile.width !== firstTile.height) {
        throw new Error(`Expected square map tiles in ${sourceDirectory}.`);
    }
    const tileSize = firstTile.width;
    const width = grid.columns * tileSize;
    const height = grid.rows * tileSize;
    const destinationDirectory = path.resolve(outputDirectory, patch);
    const destination = path.join(destinationDirectory, `${skin}.jpg`);
    if (fs.existsSync(destination) && !overwrite) {
        throw new Error(`Refusing to overwrite ${destination}; pass --overwrite after reviewing the existing image.`);
    }

    fs.mkdirSync(destinationDirectory, { recursive: true });
    const temporary = path.join(destinationDirectory,
        `.default-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp.jpg`);
    try {
        const channels = 3;
        const rowBytes = width * tileSize * channels;
        const imageBytes = Buffer.allocUnsafe(width * height * channels);
        const rowBytesBuffer = Buffer.allocUnsafe(rowBytes);
        for (let tileY = 0; tileY < grid.rows; tileY++) {
            for (let tileX = 0; tileX < grid.columns; tileX++) {
                const tile = grid.tiles[tileY * grid.columns + tileX];
                const decoded = await sharp(tile.path).toColourspace('srgb').removeAlpha().raw()
                    .toBuffer({ resolveWithObject: true });
                if (decoded.info.width !== tileSize || decoded.info.height !== tileSize
                    || decoded.info.channels !== channels) {
                    throw new Error(`Tile ${tile.path} is ${decoded.info.width}x${decoded.info.height} with ${decoded.info.channels} channels; expected ${tileSize}x${tileSize} RGB.`);
                }
                for (let row = 0; row < tileSize; row++) {
                    const sourceStart = row * tileSize * channels;
                    const destinationStart = (row * width + tileX * tileSize) * channels;
                    decoded.data.copy(rowBytesBuffer, destinationStart, sourceStart, sourceStart + tileSize * channels);
                }
            }
            rowBytesBuffer.copy(imageBytes, tileY * rowBytes);
        }
        await sharp(imageBytes, {
            raw: { width, height, channels },
            limitInputPixels: false,
        })
            .jpeg({ quality, chromaSubsampling: '4:4:4', mozjpeg: true })
            .toFile(temporary);
        const output = await sharp(temporary, { limitInputPixels: false }).metadata();
        if (output.width !== width || output.height !== height || fs.statSync(temporary).size === 0) {
            throw new Error(`The generated map image failed its dimension check (${output.width}x${output.height}).`);
        }
        if (overwrite && fs.existsSync(destination)) fs.rmSync(destination);
        fs.renameSync(temporary, destination);
        return { patch, sourceDirectory, destination, width, height, tileCount: grid.tiles.length,
            bytes: fs.statSync(destination).size, skin };
    }
    catch (error) {
        if (fs.existsSync(temporary)) fs.rmSync(temporary);
        throw error;
    }
}

export function reconstructDefaultMapImage(options) {
    return reconstructMapImage({ ...options, skin: 'default' });
}

export async function reconstructAllAvailableMapImages({ tilesRoot, outputDirectory, quality = 92, overwrite = false } = {}) {
    const results = [];
    for (const { patch, skin } of discoverAvailableMapImages(tilesRoot)) {
        const destination = path.join(path.resolve(outputDirectory || path.join(root, 'assets', 'img'), patch), `${skin}.jpg`);
        if (fs.existsSync(destination) && !overwrite) {
            results.push({ patch, skin, destination, skipped: true });
            continue;
        }
        results.push(await reconstructMapImage({ tilesRoot, patch, skin, outputDirectory, quality, overwrite }));
    }
    return results;
}

export async function runDefaultImageCommand(argv = process.argv.slice(2)) {
    const { values } = parseArgs({ args: argv, options: {
        'tiles-root': { type: 'string' },
        patch: { type: 'string', multiple: true },
        skin: { type: 'string', multiple: true },
        'all-available': { type: 'boolean', default: false },
        quality: { type: 'string', default: '92' },
        overwrite: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
    } });
    if (values.help) {
        console.log('Usage: npm run images:reconstruct -- --tiles-root <repository> (--patch <patch> [--skin <skin> ...] | --all-available) [--overwrite]');
        return;
    }
    if (!values['tiles-root'] || (values['all-available'] ? values.patch?.length : !values.patch?.length)) {
        throw new Error('Pass --tiles-root and either --all-available or at least one explicit --patch.');
    }
    const quality = Number(values.quality);
    if (values['all-available']) {
        const results = await reconstructAllAvailableMapImages({ tilesRoot: values['tiles-root'], quality, overwrite: values.overwrite });
        for (const result of results) {
            console.log(`${result.patch}/${result.skin}: ${result.skipped ? 'already present; skipped' : `${result.width}x${result.height}, ${result.tileCount} version-${tileLevel} tiles -> ${path.relative(root, result.destination)}`}`);
        }
        return;
    }
    for (const patch of values.patch) {
        for (const skin of values.skin?.length ? values.skin : ['default']) {
            const result = await reconstructMapImage({
                tilesRoot: values['tiles-root'], patch, skin, quality, overwrite: values.overwrite,
            });
            console.log(`${result.patch}/${result.skin}: ${result.width}x${result.height}, ${result.tileCount} version-${tileLevel} tiles -> ${path.relative(root, result.destination)}`);
        }
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    runDefaultImageCommand().catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
