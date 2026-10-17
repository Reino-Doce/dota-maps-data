import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { calibrateScreenshot } from './screenshot-calibration.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function createScreenshotMetadata(patch, bytes, controls) {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== controls.source.sha256) throw new Error('Screenshot changed; measure new calibration controls before importing.');
    let size;
    if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8) throw new Error('Expected the original JPEG screenshot.');
    for (let offset = 2; offset + 9 < bytes.length;) {
        if (bytes[offset] !== 0xff || bytes[offset + 1] === 0xda) break;
        const marker = bytes[offset + 1];
        const length = bytes.readUInt16BE(offset + 2);
        if ([0xc0, 0xc1, 0xc2].includes(marker)) {
            size = [bytes.readUInt16BE(offset + 7), bytes.readUInt16BE(offset + 5)];
            break;
        }
        if (length < 2) break;
        offset += length + 2;
    }
    if (!size || size[0] !== controls.width || size[1] !== controls.height) {
        throw new Error('Screenshot dimensions differ from the measured calibration source.');
    }
    return {
        image: `img/${patch}/screenshot.jpg`, width: controls.width, height: controls.height,
        source: { ...controls.source, sha256 },
        ...calibrateScreenshot(controls),
    };
}

export function importScreenshot({ patch, input, assetDirectory = path.join(root, 'assets') }) {
    if (!patch || !/^[a-z0-9]+$/iu.test(patch)) throw new Error('A valid patch ID is required.');
    const directory = path.join(assetDirectory, 'data', patch);
    const controls = JSON.parse(fs.readFileSync(path.join(directory, 'screenshot-controls.json'), 'utf8'));
    const image = `img/${patch}/screenshot.jpg`;
    const destination = path.join(assetDirectory, image);
    const bytes = fs.readFileSync(input || destination);
    const metadata = createScreenshotMetadata(patch, bytes, controls);
    fs.writeFileSync(destination, bytes);
    fs.writeFileSync(path.join(directory, 'screenshot.json'), `${JSON.stringify(metadata, null, 2)}\n`);
    return metadata;
}

async function main(argv = process.argv.slice(2)) {
    const [patch, input] = argv;
    if (!patch || argv.length > 2) throw new Error('Usage: npm run import:screenshot -- <patch> [game screenshot.jpg]');
    const metadata = importScreenshot({ patch, input });
    console.log(`Imported ${metadata.width}x${metadata.height} game screenshot; maximum control error `
        + `${Math.max(...metadata.errors.map(error => error.worldUnits)).toFixed(2)} world units.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
