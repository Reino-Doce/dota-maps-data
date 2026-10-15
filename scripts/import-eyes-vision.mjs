import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { openVpk, resolveGameDirectory } from '../src/node/game-files.mjs';
import { createEyesCollector, scanEyesConsole } from './eyes-scan.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function scanBatch(game, lua, first, count) {
    const script = `interactive_map_eyes_${randomBytes(8).toString('hex')}`;
    const scriptFile = path.join(game, 'dota/scripts/vscripts', `${script}.lua`);
    const listener = net.createServer();
    await new Promise((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(0, '127.0.0.1', resolve);
    });
    const { port } = listener.address();
    await new Promise(resolve => listener.close(resolve));
    fs.mkdirSync(path.dirname(scriptFile), { recursive: true });
    fs.writeFileSync(scriptFile, `INTERACTIVE_EYES_SCAN_FIRST=${first}\nINTERACTIVE_EYES_SCAN_COUNT=${count}\n${lua}`, { flag: 'wx' });
    let child;
    try {
        const executable = path.join(game, process.platform === 'win32' ? 'bin/win64/dota2.exe' : 'bin/linuxsteamrt64/dota2');
        child = spawn(executable, ['-dedicated', '-dev', '-insecure', '-novid', '-nosound', '-nohltv',
            '-netconport', String(port), '+sv_lan', '1', '+dota_wait_for_players_to_load_count', '1',
            '+dota_wait_for_players_to_load_timeout', '3600', '+map', 'dota'], {
            cwd: path.join(game, 'dota'), windowsHide: true, stdio: 'ignore',
        });
        let startError;
        child.once('error', error => {
            startError = error;
        });
        let ready = false;
        for (let i = 0; i < 120 && !ready; i++) {
            if (startError) throw startError;
            if (child.exitCode !== null) throw new Error('Game exited before its console became ready');
            ready = await new Promise(resolve => {
                const socket = net.createConnection({ host: '127.0.0.1', port });
                const finish = value => {
                    socket.destroy();
                    resolve(value);
                };
                socket.once('connect', () => finish(true));
                socket.once('error', () => finish(false));
            });
            if (!ready) await delay(500);
        }
        if (!ready) throw new Error('Game console did not become ready');
        return await scanEyesConsole({ port, script,
            onProgress: scanned => console.log(`Scanned ${first - 1 + scanned} enchanted trees.`) });
    }
    finally {
        if (child && child.exitCode === null) child.kill();
        fs.unlinkSync(scriptFile);
    }
}

export async function importEyesVision({ patch, game: gameDirectory, assetDirectory = path.join(root, 'assets'),
    exporterFile = path.join(root, 'scripts/export-eyes-vision.lua') } = {}) {
    if (!patch || !/^[a-z0-9]+$/iu.test(patch)) throw new Error('A valid patch ID is required.');
    const directory = path.join(assetDirectory, 'data', patch);
    const game = resolveGameDirectory(gameDirectory);
    const mapArchive = openVpk(path.join(game, 'dota/maps/dota.vpk'));
    const archive = openVpk(path.join(game, 'dota/pak01_dir.vpk'));
    const grid = mapArchive.read('maps/dota.gnv');
    if (sha256(grid) !== sha256(fs.readFileSync(path.join(directory, 'gridnav.gnv')))) {
        throw new Error('Installed map differs from the selected patch; update map data first');
    }
    const expectedTrees = JSON.parse(fs.readFileSync(path.join(directory, 'mapdata.json'))).data.ent_dota_tree;
    const lua = fs.readFileSync(exporterFile);
    const collector = createEyesCollector();
    // Keep each empty dedicated server session short and bound its workload.
    for (let first = 1; first <= expectedTrees.length; first += 600) {
        const batch = await scanBatch(game, lua, first, Math.min(600, expectedTrees.length - first + 1));
        if (first === 1) collector.accept('[EYES_SCAN_BEGIN]' + JSON.stringify({ ...batch, count: expectedTrees.length, patterns: undefined, trees: undefined }));
        for (const [x, y, pattern] of batch.trees) {
            collector.accept('[EYES_SCAN_TREE]' + JSON.stringify({ x, y, rows: batch.patterns[pattern].rows }));
        }
        console.log(`Completed ${collector.count}/${expectedTrees.length} trees.`);
    }
    const data = collector.accept('[EYES_SCAN_DONE]');
    const actual = new Set(data.trees.map(([x, y]) => `${x},${y}`));
    if (actual.size !== expectedTrees.length || expectedTrees.some(({ x, y }) => !actual.has(`${x},${y}`))) {
        throw new Error('Installed trees differ from the selected patch; update map data first');
    }
    data.source = {
        method: 'IsLocationVisible after casting Eyes in the Forest on every tree, one isolated team per viewer',
        isolation: 'Other NPCs removed; terrain, trees and FOW blockers preserved; darkness verified before every cast',
        gridnavSha256: sha256(grid),
        mapEntitiesSha256: sha256(mapArchive.read('maps/dota/entities/default_ents.vents_c')),
        abilitySha256: sha256(archive.read('scripts/npc/heroes/npc_dota_hero_treant.txt')),
        unitsSha256: sha256(archive.read('scripts/npc/npc_units.txt')),
        exporterSha256: sha256(lua),
    };
    const destination = path.join(directory, 'eyes_vision.json');
    const temporary = `${destination}.${randomBytes(8).toString('hex')}.tmp`;
    try {
        fs.writeFileSync(temporary, JSON.stringify(data), { flag: 'wx' });
        fs.renameSync(temporary, destination);
    }
    finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
    console.log(`Imported native vision for all ${data.count} trees (${data.patterns.length} distinct contours).`);
    return data;
}

async function main(argv = process.argv.slice(2)) {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true,
        options: { game: { type: 'string' } } });
    const [patch] = positionals;
    if (!patch || positionals.length !== 1) throw new Error('Usage: npm run import:eyes -- <patch> [--game <directory>]');
    await importEyesVision({ patch, game: values.game });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
