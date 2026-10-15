import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const assetRoot = path.join(packageRoot, 'assets');
const require = createRequire(import.meta.url);
const manifestPath = path.join(packageRoot, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const safePath = value => typeof value === 'string' && value.length > 0
    && !path.isAbsolute(value) && !value.split(/[\\/]+/u).includes('..');

function patchForAsset(relativePath) {
    const dataMatch = /^data\/([a-z0-9]+)\//iu.exec(relativePath);
    if (dataMatch) return dataMatch[1];
    const skinMatch = /^img\/skins\/([a-z0-9]+)\//iu.exec(relativePath);
    if (skinMatch) return skinMatch[1];
    const imageMatch = /^img\/(?:map_data_|dota-map-|dota-game-map-)([a-z0-9]+)\./iu.exec(relativePath);
    if (imageMatch) return imageMatch[1];
    if (relativePath === 'img/map_data.png') return '688';
    return null;
}

function latestImagePath(filename) {
    const patch = manifest.currentPatch;
    const aliases = new Map([
        ['map_data.png', patch === '688' ? 'img/map_data.png' : 'img/map_data_' + patch + '.png'],
        ['dota-map.png', 'img/dota-map-' + patch + '.png'],
        ['dota-game-map.jpg', 'img/dota-game-map-' + patch + '.jpg'],
    ]);
    const assetPath = aliases.get(filename) ?? 'img/' + filename;
    const allowedPaths = new Set([
        patch === '688' ? 'img/map_data.png' : 'img/map_data_' + patch + '.png',
        'img/dota-map-' + patch + '.png',
        'img/dota-game-map-' + patch + '.jpg',
    ]);
    return allowedPaths.has(assetPath) && manifest.images.some(image => image.path === assetPath)
        ? assetPath
        : null;
}

function resolveAssetRequest(relativePath) {
    const latestData = /^data\/latest\/(.+)$/iu.exec(relativePath);
    if (latestData) {
        return {
            assetPath: 'data/' + manifest.currentPatch + '/' + latestData[1],
            packageSelector: 'latest',
        };
    }
    if (relativePath === 'latest/mapdata.json') {
        return { assetPath: 'data/' + manifest.currentPatch + '/mapdata.json', packageSelector: 'latest' };
    }

    const latestSkin = /^latest\/([a-z0-9]+)\/([^/]+)$/iu.exec(relativePath);
    if (latestSkin) {
        const [skinId, filename] = latestSkin.slice(1);
        const skin = manifest.skinPackages.find(entry => entry.id === skinId);
        if (!skin || path.posix.basename(skin.file.path) !== filename) {
            throw new Error('Unknown latest skin image ' + relativePath + '.');
        }
        return { assetPath: skin.file.path, skinId };
    }

    const latestImage = /^latest\/([^/]+)$/iu.exec(relativePath);
    if (latestImage) {
        const assetPath = latestImagePath(latestImage[1]);
        if (!assetPath) throw new Error('Unknown latest map image ' + relativePath + '.');
        return { assetPath, packageSelector: 'latest' };
    }
    return { assetPath: relativePath };
}

function installedPatchAssets(patch) {
    const candidates = patch === 'latest'
        ? [manifest.latestPackage.packageName, '@reino-doce/dota-maps-data-' + manifest.currentPatch]
        : ['@reino-doce/dota-maps-data-' + patch,
            ...(patch === manifest.currentPatch ? [manifest.latestPackage.packageName] : [])];
    for (const packageName of candidates) {
        try {
            const packageFile = require.resolve(packageName + '/package.json');
            return path.dirname(packageFile);
        } catch (error) {
            if (error?.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED' && error?.code !== 'MODULE_NOT_FOUND') throw error;
        }
    }
    return null;
}

function installedSkinAsset(relativePath, requestedSkinId = null) {
    const match = /^img\/skins\/[a-z0-9]+\/(dota(?:_[a-z0-9]+)?\.png)$/iu.exec(relativePath);
    if (!match) return null;
    const filename = match[1];
    const stem = filename.replace(/\.png$/iu, '');
    const skinId = requestedSkinId
        ?? (stem === 'dota' ? 'base' : stem.replace(/^dota_/iu, ''));
    const skin = manifest.skinPackages.find(entry => entry.id === skinId);
    if (!skin || path.posix.basename(skin.file.path) !== filename) return null;
    try {
        const packageFile = require.resolve(skin.packageName + '/package.json');
        return path.join(path.dirname(packageFile), 'assets', relativePath);
    } catch (error) {
        if (error?.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED' && error?.code !== 'MODULE_NOT_FOUND') throw error;
        return null;
    }
}

function missingAssetError(relativePath, patch) {
    const targetPatch = patch === 'latest' ? manifest.currentPatch : patch;
    const packageName = patch === 'latest'
        ? manifest.latestPackage.packageName
        : '@reino-doce/dota-maps-data-' + targetPatch;
    return new Error('Map asset ' + relativePath + ' is not installed. Add ' + packageName + ' to the consumer dependencies.');
}

export function resolveAssetPath(relativePath) {
    if (!safePath(relativePath)) throw new TypeError('Map asset paths must stay inside the package.');
    const normalizedPath = relativePath.replaceAll('\\', '/');
    const request = resolveAssetRequest(normalizedPath);
    const localPath = path.join(assetRoot, request.assetPath);
    if (fs.existsSync(localPath)) return localPath;

    if (request.skinId || request.assetPath.startsWith('img/skins/')) {
        const skinPath = installedSkinAsset(request.assetPath, request.skinId ?? null);
        if (skinPath && fs.existsSync(skinPath)) return skinPath;
        const skinId = request.skinId ?? (path.posix.basename(request.assetPath, '.png').replace(/^dota_?/iu, '') || 'base');
        throw new Error('Map skin asset ' + relativePath + ' is not installed. Add @reino-doce/dota-map-skin-' + skinId + ' or @reino-doce/dota-map-skins-latest.');
    }

    const patch = request.packageSelector ?? patchForAsset(request.assetPath);
    if (patch) {
        const installedRoot = installedPatchAssets(request.packageSelector ?? patch);
        if (installedRoot) {
            const packagePath = path.join(installedRoot, 'assets', request.assetPath);
            if (fs.existsSync(packagePath)) return packagePath;
        }
        throw missingAssetError(relativePath, request.packageSelector ?? patch);
    }
    return localPath;
}

export function readMapData(patch, name = 'mapdata.json') {
    if (typeof patch !== 'string' || !/^(?:latest|[a-z0-9]+)$/iu.test(patch) || !safePath(name)) {
        throw new TypeError('A patch ID and package-relative map data path are required.');
    }
    return JSON.parse(fs.readFileSync(resolveAssetPath(path.join('data', patch, name)), 'utf8'));
}

export function readMapManifest() {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}
