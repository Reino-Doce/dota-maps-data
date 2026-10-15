import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = path.join(root, 'npm-packages');
const readJson = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const writeJson = (filename, value) => fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`);

function copyAsset(rootDirectory, destinationDirectory, entry) {
    const source = path.join(rootDirectory, 'assets', ...entry.path.split('/'));
    const destination = path.join(destinationDirectory, 'assets', ...entry.path.split('/'));
    if (!fs.existsSync(source)) throw new Error(`Manifest asset is missing: ${entry.path}`);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
}

function packageImages(patchId, entries) {
    return entries.filter(({ path: assetPath }) => {
        if (assetPath.startsWith('img/skins/')) return false;
        if (assetPath === `img/map_data_${patchId}.png`) return true;
        if (assetPath === `img/map_data.png`) return patchId === '688';
        if (assetPath === `img/dota-map-${patchId}.png` || assetPath === `img/dota-game-map-${patchId}.jpg`) return true;
        return false;
    });
}

function dataPackageExports(patchId, images) {
    const exports = {
        './data/legacy/*': './assets/data/legacy/*',
        './data/*': './assets/data/' + patchId + '/*',
        './image/*': './assets/img/*',
        './latest/mapdata.json': './assets/data/' + patchId + '/mapdata.json',
        './manifest.json': './manifest.json',
        './package.json': './package.json',
    };
    for (const image of images) {
        exports['./latest/' + path.posix.basename(image.path)] = './assets/' + image.path;
    }
    const aliases = [
        ['./latest/map_data.png', patchId === '688' ? 'img/map_data.png' : 'img/map_data_' + patchId + '.png'],
        ['./latest/dota-map.png', 'img/dota-map-' + patchId + '.png'],
        ['./latest/dota-game-map.jpg', 'img/dota-game-map-' + patchId + '.jpg'],
    ];
    for (const [subpath, assetPath] of aliases) {
        if (images.some(image => image.path === assetPath)) {
            exports[subpath] = './assets/' + assetPath;
        }
    }
    return exports;
}

function corePackageJson(sourcePackage) {
    const result = structuredClone(sourcePackage);
    result.files = ['assets/data/legacy/', 'dist/', 'manifest.json', 'scripts/', 'src/', 'README.md'];
    result.exports = Object.fromEntries(Object.entries(result.exports)
        .filter(([subpath]) => subpath !== './data/*' && subpath !== './image/*'
            && !subpath.startsWith('./latest/')));
    delete result.devDependencies;
    delete result.packageManager;
    delete result.dotaMapsData;
    delete result.scripts;
    delete result.workspaces;
    return result;
}

export function buildNpmPackagePlan({ sourceRoot = root } = {}) {
    const sourcePackage = readJson(path.join(sourceRoot, 'package.json'));
    const manifest = readJson(path.join(sourceRoot, 'manifest.json'));
    const shared = manifest.shared;
    const patchPackages = manifest.patches.map(patch => {
        const images = packageImages(patch.id, manifest.images);
        const packageName = patch.packageName ?? `@reino-doce/dota-maps-data-${patch.id}`;
        const packageJson = {
            name: packageName,
            version: sourcePackage.version,
            description: `Prebuilt Dota 2 map data and required images for game patch ${patch.id}.`,
            repository: sourcePackage.repository,
            homepage: `${sourcePackage.homepage}/tree/main/assets/data/${patch.id}`,
            type: 'module',
            files: ['assets/', 'manifest.json', 'README.md'],
            exports: dataPackageExports(patch.id, images),
            publishConfig: { access: 'public' },
        };
        const subsetManifest = {
            schemaVersion: manifest.schemaVersion,
            patch: patch.id,
            currentPatch: manifest.currentPatch,
            files: patch.files,
            shared,
            images,
        };
        return { id: patch.id, name: packageName, packageJson, patch, shared, images, subsetManifest };
    });
    const currentPatchPackage = patchPackages.find(item => item.id === manifest.currentPatch);
    if (!currentPatchPackage) throw new Error(`No package plan exists for current patch ${manifest.currentPatch}.`);
    const latestPackage = {
        ...currentPatchPackage,
        id: 'latest',
        name: manifest.latestPackage.packageName,
        packageJson: {
            ...currentPatchPackage.packageJson,
            name: manifest.latestPackage.packageName,
            description: `Prebuilt Dota 2 map data and required images for the current game patch (${manifest.currentPatch}).`,
            homepage: `${sourcePackage.homepage}#data-only-packages`,
            exports: {
                ...currentPatchPackage.packageJson.exports,
                './image/map_data.png': `./assets/img/map_data_${manifest.currentPatch}.png`,
                './image/dota-map.png': `./assets/img/dota-map-${manifest.currentPatch}.png`,
                './image/dota-game-map.jpg': `./assets/img/dota-game-map-${manifest.currentPatch}.jpg`,
            },
        },
        subsetManifest: {
            ...currentPatchPackage.subsetManifest,
            packageName: manifest.latestPackage.packageName,
        },
    };
    const skinPackages = manifest.skinPackages.map(skin => {
        const packageJson = {
            name: skin.packageName,
            version: sourcePackage.version,
            description: `Optional Dota terrain image asset: ${skin.id}.`,
            repository: sourcePackage.repository,
            homepage: `${sourcePackage.homepage}#data-only-packages`,
            type: 'module',
            files: ['assets/', 'manifest.json', 'README.md'],
            exports: {
                './image/*': './assets/img/skins/' + manifest.currentPatch + '/*',
                ['./latest/' + skin.id + '/' + path.posix.basename(skin.file.path)]: './assets/' + skin.file.path,
                './manifest.json': './manifest.json',
                './package.json': './package.json',
            },
            publishConfig: { access: 'public' },
        };
        return {
            id: skin.id,
            name: skin.packageName,
            packageJson,
            patchId: manifest.currentPatch,
            image: skin.file,
            subsetManifest: { schemaVersion: manifest.schemaVersion, patch: manifest.currentPatch, image: skin.file },
        };
    });
    const aggregateDependencies = Object.fromEntries(skinPackages.map(item => [item.name, `^${sourcePackage.version}`]));
    const skinsAggregatePackage = {
        name: manifest.latestSkinsPackageName,
        packageJson: {
            name: manifest.latestSkinsPackageName,
            version: sourcePackage.version,
            description: `Installs the optional Dota terrain skin packages for patch ${manifest.currentPatch}.`,
            repository: sourcePackage.repository,
            homepage: `${sourcePackage.homepage}#data-only-packages`,
            files: ['README.md'],
            dependencies: aggregateDependencies,
            publishConfig: { access: 'public' },
        },
        patchId: manifest.currentPatch,
    };
    return {
        sourcePackage,
        manifest,
        corePackageJson: corePackageJson(sourcePackage),
        patchPackages,
        latestPackage,
        packages: [...patchPackages, latestPackage],
        skinPackages,
        skinsAggregatePackage,
    };
}

export function prepareNpmPackages({ sourceRoot = root, destination = outputDirectory } = {}) {
    const expectedDestination = path.resolve(sourceRoot, 'npm-packages');
    if (path.resolve(destination) !== expectedDestination) {
        throw new Error(`Generated npm packages must stay at ${expectedDestination}`);
    }
    const plan = buildNpmPackagePlan({ sourceRoot });
    fs.rmSync(expectedDestination, { recursive: true, force: true });
    const coreDirectory = path.join(expectedDestination, 'core');
    fs.mkdirSync(coreDirectory, { recursive: true });
    for (const directoryName of ['src', 'dist', 'scripts']) {
        fs.cpSync(path.join(sourceRoot, directoryName), path.join(coreDirectory, directoryName), { recursive: true });
    }
    fs.mkdirSync(path.join(coreDirectory, 'assets', 'data'), { recursive: true });
    fs.cpSync(path.join(sourceRoot, 'assets', 'data', 'legacy'), path.join(coreDirectory, 'assets', 'data', 'legacy'), { recursive: true });
    fs.copyFileSync(path.join(sourceRoot, 'manifest.json'), path.join(coreDirectory, 'manifest.json'));
    fs.copyFileSync(path.join(sourceRoot, 'README.md'), path.join(coreDirectory, 'README.md'));
    writeJson(path.join(coreDirectory, 'package.json'), plan.corePackageJson);

    for (const item of plan.packages) {
        const directoryName = item.name.slice('@reino-doce/'.length);
        const packageDirectory = path.join(expectedDestination, directoryName);
        fs.mkdirSync(packageDirectory, { recursive: true });
        for (const entry of [...item.shared, ...item.patch.files, ...item.images]) {
            copyAsset(sourceRoot, packageDirectory, entry);
        }
        writeJson(path.join(packageDirectory, 'package.json'), item.packageJson);
        writeJson(path.join(packageDirectory, 'manifest.json'), item.subsetManifest);
        const readme = item.id === 'latest'
            ? '# Latest Dota map data\n\nThis data-only package contains the current Dota 2 patch (' + item.patch.id + ') and required map images. It has no runtime or generation dependencies.\n\nInstall with npm install ' + item.name + '. Import JSON from ' + item.name + '/latest/mapdata.json and images from ' + item.name + '/latest/<image>.\n'
            : '# Dota map data: ' + item.id + '\n\nThis data-only package contains the Dota 2 patch ' + item.id + ' and required map images. It has no runtime or generation dependencies.\n\nInstall with npm install ' + item.name + '. Import JSON from ' + item.name + '/latest/mapdata.json and images from ' + item.name + '/latest/<image>.\n';
        fs.writeFileSync(path.join(packageDirectory, 'README.md'), readme);
    }
    for (const item of plan.skinPackages) {
        const packageDirectory = path.join(expectedDestination, item.name.slice('@reino-doce/'.length));
        copyAsset(sourceRoot, packageDirectory, item.image);
        writeJson(path.join(packageDirectory, 'package.json'), item.packageJson);
        writeJson(path.join(packageDirectory, 'manifest.json'), item.subsetManifest);
        const readme = '# Dota terrain skin: ' + item.id + '\n\nThis optional package contains only the ' + item.id + ' terrain image for Dota patch ' + item.patchId + '. It does not include map data or generation tools.\n\nInstall with npm install ' + item.name + '. Import the image from ' + item.name + '/latest/' + item.id + '/' + path.posix.basename(item.image.path) + '. To install all current skins, use npm install ' + plan.skinsAggregatePackage.name + '.\n';
        fs.writeFileSync(path.join(packageDirectory, 'README.md'), readme);
    }
    const aggregateDirectory = path.join(expectedDestination, plan.skinsAggregatePackage.name.slice('@reino-doce/'.length));
    fs.mkdirSync(aggregateDirectory, { recursive: true });
    writeJson(path.join(aggregateDirectory, 'package.json'), plan.skinsAggregatePackage.packageJson);
    fs.writeFileSync(path.join(aggregateDirectory, 'README.md'), `# Latest Dota terrain skins\n\nThis small metapackage installs the optional, independent terrain image packages for patch \`${plan.skinsAggregatePackage.patchId}\`. Each image remains its own package so map-data consumers do not download skins they do not need.\n`);
    return plan.packages.concat(plan.skinPackages, [plan.skinsAggregatePackage]).map(item => ({
        name: item.name,
        path: path.join(expectedDestination, item.name.slice('@reino-doce/'.length)),
    }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const packages = prepareNpmPackages();
    console.log(`Prepared ${packages.length} data-only packages and the runtime package in ${outputDirectory}`);
}
