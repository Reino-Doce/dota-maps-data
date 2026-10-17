import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { parseArgs, promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { PNG } from 'pngjs';
import sharp from 'sharp';
import { discoverTerrains, openVpk, resolveGameDirectory } from '../src/node/game-files.mjs';
import { readGridNav } from './ward-grid.mjs';
import { compareTerrain, scanConsole } from './game-scan.mjs';
import { assertUsableImage, decodeTga } from './terrain-image.mjs';
import { calibrateScreenshot } from './screenshot-calibration.mjs';
import { createSfmSession } from './sfm-session.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const save = (file, data) => fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx' });
const help = `Usage: npm run map:skins -- <command> [options]

  list                         Discover installed terrain items from game files
  scan --skin dota_ti10         Scan heights, trees, structures and Tormentor pits
       [--launch | --port N]    Start an owned dedicated server, or attach (default 29009)
  capture --skin dota_ti10      Generate a top-down Source Filmmaker session
       [--launch] [--size N]    Optionally open fresh Workshop Tools; default 4096
  controls --capture <dir>      Prepare calibration controls for an exported PNG/TGA
       --image <file>          Measure each landmark before import
  import --skin dota_ti10       Register a captured skin after checking scan/calibration
       --scan <scan-directory> --image <PNG> --controls <JSON>

  --game <directory>           Dota's game directory (or DOTA_GAME_DIR)
  --patch <id>                 Repository patch data, default 741
  --output <new-directory>     Capture/scan output; default map-captures/<patch>/<skin>/<run>

Capture requires Workshop Tools. Export the generated session with File > Export
> Poster. Restart Tools between skins: their internal resource paths overlap.
Scans use the stock server map; cosmetic archives omit gameplay navigation.
Scans and captures write ignored library captures; map assets change only through validated import.`;

async function waitForPort(port, child) {
    let startError;
    child.once('error', error => {
        startError = error;
    });
    for (let i = 0; i < 120; i++) {
        if (startError) throw startError;
        if (child.exitCode !== null) throw new Error('The game exited before its console became ready.');
        const connected = await new Promise(resolve => {
            const socket = net.createConnection({ host: '127.0.0.1', port });
            socket.setTimeout(500);
            const finish = value => {
                socket.destroy();
                resolve(value);
            };
            socket.once('connect', () => finish(true));
            socket.once('error', () => finish(false));
            socket.once('timeout', () => finish(false));
        });
        if (connected) return;
        await delay(500);
    }
    throw new Error('The local game server did not open its console.');
}

async function unusedPort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address();
    await new Promise(resolve => server.close(resolve));
    return port;
}

export async function scanTerrainSkin({ game, terrain, output, patchDirectory, launch, port }) {
    const archive = openVpk(path.join(game, 'dota/maps/dota.vpk'));
    const bytes = archive.read('maps/dota.gnv');
    const nav = readGridNav(bytes);
    const script = `interactive_map_scan_${randomBytes(8).toString('hex')}`;
    const scriptFile = path.join(game, 'dota/scripts/vscripts', `${script}.lua`);
    const parameters = `INTERACTIVE_MAP_EXPORT = { width=${nav.width}, height=${nav.height}, cellSize=${nav.cellSize}, minX=${nav.origin[0]}, minY=${nav.origin[1]} }\n`;
    fs.mkdirSync(path.dirname(scriptFile), { recursive: true });
    fs.writeFileSync(scriptFile, parameters + fs.readFileSync(path.join(root, 'scripts/export-game-grid.lua'), 'utf8'), { flag: 'wx' });
    let child;
    try {
        if (launch) {
            port = await unusedPort();
            const executable = path.join(game, process.platform === 'win32' ? 'bin/win64/dota2.exe' : 'bin/linuxsteamrt64/dota2');
            // Cosmetic archives omit GNV. Scan the stock server for gameplay
            // data; Source Filmmaker renders the selected archive separately.
            child = spawn(executable, ['-dedicated', '-dev', '-insecure', '-novid', '-nosound', '-nohltv',
                '-netconport', String(port), '+sv_lan', '1', '+map', 'dota'], {
                cwd: path.join(game, 'dota'), windowsHide: true, stdio: 'ignore',
            });
            await waitForPort(port, child);
        }
        const grid = await scanConsole({ port, script, map: 'dota' });
        let compatibility;
        try {
            compatibility = compareTerrain(json(path.join(patchDirectory, 'terrain_grid.json')), grid);
        }
        catch {
            // Keep new game data available even when a patch has different
            // bounds, or has not been prepared in the repository yet.
            compatibility = { overlaysCompatible: false, comparison: 'Base terrain data missing or incompatible with the scanned grid.' };
        }
        const patchNavFile = path.join(patchDirectory, 'gridnav.gnv');
        const navigationMatches = fs.existsSync(patchNavFile) && hash(fs.readFileSync(patchNavFile)) === hash(bytes);
        fs.writeFileSync(path.join(output, 'gridnav.gnv'), bytes, { flag: 'wx' });
        save(path.join(output, 'terrain_grid.json'), grid);
        save(path.join(output, 'scan.json'), {
            schemaVersion: 1, terrain, scannedMap: grid.source.map,
            navigationSha256: hash(bytes), terrainSha256: hash(fs.readFileSync(path.join(output, 'terrain_grid.json'))),
            terrainArchiveSha256: hash(fs.readFileSync(path.join(game, 'dota/maps', `${terrain.map}.vpk`))),
            ...compatibility, navigationMatches,
            overlaysCompatible: navigationMatches && compatibility.overlaysCompatible,
        });
        console.log(`Scanned ${grid.width * grid.height} cells, ${grid.trees.length} trees and ${grid.entities.length} collision entities.`);
        console.log(`Existing patch overlays ${navigationMatches && compatibility.overlaysCompatible ? 'match' : 'differ; update patch data before importing this skin'}.`);
    }
    finally {
        if (child && child.exitCode === null) child.kill();
        fs.unlinkSync(scriptFile);
    }
}

export async function captureTerrainSkin({ game, terrain, size, output, launch }) {
    if (![1024, 2048, 4096, 8192].includes(size)) throw new Error('--size must be 1024, 2048, 4096 or 8192.');
    const bytes = openVpk(path.join(game, 'dota/maps/dota.vpk')).read('maps/dota.gnv');
    const nav = readGridNav(bytes);
    const worldExtent = [...nav.origin.map(value => value - 256),
        nav.origin[0] + nav.width * nav.cellSize + 256, nav.origin[1] + nav.height * nav.cellSize + 256];
    const session = createSfmSession({ map: terrain.map, worldExtent, size,
        outputPrefix: path.join(output, 'map').replaceAll('\\', '/') });
    const sessionFile = path.join(output, 'session.dmx');
    fs.writeFileSync(sessionFile, session.text, { flag: 'wx' });
    const { cameraHeight, fieldOfView, nominalWorldExtent, rendering } = session;
    save(path.join(output, 'capture.json'), {
        schemaVersion: 1, terrain, width: size, height: size, method: 'Source Filmmaker poster',
        navigationSha256: hash(bytes), terrainArchiveSha256: hash(fs.readFileSync(path.join(game, 'dota/maps', `${terrain.map}.vpk`))),
        cameraHeight, fieldOfView, nominalWorldExtent, rendering,
    });
    if (launch) {
        if (process.platform !== 'win32') throw new Error('Automatic Workshop Tools launch is supported on Windows. Open session.dmx in Source Filmmaker manually.');
        if (!fs.existsSync(path.join(game, 'bin/win64/assetsystem.dll'))) throw new Error('Install the Dota 2 Workshop Tools DLC before capture.');
        const { stdout } = await promisify(execFile)('tasklist', ['/FI', 'IMAGENAME eq dota2.exe', '/FO', 'CSV', '/NH'], { windowsHide: true });
        if (/"dota2\.exe"/i.test(stdout)) throw new Error('Close Dota and Workshop Tools before --launch; a fresh process prevents cached terrain from another skin. The session has been saved.');
        const port = await unusedPort();
        const child = spawn(path.join(game, 'bin/win64/dota2.exe'),
            ['-tools', '-insecure', '-novid', '-nosound', '-windowed', '-w', '1280', '-h', '720',
                '-netconport', String(port)],
            { cwd: path.join(game, 'dota'), windowsHide: true, detached: true, stdio: 'ignore' });
        try {
            await waitForPort(port, child);
        }
        catch (error) {
            if (child.exitCode === null) child.kill();
            throw error;
        }
        child.unref(); // The graphical editor stays open for the poster export.
    }
    console.log(`Open ${sessionFile} in Source Filmmaker, then File > Export > Poster (PNG, ${size} x ${size}).`);
}

export function prepareSkinControls({ captureDirectory, image, patchDirectory }) {
    if (!captureDirectory || !image) throw new Error('Controls requires --capture and --image.');
    const captureMetadata = json(path.join(captureDirectory, 'capture.json'));
    let bytes = fs.readFileSync(image);
    let png;
    if (/\.tga$/i.test(image)) {
        png = decodeTga(bytes);
        bytes = PNG.sync.write(png);
        fs.writeFileSync(path.join(captureDirectory, 'converted.png'), bytes, { flag: 'wx' });
        console.log('Converted TGA to converted.png. Use that PNG for import.');
    }
    else png = PNG.sync.read(bytes);
    assertUsableImage(png);
    if (png.width !== captureMetadata.width || png.height !== captureMetadata.height) throw new Error('Poster dimensions differ from the capture session.');
    const base = json(path.join(patchDirectory, 'screenshot-controls.json'));
    const point = ({ name, world }) => ({ name, world, pixel: null });
    save(path.join(captureDirectory, 'controls.json'), {
        source: { sha256: hash(bytes), terrainMap: captureMetadata.terrain.map, method: captureMetadata.method,
            navigationSha256: captureMetadata.navigationSha256, terrainArchiveSha256: captureMetadata.terrainArchiveSha256,
            rendering: captureMetadata.rendering },
        width: png.width, height: png.height, maxErrorWorld: 32,
        // Rune particles need a running match and are absent from an editor render.
        anchors: base.anchors.filter(anchor => !anchor.name.includes('rune')).map(point),
        checks: base.checks.map(point),
    });
    console.log('Fill each pixel in controls.json with its measured [x, y] in the original image, starting at the top left.');
}

export async function importSkin({ terrain, image, controls, scanDirectory, patchDirectory, patch, repositoryRoot = root }) {
    if (!image || !controls || !scanDirectory) throw new Error('Import requires --image, --controls and --scan.');
    const scanMetadata = json(path.join(scanDirectory, 'scan.json'));
    const gridBytes = fs.readFileSync(path.join(scanDirectory, 'terrain_grid.json'));
    const nav = fs.readFileSync(path.join(scanDirectory, 'gridnav.gnv'));
    if (scanMetadata.terrain.map !== terrain.map || scanMetadata.navigationSha256 !== hash(nav)
        || scanMetadata.terrainSha256 !== hash(gridBytes)) throw new Error('Scan files changed or belong to another terrain.');
    const compatible = compareTerrain(json(path.join(patchDirectory, 'terrain_grid.json')), JSON.parse(gridBytes));
    if (!compatible.overlaysCompatible || hash(nav) !== hash(fs.readFileSync(path.join(patchDirectory, 'gridnav.gnv')))) {
        throw new Error('Game scan differs from this patch. Update the gameplay layers before publishing the skin.');
    }
    const bytes = fs.readFileSync(image);
    const png = PNG.sync.read(bytes);
    assertUsableImage(png);
    const measured = json(controls);
    if (measured.source?.sha256 !== hash(bytes) || measured.source.terrainMap !== terrain.map
        || measured.width !== png.width || measured.height !== png.height) {
        throw new Error('Image differs from its measured controls (hash or dimensions).');
    }
    if (measured.source.navigationSha256 !== scanMetadata.navigationSha256
        || measured.source.terrainArchiveSha256 !== scanMetadata.terrainArchiveSha256) {
        throw new Error('Capture and scan were made from different game files.');
    }
    if (measured.maxErrorWorld > 32) throw new Error('Skin registration tolerance must be at most 32 world units.');
    const registration = calibrateScreenshot(measured);
    const file = path.join(patchDirectory, 'skins.json');
    const skins = fs.existsSync(file) ? json(file) : [];
    const id = `skin-${terrain.map}`;
    if (skins.some(skin => skin.id === id)) throw new Error('This skin is already registered; review the existing entry before replacing it.');
    const imageId = terrain.map === 'dota' ? 'default' : terrain.map.replace(/^dota_/u, '');
    const imagePath = `img/${patch}/${imageId}.jpg`;
    const destination = path.join(repositoryRoot, 'assets', imagePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    if (fs.existsSync(destination)) {
        throw new Error(`Skin image already exists for ${imageId}; review it before replacing.`);
    }
    const jpegBytes = await sharp(bytes).jpeg({ quality: 92, chromaSubsampling: '4:4:4', mozjpeg: true }).toBuffer();
    const metadata = {
        id, name: terrain.name, image: imagePath, worldExtent: registration.worldExtent,
        source: { map: terrain.map, itemId: terrain.itemId, sha256: hash(bytes), navigationSha256: hash(nav),
            terrainArchiveSha256: scanMetadata.terrainArchiveSha256, method: measured.source.method,
            rendering: measured.source.rendering },
        registration: { width: png.width, height: png.height, maxErrorWorld: measured.maxErrorWorld,
            anchors: measured.anchors, checks: measured.checks, ...registration },
    };
    // Only explicit publication writes map assets. Scan/render commands write
    // ignored capture directories and cannot change the accepted default map.
    const pending = `${file}.${randomBytes(8).toString('hex')}.tmp`;
    let wroteImage = false;
    try {
        fs.writeFileSync(destination, jpegBytes, { flag: 'wx' });
        wroteImage = true;
        save(pending, [...skins, metadata]);
        fs.renameSync(pending, file);
    }
    catch (error) {
        // Leave the existing registry intact and make a failed import safe to retry.
        if (wroteImage && fs.existsSync(destination)) fs.unlinkSync(destination);
        if (fs.existsSync(pending)) fs.unlinkSync(pending);
        throw error;
    }
    console.log(`Registered ${terrain.name}. Run npm run build to show it in the terrain menu.`);
}

export async function runMapSkinCommand(argv = process.argv.slice(2)) {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
        game: { type: 'string' }, skin: { type: 'string' }, patch: { type: 'string', default: '741' },
        output: { type: 'string' }, port: { type: 'string', default: '29009' }, size: { type: 'string', default: '4096' },
        launch: { type: 'boolean' }, help: { type: 'boolean' }, image: { type: 'string' },
        controls: { type: 'string' }, scan: { type: 'string' }, capture: { type: 'string' },
    } });
    const [command] = positionals;
    if (values.help || !command) {
        console.log(help);
        return;
    }
    if (positionals.length !== 1 || !['list', 'scan', 'capture', 'controls', 'import'].includes(command)) throw new Error(help);
    if (!/^[a-z0-9]+$/.test(values.patch)) throw new Error('Invalid patch identifier.');
    const patchDirectory = path.join(root, 'assets/data', values.patch);
    if (command === 'controls') {
        prepareSkinControls({ captureDirectory: values.capture, image: values.image, patchDirectory });
        return;
    }
    const game = resolveGameDirectory(values.game);
    const terrains = discoverTerrains(game);
    if (command === 'list') {
        for (const terrain of terrains) console.log(`${terrain.map.padEnd(18)} ${terrain.name}${terrain.installed ? '' : ' (archive missing)'}`);
        return;
    }
    const terrain = terrains.find(candidate => candidate.map === values.skin || candidate.itemId === values.skin);
    if (!terrain?.installed) throw new Error('Choose an installed terrain from the list command with --skin <map or item ID>.');
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid console port.');
    if (command === 'import') {
        await importSkin({ terrain, image: values.image, controls: values.controls, scanDirectory: values.scan, patchDirectory, patch: values.patch });
        return;
    }
    const output = path.resolve(values.output || path.join(root, 'map-captures', values.patch, terrain.map,
        `${command}-${new Date().toISOString().replace(/[:.]/g, '-')}`));
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.mkdirSync(output); // Existing runs are never overwritten.
    if (command === 'scan') await scanTerrainSkin({ game, terrain, output, patchDirectory, launch: values.launch, port });
    else await captureTerrainSkin({ game, terrain, output, size: Number(values.size), launch: values.launch });
    console.log(`Saved ${path.relative(root, output)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    runMapSkinCommand().catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
