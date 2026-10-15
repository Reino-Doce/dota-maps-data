import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { resolveGameDirectory, openVpk } from '../src/node/game-files.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = data => createHash('sha256').update(data).digest('hex');

export function mapTreeIds(rows, trees) {
    const byPosition = new Map(trees.map((tree, i) => [`${tree.x},${tree.y},${tree.z}`, i]));
    const indices = [];
    for (const [id, x, y, z] of rows) {
        const index = byPosition.get(`${x},${y},${z}`);
        if (!Number.isInteger(id) || id < 0 || id >= trees.length || index === undefined || indices[id] !== undefined)
            throw new Error('Tree IDs do not match this map.');
        indices[id] = index;
    }
    if (rows.length !== trees.length || new Set(indices).size !== trees.length) throw new Error('Incomplete tree index.');
    return indices;
}

async function capture(port, script, child) {
    const deadline = Date.now() + 90000;
    let socket;
    while (Date.now() < deadline) {
        if (child.scanFailed || child.exitCode !== null) throw new Error('The local scan server could not start or stopped.');
        socket = await new Promise(resolve => {
            const candidate = net.createConnection({ host: '127.0.0.1', port });
            candidate.once('connect', () => resolve(candidate));
            candidate.once('error', () => {
                candidate.destroy(); resolve(null);
            });
        });
        if (socket) break;
        await delay(500);
    }
    if (!socket) throw new Error('Local scan server timed out.');
    return new Promise((resolve, reject) => {
        let buffer = '';
        let rows = null;
        const finish = (error, result) => {
            clearInterval(poll);
            clearTimeout(timer);
            socket.destroy();
            if (error) reject(error);
            else resolve(result);
        };
        const timer = setTimeout(() => finish(new Error('Tree export timed out.')), 60000);
        const poll = setInterval(() => {
            if (!rows) socket.write(`sv_cheats 1\nsv_hibernate_when_empty 0\nscript_reload_code ${script}\n`);
        }, 1000);
        socket.on('error', () => finish(new Error('Local scan connection failed.')));
        socket.on('data', bytes => {
            buffer += bytes.toString();
            if (buffer.length > 1000000) return finish(new Error('Tree export exceeded limit.'));
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines) {
                if (line.includes('[LIVE_TREES_BEGIN]')) rows = [];
                const start = line.indexOf('[LIVE_TREE]');
                if (start >= 0 && rows) {
                    try {
                        rows.push(JSON.parse(line.slice(start + 11)));
                    }
                    catch {
                        return finish(new Error('Invalid tree export.'));
                    }
                }
                if (line.includes('[LIVE_TREES_END]') && rows) return finish(null, rows);
            }
        });
    });
}

export async function importLiveTrees({ patch, game: gameDirectory, assetDirectory = path.join(root, 'assets'),
    scriptDirectory = path.join(root, 'scripts') } = {}) {
    if (!patch || !/^[a-z0-9]+$/iu.test(patch)) throw new Error('A valid patch ID is required.');
    const game = resolveGameDirectory(gameDirectory);
    const dir = path.join(assetDirectory, 'data', patch);
    const mapBytes = openVpk(path.join(game, 'dota/maps/dota.vpk')).read('maps/dota.gnv');
    if (hash(mapBytes) !== hash(fs.readFileSync(path.join(dir, 'gridnav.gnv')))) throw new Error('Update the map assets before importing tree IDs.');
    const listener = net.createServer();
    await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
    const { port } = listener.address();
    await new Promise(resolve => listener.close(resolve));
    const script = `interactive_map_trees_${randomBytes(8).toString('hex')}`;
    const scriptFile = path.join(game, 'dota/scripts/vscripts', `${script}.lua`);
    fs.writeFileSync(scriptFile, fs.readFileSync(path.join(scriptDirectory, 'export-live-trees.lua')), { flag: 'wx' });
    const child = spawn(path.join(game, 'bin/win64/dota2.exe'), ['-dedicated', '-dev', '-insecure', '-novid', '-nosound', '-nohltv',
        '-netconport', String(port), '+sv_lan', '1', '+map', 'dota'], { cwd: path.join(game, 'dota'), windowsHide: true, stdio: 'ignore' });
    child.once('error', () => {
        child.scanFailed = true;
    });
    try {
        const rows = await capture(port, script, child);
        const map = JSON.parse(fs.readFileSync(path.join(dir, 'mapdata.json')));
        const mapIndices = mapTreeIds(rows, map.data.ent_dota_tree);
        fs.writeFileSync(path.join(dir, 'live_tree_index.json'), `${JSON.stringify({
            navigationSha256: hash(mapBytes), method: 'GetTreeIdForEntityIndex on the installed map', mapIndices,
        })}\n`);
        console.log(`Verified ${mapIndices.length} native tree IDs.`);
        return { navigationSha256: hash(mapBytes), mapIndices };
    }
    finally {
        if (child.exitCode === null) child.kill();
        fs.unlinkSync(scriptFile);
    }
}

async function main(argv = process.argv.slice(2)) {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true,
        options: { game: { type: 'string' } } });
    const [patch] = positionals;
    if (positionals.length !== 1) throw new Error('Usage: npm run import:live-trees -- <patch> [--game <directory>]');
    await importLiveTrees({ patch, game: values.game });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});
