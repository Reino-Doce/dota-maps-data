import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import resolve from '@rollup/plugin-node-resolve';
import { rollup } from 'rollup';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const input = path.join(root, 'src/vision.mjs');

const visionFixes = {
    name: 'dota-vision-simulation-fixes',
    transform(code, id) {
        const resource = id.split('?')[0].replaceAll('\\', '/');
        if (resource.endsWith('/rot6.js')) {
            const declarations = /var cx, cy, blocks, A1, A2, visibility,\s*dx, dy, dd, a, b, radius,\s*cx2, cy2, dd1,\s*obstacleType;/;
            if (!declarations.test(code)) throw new Error('The expected Dota vision shadowcasting source was not found.');
            return { code: code.replace(declarations,
                'var cx, cy, blocks, A1, A2, visibility,\n        dx, dy, dd, a, b, radius,\n        cx2, cy2, dx1, dy1, dd1,\n        obstacleType;'), map: null };
        }
        if (resource.endsWith('/browser/imageHandler.js')) {
            if (!code.includes('Math.floor((i/4) / height)')) {
                throw new Error('The expected vision raster row calculation was not found.');
            }
            return { code: code.replace('Math.floor((i/4) / height)', 'Math.floor((i/4) / width)'), map: null };
        }
        return null;
    },
};

async function buildVision({ browser, file }) {
    const bundle = await rollup({ input, external: browser ? [] : ['jimp'],
        plugins: [resolve({ browser }), visionFixes, json(), commonjs()] });
    try {
        const filename = path.join(root, 'dist', file);
        await bundle.write({ file: filename, format: 'es', exports: 'named' });
        fs.writeFileSync(filename, fs.readFileSync(filename, 'utf8').replace(/[ \t]+$/gmu, ''));
    }
    finally {
        await bundle.close();
    }
}

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
await buildVision({ browser: false, file: 'vision.node.mjs' });
await buildVision({ browser: true, file: 'vision.browser.mjs' });
await import('./build-manifest.mjs');
