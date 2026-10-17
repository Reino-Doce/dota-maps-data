// Parse Source 2 Viewer decompiler text without launching processes or writing files.
const entityHeader = /^====\d+====[ \t]*$/gm;
const propertyLine = /^([A-Za-z_][A-Za-z0-9_]*)[ \t]{2,}(.+?)[ \t]*$/gm;

function decodeValue(source) {
    const value = source.trim();
    const resource = /^resource_name:("(?:\\.|[^"\\])*")$/u.exec(value);
    if (resource) return JSON.parse(resource[1]);
    if (value.startsWith('"') && value.endsWith('"')) {
        try {
            return JSON.parse(value);
        }
        catch {
            return value.slice(1, -1);
        }
    }
    return value;
}

export function parseSource2EntityDump(text) {
    if (typeof text !== 'string' || text.length === 0) throw new Error('Empty Source 2 entity dump.');
    const headers = [...text.matchAll(entityHeader)];
    if (headers.length === 0) throw new Error('Source 2 entity dump has no decompiler entity blocks.');
    return headers.map((header, index) => {
        const start = header.index + header[0].length;
        const end = headers[index + 1]?.index ?? text.length;
        const block = text.slice(start, end);
        const entity = Object.create(null);
        for (const match of block.matchAll(propertyLine)) {
            const key = match[1].toLowerCase();
            if (Object.hasOwn(entity, key)) throw new Error(`Duplicate Source 2 entity property: ${key}`);
            entity[key] = decodeValue(match[2]);
        }
        return entity;
    }).filter(entity => typeof entity.classname === 'string');
}

export function parseEntityVector(value, name = 'entity') {
    if (typeof value !== 'string') throw new Error(`Missing ${name} vector.`);
    const numbers = value.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/giu)?.map(Number) || [];
    if (numbers.length !== 3 || !numbers.every(Number.isFinite)) throw new Error(`Invalid ${name} vector.`);
    return numbers;
}

export function parseEntityBoolean(value, fallback = false) {
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    throw new Error('Invalid Source 2 entity boolean.');
}