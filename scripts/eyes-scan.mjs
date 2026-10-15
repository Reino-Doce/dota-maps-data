import net from 'node:net';
import { wardGridToGeoJSON } from './ward-grid.mjs';

export function createEyesCollector() {
    let header;
    const trees = [];
    const keys = new Set();
    const patterns = [];
    const patternIds = new Map();
    return {
        accept(line) {
            const match = line.match(/\[EYES_SCAN_(BEGIN|TREE|DONE|ERROR)\](.*)/);
            if (!match) return;
            const [, type, payload] = match;
            if (type === 'ERROR') throw new Error(payload);
            if (type === 'BEGIN') {
                if (header) throw new Error('Overlapping Eyes export');
                header = JSON.parse(payload);
                if (header.map !== 'dota' || !Number.isInteger(header.count) || header.count < 1
                    || header.radius !== 800 || header.cellSize !== 64 || header.size !== 41 || header.offset !== -1280) {
                    throw new Error('Unsupported Eyes scan header');
                }
                return;
            }
            if (!header) throw new Error('Eyes export has no header');
            if (type === 'TREE') {
                const { x, y, rows } = JSON.parse(payload);
                const key = `${x},${y}`;
                if (![x, y].every(value => Number.isFinite(value) && value % 64 === 0) || keys.has(key)
                    || rows?.length !== header.size || !rows.every(row => Array.isArray(row) && row.length % 2 === 0
                        && row.every((value, i) => Number.isInteger(value) && value >= 0 && value <= header.size
                            && (i === 0 || value > row[i - 1]))) || !rows.some(row => row.length)) {
                    throw new Error('Invalid or duplicate Eyes tree sample');
                }
                if (rows[0].length || rows.at(-1).length || rows.some(row => row[0] === 0 || row.at(-1) === header.size)) {
                    throw new Error(`Vision reached the scan boundary at ${key} (sample ${trees.length + 1}); check viewer isolation and sample window`);
                }
                // Allow the native cell rounding, but reject distant reveals
                // from other NPCs (zeroing their sight alone is insufficient).
                if (rows.some((row, y) => row.some((edge, i) => Math.hypot(
                    header.offset + (edge + (i % 2 ? -0.5 : 0.5)) * header.cellSize,
                    header.offset + (y + 0.5) * header.cellSize,
                ) > header.radius + header.cellSize))) {
                    throw new Error(`Unrelated vision outside the Eyes FOW radius at ${key}`);
                }
                keys.add(key);
                const serialized = JSON.stringify(rows);
                if (!patternIds.has(serialized)) {
                    const geometry = wardGridToGeoJSON({
                        width: header.size, height: header.size, cellSize: header.cellSize,
                        origin: [header.offset, header.offset], blockedRows: rows,
                    }).features[0].geometry;
                    patternIds.set(serialized, patterns.length);
                    patterns.push({ rows, polygons: geometry.coordinates });
                }
                trees.push([x, y, patternIds.get(serialized)]);
                return;
            }
            if (trees.length !== header.count) throw new Error('Incomplete Eyes export');
            return { ...header, patterns, trees };
        },
        get count() {
            return trees.length;
        },
    };
}

export function scanEyesConsole({ port, script, onProgress = () => {} }) {
    return new Promise((resolve, reject) => {
        const collector = createEyesCollector();
        const socket = net.createConnection({ host: '127.0.0.1', port });
        let buffer = '';
        let started = false;
        let done = false;
        const finish = (error, data) => {
            if (done) return;
            done = true;
            clearInterval(retry);
            clearTimeout(deadline);
            socket.destroy();
            if (error) reject(error);
            else resolve(data);
        };
        const send = () => {
            if (!started && socket.readyState === 'open') socket.write(`sv_cheats 1\nsv_hibernate_when_empty 0\nscript_reload_code ${script}\n`);
        };
        const retry = setInterval(send, 1000);
        const deadline = setTimeout(() => finish(new Error('Eyes scan timed out')), 900_000);
        socket.on('connect', send);
        socket.on('error', error => finish(error));
        socket.on('close', () => finish(new Error(`Game disconnected after ${collector.count} trees, before the Eyes scan completed`)));
        socket.on('data', bytes => {
            buffer += bytes.toString('utf8');
            if (buffer.length > 1_000_000) return finish(new Error('Eyes console line exceeded limit'));
            const lines = buffer.split('\n');
            buffer = lines.pop();
            try {
                for (const line of lines) {
                    if (line.includes('[EYES_SCAN_BEGIN]')) started = true;
                    const result = collector.accept(line);
                    if (result) return finish(null, result);
                    if (line.includes('[EYES_SCAN_TREE]') && collector.count % 400 === 0) onProgress(collector.count);
                }
            }
            catch (error) {
                finish(error);
            }
        });
    });
}
