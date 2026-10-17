import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function createOverviewMetadata(patch, sourceBytes, imageBytes,
    sourceResourcePath = 'resource/overviews/dota.txt') {
    if (!patch || !/^[a-z0-9]+$/iu.test(patch)) throw new Error('A valid patch ID is required.');
    if (typeof sourceResourcePath !== 'string'
        || !/^resource\/overviews\/dota(?:_[a-z0-9]+)?\.txt$/iu.test(sourceResourcePath)) {
        throw new Error('A valid versioned Dota overview resource path is required.');
    }
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
        source: { file: sourceResourcePath, sha256: hash(sourceBytes) },
        texture: { width: image.width, height: image.height, rgbaSha256: hash(image.data) },
    };
}

export async function importOverview({ patch, sourceFile, imageFile,
    sourceResourcePath = 'resource/overviews/dota.txt', assetDirectory = path.join(root, 'assets') }) {
    if (!patch || !/^[a-z0-9]+$/iu.test(patch)) throw new Error('A valid patch ID is required.');
    const directory = path.join(assetDirectory, 'data', patch);
    const source = fs.readFileSync(sourceFile || path.join(directory, 'overview.txt'));
    if (!imageFile) throw new Error('Import requires the extracted overview texture as a PNG with --image.');
    const imageBytes = fs.readFileSync(imageFile);
    const metadata = createOverviewMetadata(patch, source, imageBytes, sourceResourcePath);
    const imageDirectory = path.join(assetDirectory, 'img', patch);
    fs.mkdirSync(imageDirectory, { recursive: true });
    const provenanceImage = path.join(imageDirectory, 'overview.png');
    if (path.resolve(imageFile) !== path.resolve(provenanceImage)) fs.writeFileSync(provenanceImage, imageBytes);
    const illustrated = await sharp(imageBytes).flatten({ background: '#ffffff' })
        .jpeg({ quality: 92, chromaSubsampling: '4:4:4', mozjpeg: true }).toBuffer();
    fs.writeFileSync(path.join(imageDirectory, 'illustrated.jpg'), illustrated);
    fs.writeFileSync(path.join(directory, 'overview.txt'), source);
    fs.writeFileSync(path.join(directory, 'overview.json'), `${JSON.stringify(metadata, null, 2)}\n`);
    return metadata;
}

async function main(argv = process.argv.slice(2)) {
    const [patch, sourceFile, imageFile, sourceResourcePath] = argv;
    if (!patch || !imageFile || argv.length > 4) {
        throw new Error('Usage: npm run import:overview -- <patch> <overview.txt> <overview-texture.png> [source-resource-path]');
    }
    const metadata = await importOverview({ patch, sourceFile, imageFile, sourceResourcePath });
    console.log(`Imported overview origin ${metadata.posX},${metadata.posY}; scale ${metadata.scale}; `
        + `texture ${metadata.texture.width}x${metadata.texture.height}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
