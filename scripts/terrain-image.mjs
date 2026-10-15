import { PNG } from 'pngjs';

// Optional Source Filmmaker TGA exports: handle both true-color encodings and
// every TGA origin without resampling the map pixels.
export function decodeTga(bytes) {
    if (bytes.length < 18 || bytes[1] !== 0 || ![2, 10].includes(bytes[2]) || ![24, 32].includes(bytes[16])) {
        throw new Error('Expected a 24/32-bit true-color TGA from the game renderer.');
    }
    const width = bytes.readUInt16LE(12);
    const height = bytes.readUInt16LE(14);
    if (!width || !height || width * height > 100_000_000) throw new Error('Invalid TGA dimensions.');
    const channels = bytes[16] / 8;
    const png = new PNG({ width, height });
    let offset = 18 + bytes[0];
    let pixel = 0;
    const color = () => {
        if (offset + channels > bytes.length) throw new Error('Truncated TGA pixels.');
        const value = [bytes[offset + 2], bytes[offset + 1], bytes[offset], channels === 4 ? bytes[offset + 3] : 255];
        offset += channels;
        return value;
    };
    const write = value => {
        if (pixel >= width * height) throw new Error('TGA packet exceeds the image size.');
        const x = bytes[17] & 16 ? width - 1 - pixel % width : pixel % width;
        const y = bytes[17] & 32 ? Math.floor(pixel / width) : height - 1 - Math.floor(pixel / width);
        png.data.set(value, (y * width + x) * 4);
        pixel += 1;
    };
    while (pixel < width * height) {
        if (bytes[2] === 2) write(color());
        else {
            if (offset >= bytes.length) throw new Error('Truncated TGA packet.');
            const header = bytes[offset];
            offset += 1;
            const count = (header & 127) + 1;
            if (header & 128) {
                const value = color();
                for (let i = 0; i < count; i++) write(value);
            }
            else for (let i = 0; i < count; i++) write(color());
        }
    }
    return png;
}

export function assertUsableImage(png) {
    let min = 255;
    let max = 0;
    let opaque = 0;
    let magenta = 0;
    for (let i = 0; i < png.data.length; i += 4) {
        min = Math.min(min, png.data[i], png.data[i + 1], png.data[i + 2]);
        max = Math.max(max, png.data[i], png.data[i + 1], png.data[i + 2]);
        if (png.data[i + 3] > 0) {
            opaque += 1;
            if (png.data[i] > 180 && png.data[i + 1] < 75 && png.data[i + 2] > 180) magenta += 1;
        }
    }
    if (max - min < 8 || opaque < png.width * png.height / 10) throw new Error('Game renderer produced an empty image.');
    // Reef's underwater pass can export magenta artifacts before its resources
    // are initialized. Reject a broad error pattern, allowing isolated flowers.
    if (magenta / opaque > 0.001) throw new Error('Magenta artifacts in game renderer output. Initialize the terrain in the game, reopen the SFM session and export again.');
}
