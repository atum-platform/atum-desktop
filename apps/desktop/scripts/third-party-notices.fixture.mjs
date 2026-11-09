// Test fixture for third-party-notices.mjs: a small packaged app (Contents/Frameworks, and in
// Resources the licence texts as extraResources leaves them, a staged engine and a bundle), the
// two catalogs, a repository (lockfile and node_modules) and an installed electron package.
// Never shipped; used by the notice, after-pack and audit tests.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { REQUIRED_LICENSE_TEXTS, writeThirdPartyNotices } from './third-party-notices.mjs'

export const FIXTURE_ENGINE_COMMIT = 'a'.repeat(40)
export const FIXTURE_ELECTRON_VERSION = '40.10.2'
export const FIXTURE_FRAMEWORKS = [
  'Electron Framework.framework',
  'Fixture Helper (GPU).app',
  'Fixture Helper.app',
  'Squirrel.framework'
]

function write(file, content) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, content)
}

export function fixtureCatalog(overrides = {}) {
  return {
    schema: 'atum.engine-components/1',
    engine: {
      name: 'Atum Drive engine',
      sourceCommit: FIXTURE_ENGINE_COMMIT,
      sourceUrl: 'https://example.test/engine/tree/drive-engine-1',
      sourceTag: 'drive-engine-1',
      sourceTagCommit: 'c'.repeat(40),
      buildingUrl: 'https://example.test/engine/blob/drive-engine-1/BUILDING.md',
      instructionsUrl: 'https://example.test/engine/blob/main/BUILDING.md',
      releaseUrl: 'https://example.test/engine/releases/tag/drive-engine-1'
    },
    components: [
      {
        id: 'engine',
        name: 'Fixture engine',
        version: '1.0.0',
        license: 'GPL-2.0-or-later',
        copyright: ['Copyright the fixture authors'],
        source: 'engine',
        licenseFiles: ['texts/GPL-2.0.txt', 'texts/GPL-3.0.txt'],
        files: ['MacOS/Engine', 'PlugIns/engine_plugin.so'],
        includes: [
          {
            name: 'Fixture Icons',
            version: '2.0',
            where: 'embedded in the engine',
            license: 'OFL-1.1',
            copyright: ['Copyright the icon authors'],
            licenseFiles: ['engine/icons-LICENSE.txt', 'texts/OFL-1.1.txt']
          }
        ]
      },
      {
        id: 'qt',
        name: 'Qt',
        version: '6.0.0',
        license: 'LGPL-3.0-only',
        copyright: ['Copyright The Qt Company Ltd.'],
        source: 'https://example.test/engine/releases/tag/drive-engine-1',
        notes: ['Built with the fixture patches applied to qtbase.'],
        sourceArchives: [
          { url: 'https://example.test/engine/releases/download/drive-engine-1/qtbase.tar.xz', sha256: 'd'.repeat(64) }
        ],
        licenseFiles: ['texts/LGPL-3.0.txt', 'texts/GPL-3.0.txt', 'engine/qt-third-party.txt'],
        files: ['Frameworks/Qt*.framework', 'PlugIns/platforms/libqcocoa.dylib']
      },
      {
        id: 'zlib',
        name: 'zlib',
        version: '1.3.1',
        license: 'Zlib',
        copyright: ['Copyright Jean-loup Gailly and Mark Adler'],
        source: 'https://example.test/zlib',
        licenseFiles: ['engine/zlib-LICENSE.txt'],
        files: ['Frameworks/libz.1.dylib']
      },
      {
        id: 'artwork',
        name: 'Artwork',
        version: '1.0.0',
        license: 'CC0-1.0',
        copyright: ['Public domain'],
        source: 'engine',
        licenseFiles: ['texts/CC0-1.0.txt'],
        files: ['Resources/icon.icns']
      }
    ],
    ...overrides
  }
}

/** The rest of the app: its base, Contents/Frameworks, a Rust notice and one bundle. */
export function fixtureAppCatalog(overrides = {}) {
  return {
    schema: 'atum.app-components/1',
    base: {
      name: 'Fixture Base',
      license: 'MIT',
      copyright: ['Copyright the base authors'],
      source: 'https://example.test/base',
      text: 'The fixture app is built from Fixture Base.',
      licenseFiles: ['app/base-LICENSE.txt'],
      includes: []
    },
    electron: {
      version: FIXTURE_ELECTRON_VERSION,
      source: 'https://example.test/electron',
      chromiumVersion: '144.0.0.1',
      chromiumSource: 'https://example.test/chromium',
      ffmpegSource: 'https://example.test/ffmpeg'
    },
    frameworks: [
      {
        id: 'electron',
        name: 'Electron Framework and helpers',
        coveredBy: 'electron',
        files: ['Electron Framework.framework', '* Helper.app', '* Helper (GPU).app']
      },
      {
        id: 'squirrel',
        name: 'Squirrel',
        version: 'commit 1',
        license: 'MIT',
        copyright: ['Copyright squirrel authors'],
        source: 'https://example.test/squirrel',
        licenseFiles: ['app/squirrel-LICENSE.txt'],
        files: ['Squirrel.framework']
      }
    ],
    rust: [{ package: 'left-pad', version: '1.3.0', what: 'a fixture wasm', file: 'rust/left-pad-1.3.0.txt' }],
    bundles: [
      {
        id: 'fixture-runtime',
        folder: 'fixture-runtime',
        title: 'The Python runtime of the fixture agent',
        pins: [{ file: 'fixture-runtime/manifest.json', key: 'python.version', value: '3.14.7' }],
        components: [
          {
            name: 'CPython',
            version: '3.14.7',
            license: 'Python-2.0',
            source: 'https://example.test/python',
            shippedFiles: ['fixture-runtime/LICENSE.txt'],
            files: ['fixture-runtime/lib/libpython.dylib'],
            licenseFiles: ['runtime/LICENSE.zlib.txt'],
            attachedFiles: ['rust/agent-1.0.0.txt']
          }
        ]
      },
      {
        id: 'not-shipped',
        folder: 'not-shipped',
        title: 'A bundle this package does not ship',
        components: [
          { name: 'Ghost', license: 'MIT', source: 'https://example.test/ghost', licenseFiles: ['texts/MIT.txt'] }
        ]
      }
    ],
    ...overrides
  }
}

/** Contents/Frameworks beside Resources, and the bundle the fixture app catalog lists. */
export function writeAppFixture(resources, { frameworks = FIXTURE_FRAMEWORKS, pythonVersion = '3.14.7' } = {}) {
  for (const name of frameworks) {
    write(path.join(resources, '..', 'Frameworks', name, 'Info.plist'), `${name}\n`)
  }

  write(
    path.join(resources, 'fixture-runtime', 'manifest.json'),
    JSON.stringify({ python: { version: pythonVersion } })
  )
  write(path.join(resources, 'fixture-runtime', 'LICENSE.txt'), 'Python licence\n')
  write(path.join(resources, 'fixture-runtime', 'lib', 'libpython.dylib'), 'libpython\n')
}

/** The lockfile and installed packages of a repository whose apps/desktop ships `left-pad`
 * (MIT, with a licence file), `no-file` (MIT, without one) and, through the bundle only, `dev-sdk`. */
export function writeRepositoryFixture(repoRoot) {
  const lock = {
    name: 'fixture',
    lockfileVersion: 3,
    packages: {
      '': { workspaces: ['apps/*'] },
      'apps/desktop': {
        dependencies: { 'left-pad': '^1.0.0', 'no-file': '^2.0.0', '@hermes/shared': 'file:../shared' },
        optionalDependencies: { 'other-os-binary': '1.0.0' },
        devDependencies: { 'dev-sdk': '3.0.0', 'build-tool': '1.0.0' }
      },
      'apps/shared': { dependencies: { 'shared-dep': '^1.0.0' } },
      'node_modules/@hermes/shared': { resolved: 'apps/shared', link: true },
      'node_modules/left-pad': { version: '1.3.0', license: 'MIT', dependencies: { 'nested-dep': '^2.0.0' } },
      'node_modules/left-pad/node_modules/nested-dep': { version: '2.1.0', license: 'ISC' },
      'node_modules/nested-dep': { version: '1.0.0', license: 'ISC', dev: true },
      'node_modules/no-file': { version: '2.0.0', license: 'MIT' },
      'node_modules/shared-dep': { version: '1.2.0', license: 'BSD-3-Clause' },
      'node_modules/other-os-binary': { version: '1.0.0', license: 'MIT', optional: true, os: ['win32'] },
      'node_modules/dev-sdk': { version: '3.0.0', license: 'Apache-2.0', dev: true },
      'node_modules/build-tool': { version: '1.0.0', license: 'MIT', dev: true }
    }
  }

  write(path.join(repoRoot, 'package-lock.json'), JSON.stringify(lock))
  const install = (lockPath, manifest, files = {}) => {
    write(path.join(repoRoot, lockPath, 'package.json'), JSON.stringify(manifest))

    for (const [name, content] of Object.entries(files)) {
      write(path.join(repoRoot, lockPath, name), content)
    }
  }

  install(
    'node_modules/left-pad',
    { name: 'left-pad', version: '1.3.0', license: 'MIT' },
    { LICENSE: 'Copyright (c) left-pad authors\nMIT terms\n' }
  )
  install(
    'node_modules/left-pad/node_modules/nested-dep',
    { name: 'nested-dep', version: '2.1.0', license: 'ISC' },
    { 'LICENSE.md': 'ISC terms of nested-dep\n' }
  )
  install(
    'node_modules/nested-dep',
    { name: 'nested-dep', version: '1.0.0', license: 'ISC' },
    { LICENSE: 'old nested-dep\n' }
  )
  install('node_modules/no-file', {
    name: 'no-file',
    version: '2.0.0',
    license: 'MIT',
    author: 'No File Author <someone@example.test>'
  })
  install(
    'node_modules/shared-dep',
    { name: 'shared-dep', version: '1.2.0', license: 'BSD-3-Clause' },
    { 'LICENSE.txt': 'BSD terms of shared-dep\n' }
  )
  install(
    'node_modules/dev-sdk',
    { name: 'dev-sdk', version: '3.0.0', license: 'Apache-2.0' },
    { LICENSE: 'Apache terms of dev-sdk\n', NOTICE: 'dev-sdk NOTICE\n' }
  )
  install(
    'node_modules/build-tool',
    { name: 'build-tool', version: '1.0.0', license: 'MIT' },
    { LICENSE: 'build tool\n' }
  )
  write(path.join(repoRoot, 'apps/desktop/package.json'), JSON.stringify({ name: 'desktop' }))
  install(
    'apps/desktop/node_modules/electron',
    { name: 'electron', version: FIXTURE_ELECTRON_VERSION },
    {
      'dist/LICENSE': 'Copyright (c) Electron contributors\nMIT terms of Electron\n',
      'dist/LICENSES.chromium.html': '<!doctype html><title>Credits</title><p>Chromium credits</p>\n'
    }
  )
}

/** A staged engine: Resources/drive-engine/{manifest.json, Engine.app}. */
export function writeEngineFixture(resources, { sourceCommit = FIXTURE_ENGINE_COMMIT, extra = [] } = {}) {
  const engine = path.join(resources, 'drive-engine')
  const contents = path.join(engine, 'Engine.app', 'Contents')
  write(
    path.join(engine, 'manifest.json'),
    JSON.stringify({ sourceCommit, binary: 'Engine.app/Contents/MacOS/Engine' })
  )

  for (const file of [
    'Info.plist',
    'PkgInfo',
    '_CodeSignature/CodeResources',
    'MacOS/Engine',
    'Frameworks/QtCore.framework/Versions/A/QtCore',
    'Frameworks/QtGui.framework/Versions/A/QtGui',
    'Frameworks/libz.1.dylib',
    'PlugIns/engine_plugin.so',
    'PlugIns/platforms/libqcocoa.dylib',
    'Resources/icon.icns',
    ...extra
  ]) {
    write(path.join(contents, file), `${file}\n`)
  }

  return engine
}

/** The licence texts extraResources copies into Resources/licenses. The attached Rust notices
 * refer to texts/MPL-2.0.txt, which must then be appended as well. */
export function writeLicenseTexts(target, catalog = fixtureCatalog(), app = fixtureAppCatalog()) {
  const files = new Set([
    ...REQUIRED_LICENSE_TEXTS,
    'texts/MIT.txt',
    'texts/MPL-2.0.txt',
    ...catalog.components.flatMap(component => [
      ...component.licenseFiles,
      ...(component.includes ?? []).flatMap(included => included.licenseFiles)
    ]),
    ...app.base.licenseFiles,
    ...app.base.includes.flatMap(component => component.licenseFiles),
    ...app.frameworks.flatMap(framework => framework.licenseFiles ?? []),
    ...app.bundles.flatMap(bundle =>
      bundle.components.flatMap(component => [...(component.licenseFiles ?? []), ...(component.attachedFiles ?? [])])
    )
  ])

  for (const file of files) {
    write(path.join(target, file), `Full text of ${file}\n`)
  }

  for (const rust of app.rust) {
    write(path.join(target, rust.file), `Rust crates of ${rust.package}; see texts/MPL-2.0.txt\n`)
  }
}

/** A packaged app's Resources with a complete, valid notice; returns its paths. */
export function writeNoticesFixture(
  root,
  { bundled = [{ name: 'dev-sdk', version: '3.0.0' }], resources = path.join(root, 'Resources') } = {}
) {
  const repoRoot = path.join(root, 'repo')
  const catalogFile = path.join(root, 'engine-components.json')
  const appCatalogFile = path.join(root, 'app-components.json')
  const catalog = fixtureCatalog()
  const app = fixtureAppCatalog()
  writeRepositoryFixture(repoRoot)
  writeEngineFixture(resources)
  writeAppFixture(resources)
  writeLicenseTexts(path.join(resources, 'licenses'), catalog, app)
  write(catalogFile, JSON.stringify(catalog))
  write(appCatalogFile, JSON.stringify(app))
  mkdirSync(path.join(resources, 'runtime'), { recursive: true })
  const inventory = writeThirdPartyNotices({
    resources,
    electronVersion: FIXTURE_ELECTRON_VERSION,
    bundled,
    catalogFile,
    appCatalogFile,
    repoRoot,
    requireFrom: path.join(repoRoot, 'apps/desktop')
  })

  return { repoRoot, resources, catalogFile, appCatalogFile, inventory }
}
