import { encodeWardGrid, wardGridToGeoJSON } from './ward-grid.mjs';

// Source 2 Viewer's GLB conversion is (Y, Z, X) * 0.0254, including units.
// https://github.com/ValveResourceFormat/ValveResourceFormat/blob/master/ValveResourceFormat/IO/Gltf/GltfModelExporter.Conversion.cs
export function defaultMeshGroups(modelData) {
    const mask = modelData.match(/m_nDefaultMeshGroupMask\s*=\s*(\d+)/);
    const groups = modelData.match(/m_refMeshGroupMasks\s*=\s*\[([\s\S]*?)\]/);
    if (!mask || !groups) throw new Error('Model has no default bodygroup metadata.');
    return (groups[1].match(/\d+/g) || []).map(value => (BigInt(value) & BigInt(mask[1])) !== 0n);
}

export function readModelTriangles(bytes, activeMeshes) {
    if (bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2
        || bytes.readUInt32LE(8) !== bytes.length) throw new Error('Expected a complete GLB model.');
    let json;
    let binary;
    for (let offset = 12; offset < bytes.length;) {
        const length = bytes.readUInt32LE(offset);
        const type = bytes.readUInt32LE(offset + 4);
        if (offset + 8 + length > bytes.length) throw new Error('Truncated GLB chunk.');
        const data = bytes.subarray(offset + 8, offset + 8 + length);
        if (type === 0x4e4f534a) json = JSON.parse(data.toString());
        if (type === 0x004e4942) binary = data;
        offset += 8 + length;
    }
    if (!json?.asset?.generator?.startsWith('Source 2 Viewer') || !binary) throw new Error('Use Source 2 Viewer to export the structure model.');
    if (activeMeshes && activeMeshes.length !== json.meshes.length) throw new Error('Exported meshes do not match the model bodygroups.');
    const accessor = index => {
        const a = json.accessors[index];
        const view = json.bufferViews[a.bufferView];
        const components = { SCALAR: 1, VEC3: 3 }[a.type];
        const size = { 5123: 2, 5125: 4, 5126: 4 }[a.componentType];
        if (!components || !size || a.sparse || view.buffer !== 0) throw new Error('Unsupported model accessor.');
        const stride = view.byteStride || components * size;
        const offset = (view.byteOffset || 0) + (a.byteOffset || 0);
        const read = a.componentType === 5126 ? 'readFloatLE' : a.componentType === 5125 ? 'readUInt32LE' : 'readUInt16LE';
        return Array.from({ length: a.count }, (_, i) => Array.from({ length: components }, (_, axis) => binary[read](offset + i * stride + axis * size)));
    };
    const transform = (point, node) => {
        if (node.matrix) return [0, 1, 2].map(axis => point.reduce((sum, v, i) => sum + v * node.matrix[i * 4 + axis], node.matrix[12 + axis]));
        let [x, y, z] = point.map((v, i) => v * (node.scale?.[i] ?? 1));
        if (node.rotation) {
            const [qx, qy, qz, qw] = node.rotation;
            const [tx, ty, tz] = [2 * (qy * z - qz * y), 2 * (qz * x - qx * z), 2 * (qx * y - qy * x)];
            [x, y, z] = [x + qw * tx + qy * tz - qz * ty, y + qw * ty + qz * tx - qx * tz, z + qw * tz + qx * ty - qy * tx];
        }
        return [x, y, z].map((v, i) => v + (node.translation?.[i] || 0));
    };
    const triangles = [];
    const visit = (index, parents = []) => {
        const node = json.nodes[index];
        if (!node || parents.includes(node)) throw new Error('Invalid model hierarchy.');
        const chain = [node, ...parents];
        if (node.mesh !== undefined && (!activeMeshes || activeMeshes[node.mesh])) {
            for (const primitive of json.meshes[node.mesh].primitives) {
                // Alpha-tested foliage uses transparent quads; their triangles
                // are not solid structure. Water interiors are filled below.
                if (primitive.material !== undefined && (json.materials[primitive.material].alphaMode || 'OPAQUE') !== 'OPAQUE') continue;
                if ((primitive.mode ?? 4) !== 4) throw new Error('Expected triangle model meshes.');
                const positions = accessor(primitive.attributes.POSITION).map(point => {
                    const p = chain.reduce(transform, point);
                    return [p[2] / 0.0254, p[0] / 0.0254, p[1] / 0.0254];
                });
                const indices = primitive.indices === undefined ? positions.map((_, i) => i) : accessor(primitive.indices).flat();
                if (indices.length % 3) throw new Error('Incomplete model triangle.');
                for (let i = 0; i < indices.length; i += 3) {
                    const triangle = indices.slice(i, i + 3).map(n => positions[n]);
                    if (triangle.some(p => !p || !p.every(Number.isFinite))) throw new Error('Invalid model vertex.');
                    triangles.push(triangle);
                }
            }
        }
        for (const child of node.children || []) visit(child, chain);
    };
    for (const node of json.scenes[json.scene || 0].nodes) visit(node);
    if (!triangles.length) throw new Error('Structure model contains no triangles.');
    return triangles;
}

export function placeModelPoint([x, y, z], entity) {
    const [pitch, yaw, roll] = entity.angles.map(v => v * Math.PI / 180);
    const cp = Math.cos(pitch), sp = Math.sin(pitch), cy = Math.cos(yaw), sy = Math.sin(yaw), cr = Math.cos(roll), sr = Math.sin(roll);
    return [
        cp * cy * x + (sr * sp * cy - cr * sy) * y + (cr * sp * cy + sr * sy) * z,
        cp * sy * x + (sr * sp * sy + cr * cy) * y + (cr * sp * sy - sr * cy) * z,
    ].map((v, axis) => entity.origin[axis] + v * entity.modelScale);
}

function geometryFromMask(definition, flags) {
    const grid = encodeWardGrid({ ...definition, flags });
    const feature = wardGridToGeoJSON(grid).features[0];
    if (!feature) throw new Error('Empty structure footprint.');
    return feature.geometry;
}

// Project the full model, including the pools around the Lotus NPC. Mark every
// intersected 8-unit cell and fill enclosed bowls; do not use a bounding box.
export function projectModelFootprint(triangles, entity, cellSize = 8) {
    const projected = triangles.map(triangle => triangle.map(point => placeModelPoint(point, entity)));
    const bounds = [Infinity, Infinity, -Infinity, -Infinity];
    for (const triangle of projected) for (const point of triangle) for (let axis = 0; axis < 2; axis++) {
        bounds[axis] = Math.min(bounds[axis], point[axis]);
        bounds[axis + 2] = Math.max(bounds[axis + 2], point[axis]);
    }
    const origin = bounds.slice(0, 2).map(v => Math.floor(v / cellSize) * cellSize - cellSize);
    const [width, height] = bounds.slice(2).map((v, i) => Math.ceil((v - origin[i]) / cellSize) + 1);
    if (width * height > 1_000_000) throw new Error('Structure footprint exceeds the scan limit.');
    const flags = new Uint8Array(width * height);
    for (const triangle of projected) {
        const min = [0, 1].map(a => Math.floor((Math.min(...triangle.map(p => p[a])) - origin[a]) / cellSize));
        const max = [0, 1].map(a => Math.floor((Math.max(...triangle.map(p => p[a])) - origin[a]) / cellSize));
        const axes = triangle.map((p, i) => [p[1] - triangle[(i + 1) % 3][1], triangle[(i + 1) % 3][0] - p[0]]);
        const intervals = axes.map(axis => triangle.map(p => p[0] * axis[0] + p[1] * axis[1]));
        for (let row = min[1]; row <= max[1]; row++) for (let column = min[0]; column <= max[0]; column++) {
            const x = origin[0] + (column + 0.5) * cellSize;
            const y = origin[1] + (row + 0.5) * cellSize;
            const intersects = axes.every((axis, i) => {
                const center = x * axis[0] + y * axis[1];
                const radius = cellSize / 2 * (Math.abs(axis[0]) + Math.abs(axis[1]));
                return center + radius >= Math.min(...intervals[i]) && center - radius <= Math.max(...intervals[i]);
            });
            if (intersects) flags[row * width + column] = 16;
        }
    }
    const outside = new Uint8Array(flags.length);
    const queue = [0];
    outside[0] = 1;
    for (let i = 0; i < queue.length; i++) {
        const index = queue[i], x = index % width, y = Math.floor(index / width);
        for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
            const next = ny * width + nx;
            if (nx >= 0 && ny >= 0 && nx < width && ny < height && !flags[next] && !outside[next]) {
                outside[next] = 1;
                queue.push(next);
            }
        }
    }
    flags.forEach((_, i) => {
        if (!outside[i]) flags[i] = 16;
    });
    return geometryFromMask({ origin, width, height, cellSize }, flags);
}

export function pitFootprint(pit) {
    const { width, height, cellSize, origin, center, blockedRows } = pit;
    const mask = new Uint8Array(width * height);
    blockedRows.forEach((row, y) => {
        for (let i = 0; i < row.length; i += 2) mask.fill(1, y * width + row[i], y * width + row[i + 1]);
    });
    const start = Math.floor((center[1] - origin[1]) / cellSize) * width + Math.floor((center[0] - origin[0]) / cellSize);
    if (!mask[start]) throw new Error(`No pit below ${pit.name}; recapture its world collision.`);
    const flags = new Uint8Array(mask.length);
    const queue = [start];
    flags[start] = 16;
    for (let i = 0; i < queue.length; i++) {
        const index = queue[i], x = index % width, y = Math.floor(index / width);
        if (x === 0 || y === 0 || x === width - 1 || y === height - 1) throw new Error('Pit reaches the trace boundary; enlarge the scan.');
        for (const next of [index - 1, index + 1, index - width, index + width]) if (mask[next] && !flags[next]) {
            flags[next] = 16;
            queue.push(next);
        }
    }
    return geometryFromMask(pit, flags);
}
