import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = path.join(root, 'npm-packages');
const readJson = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const writeJson = (filename, value) => fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`);
const dataPackagesHomepage = sourcePackage => `${sourcePackage.homepage.replace(/#.*$/u, '')}#data-only-packages`;

function copyAsset(rootDirectory, destinationDirectory, entry) {
    const source = path.join(rootDirectory, 'assets', ...entry.path.split('/'));
    const destination = path.join(destinationDirectory, 'assets', ...entry.path.split('/'));
    if (!fs.existsSync(source)) throw new Error(`Manifest asset is missing: ${entry.path}`);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
}

function packageImages(patchId, entries) {
    const packageImageNames = new Set(['map_data.png', 'illustrated.jpg', 'screenshot.jpg']);
    const minimapImageNames = new Set(['simple.png', 'detailed.png']);
    return entries.filter(({ path: assetPath }) => {
        const prefix = `img/${patchId}/`;
        if (!assetPath.startsWith(prefix)) return false;
        const relativePath = assetPath.slice(prefix.length);
        return packageImageNames.has(relativePath)
            || (relativePath.startsWith('minimaps/') && minimapImageNames.has(relativePath.slice('minimaps/'.length)));
    });
}

function dataPackageExports(patchId, images, skins, currentPatchId) {
    const exports = {
        './data/*': './assets/data/' + patchId + '/*',
        './image/*': './assets/img/' + patchId + '/*',
        ['./' + patchId]: './assets/data/' + patchId + '/mapdata.json',
        ['./' + patchId + '/mapdata.json']: './assets/data/' + patchId + '/mapdata.json',
        ['./' + patchId + '/worlddata.json']: './assets/data/' + patchId + '/worlddata.json',
        ['./' + patchId + '/*']: './assets/data/' + patchId + '/*',
        './latest': './assets/data/' + patchId + '/mapdata.json',
        './latest/*': './assets/data/' + patchId + '/*',
        './latest/mapdata.json': './assets/data/' + patchId + '/mapdata.json',
        './latest/worlddata.json': './assets/data/' + patchId + '/worlddata.json',
        './manifest.json': './manifest.json',
        './package.json': './package.json',
    };
    const hasMinimaps = images.some(image => image.path.startsWith('img/' + patchId + '/minimaps/'));
    if (hasMinimaps) {
        exports['./' + patchId + '/minimaps/*'] = './assets/img/' + patchId + '/minimaps/*';
        exports['./latest/minimaps/*'] = './assets/img/' + patchId + '/minimaps/*';
    }
    for (const image of images) {
        exports['./latest/' + path.posix.basename(image.path)] = './assets/' + image.path;
    }
    for (const skin of skins) {
        exports['./images/' + patchId + '/' + skin.id] = './skin-exports/' + patchId + '/' + skin.id + '.mjs';
        if (patchId === currentPatchId) {
            exports['./images/latest/' + skin.id] = './skin-exports/' + patchId + '/' + skin.id + '.mjs';
        }
    }
    if (skins.length > 0) {
        exports['./images/' + patchId] = './skin-exports/' + patchId + '/index.mjs';
        if (patchId === currentPatchId) {
            exports['./images/latest'] = './skin-exports/' + patchId + '/latest.mjs';
        }
    }
    return exports;
}

const skinPackageName = skin => skin.packageName ?? skin.name;

function aggregateSkinPackage({ name, patchId, skins, sourcePackage, latest = false }) {
    const dependencies = Object.fromEntries(skins.map(skin => [skinPackageName(skin), `^${sourcePackage.version}`]));
    return {
        id: latest ? 'latest' : patchId,
        name,
        patchId,
        skins,
        packageJson: {
            name,
            version: sourcePackage.version,
            description: `Installs the optional Dota terrain skin packages for ${latest ? 'the current patch' : 'patch ' + patchId}.`,
            repository: sourcePackage.repository,
            homepage: dataPackagesHomepage(sourcePackage),
            type: 'module',
            files: ['index.mjs', 'README.md'],
            exports: { '.': './index.mjs', './package.json': './package.json' },
            dependencies,
            publishConfig: { access: 'public' },
        },
    };
}

function allSkinsModule(skins) {
    const imports = skins.map((skin, index) =>
        `import skin${index} from ${JSON.stringify(skinPackageName(skin) + '/image/' + path.posix.basename((skin.file ?? skin.image).path))};`);
    const exports = skins.filter(skin => skin.id !== 'default')
        .map(skin => `export { skin${skins.indexOf(skin)} as ${skin.id} };`);
    const objectEntries = skins.map((skin, index) => `${JSON.stringify(skin.id)}: skin${index}`);
    return [
        ...imports,
        ...exports,
        `export default Object.freeze({ ${objectEntries.join(', ')} });`,
        '',
    ].join('\n');
}

function aggregateReexportModule(packageName) {
    return `export { default } from ${JSON.stringify(packageName)};\nexport * from ${JSON.stringify(packageName)};\n`;
}

function corePackageJson(sourcePackage) {
    const result = structuredClone(sourcePackage);
    result.files = ['dist/', 'manifest.json', 'scripts/', 'src/', 'README.md'];
    result.exports = Object.fromEntries(Object.entries(result.exports)
        .filter(([subpath]) => subpath !== './data/*' && subpath !== './image/*'
            && !subpath.startsWith('./latest/')
            && !subpath.startsWith('./images/')));
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
    const shared = [];
    const patchPackages = manifest.patches.map(patch => {
        const worldDataPath = `data/${patch.id}/worlddata.json`;
        if (!patch.files.some(entry => entry.path === worldDataPath)) {
            throw new Error(`Patch ${patch.id} is missing ${worldDataPath}; version packages require patch-specific bounds.`);
        }
        const images = packageImages(patch.id, manifest.images);
        const skins = manifest.skinPackages.filter(skin => skin.patchId === patch.id);
        const packageName = patch.packageName ?? `@reino-doce/dota-maps-data-${patch.id}`;
        const packageJson = {
            name: packageName,
            version: sourcePackage.version,
            description: `Prebuilt Dota 2 map data and required images for game patch ${patch.id}.`,
            repository: sourcePackage.repository,
            homepage: `${sourcePackage.homepage.replace(/#.*$/u, '')}/tree/main/assets/data/${patch.id}`,
            type: 'module',
            files: ['assets/', 'manifest.json', 'README.md', 'skin-exports/'],
            exports: dataPackageExports(patch.id, images, skins, manifest.currentPatch),
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
        return { id: patch.id, name: packageName, packageJson, patch, shared, images, skins, subsetManifest };
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
            homepage: dataPackagesHomepage(sourcePackage),
            exports: {
                ...currentPatchPackage.packageJson.exports,
                ...Object.fromEntries(currentPatchPackage.skins.map(skin => [
                    './images/latest/' + skin.id,
                    './skin-exports/' + manifest.currentPatch + '/' + skin.id + '.mjs',
                ])),
            },
        },
        subsetManifest: {
            ...currentPatchPackage.subsetManifest,
            packageName: manifest.latestPackage.packageName,
        },
    };
    const skinPackages = manifest.skinPackages.map(skin => {
        const filename = path.posix.basename(skin.file.path);
        const packageJson = {
            name: skin.packageName,
            version: sourcePackage.version,
            description: `Optional Dota terrain image asset for patch ${skin.patchId}: ${skin.id}.`,
            repository: sourcePackage.repository,
            homepage: dataPackagesHomepage(sourcePackage),
            type: 'module',
            files: ['assets/', 'manifest.json', 'README.md'],
            exports: {
                './image/*': './assets/img/' + skin.patchId + '/*',
                ['./image/' + filename]: './assets/' + skin.file.path,
                ['./' + skin.patchId + '/' + skin.id]: './assets/' + skin.file.path,
                './manifest.json': './manifest.json',
                './package.json': './package.json',
            },
            publishConfig: { access: 'public' },
        };
        if (skin.patchId === manifest.currentPatch) {
            packageJson.exports['./latest/' + skin.id + '/' + filename] = './assets/' + skin.file.path;
        }
        return {
            id: skin.id,
            name: skin.packageName,
            packageJson,
            patchId: skin.patchId,
            image: skin.file,
            subsetManifest: { schemaVersion: manifest.schemaVersion, patch: skin.patchId, image: skin.file },
        };
    });
    const skinSetPackages = Object.entries(manifest.skinSetPackages ?? {}).map(([patchId, packageName]) => {
        const skins = skinPackages.filter(skin => skin.patchId === patchId);
        return aggregateSkinPackage({ name: packageName, patchId, skins, sourcePackage });
    });
    const currentPatchSkins = skinPackages.filter(skin => skin.patchId === manifest.currentPatch);
    const skinsAggregatePackage = aggregateSkinPackage({
        name: manifest.latestSkinsPackageName,
        patchId: manifest.currentPatch,
        skins: currentPatchSkins,
        sourcePackage,
        latest: true,
    });
    return {
        sourcePackage,
        manifest,
        corePackageJson: corePackageJson(sourcePackage),
        patchPackages,
        latestPackage,
        packages: [...patchPackages, latestPackage],
        skinPackages,
        skinSetPackages,
        skinsAggregatePackages: [...skinSetPackages, skinsAggregatePackage],
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
        for (const skin of item.skins) {
            const wrapper = path.join(packageDirectory, 'skin-exports', item.patch.id, skin.id + '.mjs');
            fs.mkdirSync(path.dirname(wrapper), { recursive: true });
            fs.writeFileSync(wrapper,
                `export { default } from ${JSON.stringify(skin.packageName + '/image/' + path.posix.basename(skin.file.path))};\n`);
        }
        if (item.skins.length > 0) {
            const wrapperDirectory = path.join(packageDirectory, 'skin-exports', item.patch.id);
            const versionAggregate = plan.skinSetPackages.find(skinSet => skinSet.patchId === item.patch.id);
            if (!versionAggregate) throw new Error(`Missing aggregate skin package for patch ${item.patch.id}.`);
            fs.writeFileSync(path.join(wrapperDirectory, 'index.mjs'), aggregateReexportModule(versionAggregate.name));
            if (item.patch.id === plan.manifest.currentPatch) {
                fs.writeFileSync(path.join(wrapperDirectory, 'latest.mjs'), aggregateReexportModule(plan.skinsAggregatePackage.name));
            }
        }
        writeJson(path.join(packageDirectory, 'package.json'), item.packageJson);
        writeJson(path.join(packageDirectory, 'manifest.json'), item.subsetManifest);
        const readme = item.id === 'latest'
            ? '# Latest Dota map data\n\nThis data-only package contains the current Dota 2 patch (' + item.patch.id + ') and required map images. It has no runtime or generation dependencies.\n\nInstall with npm install ' + item.name + '. Import JSON from ' + item.name + '/latest/mapdata.json or /' + item.patch.id + '/mapdata.json, and essential images from ' + item.name + '/latest/<image>. Optional terrain images are separate packages: install @reino-doce/dota-map-skin-<patch>-<skin> to use /images/latest/<skin>, or @reino-doce/dota-map-skins-latest to import all skins from /images/latest.\n'
            : '# Dota map data: ' + item.id + '\n\nThis data-only package contains the Dota 2 patch ' + item.id + ' and required map images. It has no runtime or generation dependencies.\n\nInstall with npm install ' + item.name + '. Import JSON from ' + item.name + '/latest/mapdata.json or /' + item.patch.id + '/mapdata.json, and essential images from ' + item.name + '/latest/<image>. Optional terrain images are separate packages: install @reino-doce/dota-map-skin-<patch>-<skin> to import one skin, or @reino-doce/dota-map-skins-<patch> for all skins.\n';
        fs.writeFileSync(path.join(packageDirectory, 'README.md'), readme);
    }
    for (const item of plan.skinPackages) {
        const packageDirectory = path.join(expectedDestination, item.name.slice('@reino-doce/'.length));
        copyAsset(sourceRoot, packageDirectory, item.image);
        writeJson(path.join(packageDirectory, 'package.json'), item.packageJson);
        writeJson(path.join(packageDirectory, 'manifest.json'), item.subsetManifest);
        const readme = '# Dota terrain skin: ' + item.id + '\n\nThis optional package contains only the ' + item.id + ' terrain image for Dota patch ' + item.patchId + '. It does not include map data or generation tools.\n\nInstall with npm install ' + item.name + '. Import the image from ' + item.name + '/image/' + path.posix.basename(item.image.path) + '. To import this skin through a map-data package, also install the matching data package and import its /images/' + item.patchId + '/' + item.id + ' subpath. To install all skins for this patch, use npm install ' + plan.skinSetPackages.find(skinSet => skinSet.patchId === item.patchId)?.name + '.\n';
        fs.writeFileSync(path.join(packageDirectory, 'README.md'), readme);
    }
    for (const item of plan.skinsAggregatePackages) {
        const aggregateDirectory = path.join(expectedDestination, item.name.slice('@reino-doce/'.length));
        fs.mkdirSync(aggregateDirectory, { recursive: true });
        writeJson(path.join(aggregateDirectory, 'package.json'), item.packageJson);
        fs.writeFileSync(path.join(aggregateDirectory, 'index.mjs'), allSkinsModule(item.skins));
        const label = item.id === 'latest' ? 'latest' : item.patchId;
        fs.writeFileSync(path.join(aggregateDirectory, 'README.md'),
            `# Dota terrain skins: ${label}\n\nThis package installs the optional, independent terrain image packages for patch \`${item.patchId}\`. Each image remains its own package. Import the full set from the matching data package's \`/images/${label}\` subpath.\n`);
    }
    return plan.packages.concat(plan.skinPackages, plan.skinsAggregatePackages).map(item => ({
        name: item.name,
        path: path.join(expectedDestination, item.name.slice('@reino-doce/'.length)),
    }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const packages = prepareNpmPackages();
    console.log(`Prepared ${packages.length} data-only packages and the runtime package in ${outputDirectory}`);
}
