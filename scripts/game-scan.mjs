import net from 'node:net';

export function createGridCollector() {
    let grid;
    let complete = false;
    return {
        accept(line) {
            const match = line.match(/\[MAP_GRID_(BEGIN|HEIGHT|TREE|ENTITY|PIT|EXPORT_COMPLETE)\](.*)/);
            if (!match) return;
            if (complete) throw new Error('Duplicate game grid export.');
            const [, type, value] = match;
            if (type === 'BEGIN') {
                if (grid) throw new Error('Overlapping game grid exports.');
                grid = JSON.parse(value);
                if (![grid.width, grid.height, grid.cellSize].every(number => Number.isInteger(number) && number > 0)
                    || grid.width * grid.height > 4_000_000 || grid.origin?.length !== 2
                    || !grid.origin.every(Number.isFinite) || !/^dota[a-z0-9_]*$/.test(grid.map)) {
                    throw new Error('Invalid game grid header.');
                }
                grid.source = {
                    map: grid.map, heights: 'GetGroundHeight at GNV cell centers', trees: 'ent_dota_tree GetAbsOrigin',
                    entities: 'Runtime structure origins, hulls, models, scales and angles',
                    pits: 'World TraceLine below GetGroundHeight at miniboss_location markers',
                };
                delete grid.map;
                Object.assign(grid, { heights: [], trees: [], entities: [], pits: [] });
                return;
            }
            if (!grid) throw new Error('Game grid export has no header.');
            const vector = values => {
                if (!Array.isArray(values) || values.length !== 3 || !values.every(Number.isFinite)) {
                    throw new Error('Invalid game entity coordinates.');
                }
                return values.map(Math.fround);
            };
            if (type === 'HEIGHT') {
                const row = JSON.parse(value);
                if (!Array.isArray(row) || row.length !== grid.width || !row.every(Number.isFinite)
                    || grid.heights.length >= grid.height) throw new Error('Invalid game height row.');
                grid.heights.push(row.map(Math.fround));
            }
            else if (type === 'TREE') grid.trees.push(vector(JSON.parse(value)));
            else if (type === 'ENTITY') {
                const entity = JSON.parse(value);
                entity.origin = vector(entity.origin);
                if (entity.bounds?.length !== 2 || !(entity.hullRadius > 0)) throw new Error('Invalid game collision hull.');
                entity.bounds = entity.bounds.map(vector);
                if (entity.angles) {
                    entity.angles = vector(entity.angles);
                    if (typeof entity.model !== 'string' || !Number.isFinite(entity.modelScale) || entity.modelScale <= 0) {
                        throw new Error('Invalid structure model placement.');
                    }
                }
                grid.entities.push(entity);
            }
            else if (type === 'PIT') {
                const pit = JSON.parse(value);
                if (!/^miniboss_location_\d+$/.test(pit.name)
                    || ![pit.width, pit.height, pit.cellSize].every(n => Number.isInteger(n) && n > 0)
                    || pit.width * pit.height > 1_000_000 || pit.origin?.length !== 2 || !pit.origin.every(Number.isFinite)
                    || pit.center?.length !== 2 || !pit.center.every(Number.isFinite)
                    || pit.blockedRows?.length !== pit.height || !pit.blockedRows.every(row => Array.isArray(row)
                        && row.length % 2 === 0 && row.every((n, i) => Number.isInteger(n) && n >= 0 && n <= pit.width
                            && (i === 0 || n > row[i - 1])))) throw new Error('Invalid Tormentor pit trace.');
                grid.pits.push(pit);
            }
            else {
                if (grid.heights.length !== grid.height) throw new Error('Incomplete terrain height grid.');
                complete = true;
                return grid;
            }
        },
    };
}

// The connection is deliberately loopback-only. Discard unrelated console
// output so Steam/account and game-session messages never become artifacts.
export function scanConsole({ port, script, map, timeout = 120_000 }) {
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^[a-z0-9_]+$/.test(script)) {
        throw new Error('Invalid scan port or script name.');
    }
    return new Promise((resolve, reject) => {
        const collector = createGridCollector();
        const socket = net.createConnection({ host: '127.0.0.1', port });
        let buffer = '';
        let started = false;
        let done = false;
        const finish = (error, grid) => {
            if (done) return;
            done = true;
            clearTimeout(deadline);
            clearInterval(poll);
            socket.destroy();
            if (error) reject(error);
            else resolve(grid);
        };
        // Retail Dota disables inline `script`, but supports loading a local
        // Lua file. Retry that command until its BEGIN marker confirms the VM
        // is ready; never depend on inline evaluation for the readiness probe.
        const ready = () => socket.write(`sv_cheats 1\nsv_hibernate_when_empty 0\nscript_reload_code ${script}\n`);
        const deadline = setTimeout(() => finish(new Error('Game scan timed out; load the full dota map on a local server first.')), timeout);
        const poll = setInterval(() => {
            if (!started && socket.readyState === 'open') ready();
        }, 1000);
        socket.on('connect', ready);
        socket.on('error', error => finish(error));
        socket.on('close', () => finish(new Error('Game disconnected before completing the grid export.')));
        socket.on('data', bytes => {
            buffer += bytes.toString('utf8');
            if (buffer.length > 4_000_000) {
                finish(new Error('Game console line exceeded the scan limit.'));
                return;
            }
            const lines = buffer.split('\n');
            buffer = lines.pop();
            try {
                for (const line of lines) {
                    if (line.includes('[MAP_GRID_BEGIN]')) started = true;
                    const grid = collector.accept(line);
                    if (grid) {
                        if (map && grid.source.map !== map) throw new Error('Exported a different map than requested.');
                        finish(null, grid);
                        break;
                    }
                }
            }
            catch (error) {
                finish(error);
            }
        });
    });
}

export function compareTerrain(base, candidate) {
    for (const field of ['width', 'height', 'cellSize', 'origin']) {
        if (JSON.stringify(base[field]) !== JSON.stringify(candidate[field])) throw new Error(`Terrain ${field} differs from the base grid.`);
    }
    let changedHeightCells = 0;
    let maxHeightDelta = 0;
    for (let y = 0; y < base.height; y++) {
        for (let x = 0; x < base.width; x++) {
            const delta = Math.abs(base.heights[y][x] - candidate.heights[y][x]);
            if (!Number.isFinite(delta)) throw new Error('Terrain contains missing or invalid heights.');
            if (delta > 0.01) changedHeightCells += 1;
            maxHeightDelta = Math.max(maxHeightDelta, delta);
        }
    }
    const normalized = values => values.map(value => JSON.stringify(value)).sort();
    const treePositionsMatch = JSON.stringify(normalized(base.trees)) === JSON.stringify(normalized(candidate.trees));
    const hulls = grid => grid.entities.map(entity => [entity.classname, entity.origin, entity.hullRadius,
        entity.model, entity.modelScale, entity.angles]);
    const candidateHulls = hulls(candidate);
    // Engine serialization can vary by one float32 ULP between runs. Compare
    // positions at the same 0.01-unit tolerance as heights, without snapping.
    const baseHulls = hulls(base);
    const near = (a, b) => a === b || (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 0.01);
    const wardHullsMatch = baseHulls.length === candidateHulls.length && baseHulls.every(([classname, origin, radius, model, scale, angles]) => {
        const index = candidateHulls.findIndex(([otherClass, otherOrigin, otherRadius, otherModel, otherScale, otherAngles]) => classname === otherClass
            && Math.abs(radius - otherRadius) <= 0.01
            && origin.every((value, axis) => Math.abs(value - otherOrigin[axis]) <= 0.01)
            && model === otherModel && near(scale, otherScale)
            && (angles === otherAngles || (angles?.length === 3 && otherAngles?.length === 3
                && angles.every((value, axis) => near(value, otherAngles[axis])))));
        if (index < 0) return false;
        candidateHulls.splice(index, 1);
        return true;
    }) && JSON.stringify(normalized(base.pits || [])) === JSON.stringify(normalized(candidate.pits || []));
    return {
        changedHeightCells, maxHeightDelta, treePositionsMatch, wardHullsMatch,
        overlaysCompatible: changedHeightCells === 0 && treePositionsMatch && wardHullsMatch,
    };
}
