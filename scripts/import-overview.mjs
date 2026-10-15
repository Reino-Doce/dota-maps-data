import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function createOverviewMetadata(patch, sourceBytes, imageBytes) {
    const text = sourceBytes.toString('utf8');
    const value = key => {
        const match = text.match(new RegExp('^\\s*"?' + key + '"?\\s+"?([^"\\s]+)', 'm'));
        if (!match) throw new Error(`Overview is missing ${key}.`);
        return match[1];
    };
    const posX = Number(value('pos_x'));
    const posY = Number(value('pos_y'));
    const scale = Number(value('scale'));
    if (![posX, posY, scale].every(Number.isFinite) || scale <= 0 || /\brotate\s+"?[1-9]/.test(text)) {
        throw new Error('Unsupported overview coordinates.');
    }
    const image = PNG.sync.read(imageBytes);
    if (image.width !== image.height) throw new Error('Expected a square game overview.');
    const hash = bytes => createHash('sha256').update(bytes).digest('hex');
    return {
        posX, posY, scale,
        material: value('material'),
        source: { file: 'resource/overviews/dota.txt', sha256: hash(sourceBytes) },
        texture: { width: image.width, height: image.height, rgbaSha256: hash(image.data) },
    };
}

export function importOverview({ patch, sourceFile, assetDirectory = path.join(root, 'assets') }) {
    if (!patch || !/^[a-z0-9]+$/iu.test(patch)) throw new Error('A valid patch ID is required.');
    const directory = path.join(assetDirectory, 'data', patch);
    const source = fs.readFileSync(sourceFile || path.join(directory, 'overview.txt'));
    const imageBytes = fs.readFileSync(path.join(assetDirectory, 'img', `dota-map-${patch}.png`));
    const metadata = createOverviewMetadata(patch, source, imageBytes);
    fs.writeFileSync(path.join(directory, 'overview.txt'), source);
    fs.writeFileSync(path.join(directory, 'overview.json'), `${JSON.stringify(metadata, null, 2)}\n`);
    return metadata;
}

async function main(argv = process.argv.slice(2)) {
    const [patch, sourceFile] = argv;
    if (!patch || argv.length > 2) throw new Error('Usage: npm run import:overview -- <patch> [overview.txt]');
    const metadata = importOverview({ patch, sourceFile });
    console.log(`Imported overview origin ${metadata.posX},${metadata.posY}; scale ${metadata.scale}; `
        + `texture ${metadata.texture.width}x${metadata.texture.height}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
