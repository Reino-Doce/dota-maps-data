// Load export-game-grid.lua as interactive_map_grid_export.lua in the game's
// scripts/vscripts directory, then attach to a local server with -netconport.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanConsole } from './game-scan.mjs';

export async function captureGameGrid({ output, port = 29009 } = {}) {
    if (!output) throw new Error('An output path is required.');
    const grid = await scanConsole({ port: Number(port), script: 'interactive_map_grid_export' });
    fs.writeFileSync(output, JSON.stringify(grid), { flag: 'wx' });
    return grid;
}

async function main(argv = process.argv.slice(2)) {
    const [output, port = '29009'] = argv;
    if (!output || argv.length > 2) throw new Error('Usage: node scripts/capture-game-grid.mjs <terrain_grid.json> [port]');
    const grid = await captureGameGrid({ output, port });
    console.log(`Exported ${grid.width}x${grid.height} heights and ${grid.trees.length} trees. The game remains open.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
