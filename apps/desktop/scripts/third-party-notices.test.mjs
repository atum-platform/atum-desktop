import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ATUM_LINKS } from '../src/matrix/atum-links'

import {
  FIXTURE_ELECTRON_VERSION,
  fixtureAppCatalog,
  fixtureCatalog,
  writeAppFixture,
  writeEngineFixture,
  writeLicenseTexts,
  writeNoticesFixture,
  writeRepositoryFixture
} from './third-party-notices.fixture.mjs'
import {
  APP_CATALOG,
  auditThirdPartyNotices,
  assertThirdPartyNotices,
  bundledPackagesFromModuleIds,
  collectNpmPackages,
  createBundledPackagesCollector,
  ENGINE_CATALOG,
  LICENSES_SOURCE,
  listEngineItems,
  mapAppFrameworks,
  mapEngineComponents,
  NOTICE_FILE,
  NOTICE_INVENTORY_FILE,
  NOTICE_INVENTORY_SCHEMA,
  productionClosure,
  readAppCatalog,
  readEngineCatalog,
  REQUIRED_LICENSE_TEXTS,
  standardTextsFor,
  writeThirdPartyNotices
} from './third-party-notices.mjs'

const desktopRoot = path.resolve(import.meta.dirname, '..')
const directories = []

function temporary() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'atum-third-party-notices-'))
  directories.push(directory)

  return directory
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

/** An unwritten package: engine, Contents/Frameworks, bundle, licence texts and both catalogs. */
function packageFixture({ app = fixtureAppCatalog(), engine = {}, appFixture = {}, texts = true } = {}) {
  const root = temporary()
  const resources = path.join(root, 'Resources')
  const repoRoot = path.join(root, 'repo')
  const catalogFile = path.join(root, 'catalog.json')
  const appCatalogFile = path.join(root, 'app-catalog.json')
  writeRepositoryFixture(repoRoot)
  writeEngineFixture(resources, engine)
  writeAppFixture(resources, appFixture)

  if (texts) {
    writeLicenseTexts(path.join(resources, 'licenses'), fixtureCatalog(), app)
  }

  writeFileSync(catalogFile, JSON.stringify(fixtureCatalog()))
  writeFileSync(appCatalogFile, JSON.stringify(app))

  return {
    resources,
    repoRoot,
    write: (options = {}) =>
      writeThirdPartyNotices({
        resources,
        electronVersion: FIXTURE_ELECTRON_VERSION,
        catalogFile,
        appCatalogFile,
        repoRoot,
        requireFrom: path.join(repoRoot, 'apps/desktop'),
        ...options
      })
  }
}

describe('the generated notice', () => {
  it('records only a declared npm license alternative and preserves its source expression', () => {
    const repoRoot = path.join(temporary(), 'repo')
    writeRepositoryFixture(repoRoot)
    const file = path.join(repoRoot, 'node_modules/left-pad/package.json')
    const manifest = JSON.parse(readFileSync(file, 'utf8'))
    manifest.license = '(BSD-3-Clause OR GPL-2.0)'
    writeFileSync(file, JSON.stringify(manifest))
    const npm = collectNpmPackages({ repoRoot, licenseChoices: { 'left-pad': 'BSD-3-Clause' } })
    expect(npm.find(item => item.name === 'left-pad')).toMatchObject({
      license: 'BSD-3-Clause', declaredLicense: '(BSD-3-Clause OR GPL-2.0)'
    })
    expect(() => collectNpmPackages({ repoRoot, licenseChoices: { 'left-pad': 'MIT' } })).toThrow('package_license_choice_invalid')
  })
  it('covers every engine item, Electron, the shipped npm packages and the licence texts, and passes its audit', () => {
    const { resources, inventory } = writeNoticesFixture(temporary())
    const notice = readFileSync(path.join(resources, 'licenses', NOTICE_FILE), 'utf8')

    // The engine: its source offer, every shipped item under exactly one component.
    expect(notice).toContain('https://example.test/engine/tree/drive-engine-1')
    expect(notice).toContain('https://example.test/engine/blob/drive-engine-1/BUILDING.md')
    expect(inventory.engine.items).toEqual([
      'Frameworks/QtCore.framework',
      'Frameworks/QtGui.framework',
      'Frameworks/libz.1.dylib',
      'MacOS/Engine',
      'PlugIns/engine_plugin.so',
      'PlugIns/platforms/libqcocoa.dylib',
      'Resources/icon.icns'
    ])
    const covered = inventory.engine.components.flatMap(component => component.files).sort()
    expect(covered).toEqual([...inventory.engine.items].sort())

    for (const item of inventory.engine.items) {
      expect(notice).toContain(item)
    }

    // Electron's licence inline, Chromium's credits beside the notice.
    expect(notice).toContain('MIT terms of Electron')
    expect(readFileSync(path.join(resources, 'licenses/electron/LICENSES.chromium.html'), 'utf8')).toContain(
      'Chromium credits'
    )

    // npm: the production closure (nested resolution, a workspace link followed) and the bundled
    // devDependency; never a dev-only package or another OS's optional binary.
    expect(inventory.npm.map(item => `${item.name}@${item.version}`)).toEqual([
      'dev-sdk@3.0.0',
      'left-pad@1.3.0',
      'nested-dep@2.1.0',
      'no-file@2.0.0',
      'shared-dep@1.2.0'
    ])
    expect(notice).toContain('dev-sdk NOTICE')
    expect(notice).toContain('ISC terms of nested-dep')
    expect(notice).not.toContain('old nested-dep')
    expect(notice).not.toContain('build tool')
    // A package without a licence file names its declared licence and the standard text, and no
    // email address from package.json.
    expect(notice).toMatch(/Author \(package\.json\): No File Author\. The package ships no licence file/u)
    expect(notice).not.toContain('someone@example.test')

    // Every referenced licence text is appended once.
    for (const text of [
      ...REQUIRED_LICENSE_TEXTS,
      'texts/MIT.txt',
      'engine/qt-third-party.txt',
      'engine/zlib-LICENSE.txt'
    ]) {
      expect(notice.split(`\n${text}\n`).length - 1, text).toBe(1)
      expect(inventory.texts.map(entry => entry.path)).toContain(text)
    }

    // The written offer, the public tag pinned to its commit, and the relink steps for the LGPL
    // libraries, ending with the re-signed app.
    expect(notice.startsWith('\uFEFF')).toBe(true)
    expect(notice).toContain('Written offer. For at least three years')
    expect(notice).toContain(`tag drive-engine-1, commit ${'c'.repeat(40)}`)
    expect(notice).toContain('https://example.test/engine/blob/main/BUILDING.md')
    expect(notice).toMatch(/Qt is licensed under the GNU Lesser General Public License/u)
    expect(notice).toMatch(/1\. Replace the library in\s+Resources\/drive-engine\/Engine\.app\/Contents\/Frameworks/u)
    expect(notice).toMatch(/"bundleSha256"/u)
    expect(notice).toMatch(/4\. Re-sign Atum ad hoc/u)
    // Qt as built: its patches and the exact source archives with their digests.
    expect(notice).toContain('Built with the fixture patches applied to qtbase.')
    expect(notice).toContain(
      `https://example.test/engine/releases/download/drive-engine-1/qtbase.tar.xz\n      SHA-256 ${'d'.repeat(64)}`
    )
    // Code compiled into the engine's own libraries.
    expect(notice).toMatch(/Includes Fixture Icons 2\.0, embedded in the engine: OFL-1\.1/u)

    // Contents/Frameworks: every entry, each under one framework.
    expect(inventory.frameworks.items).toEqual([
      'Electron Framework.framework',
      'Fixture Helper (GPU).app',
      'Fixture Helper.app',
      'Squirrel.framework'
    ])
    expect(inventory.frameworks.components).toEqual([
      { id: 'electron', files: ['Electron Framework.framework', 'Fixture Helper (GPU).app', 'Fixture Helper.app'] },
      { id: 'squirrel', files: ['Squirrel.framework'] }
    ])
    expect(notice).toContain('https://example.test/ffmpeg')
    expect(notice).toContain('The fixture app is built from Fixture Base.')

    // The bundle that ships, with its licence files; never the one that does not.
    expect(inventory.bundles).toEqual([
      {
        id: 'fixture-runtime',
        folder: 'fixture-runtime',
        shippedFiles: ['fixture-runtime/LICENSE.txt', 'fixture-runtime/lib/libpython.dylib']
      }
    ])
    expect(notice).toContain('The Python runtime of the fixture agent')
    expect(notice).not.toContain('A bundle this package does not ship')

    // The Rust notices are named and digest-checked, not repeated; the text they refer to is.
    expect(notice).toContain('rust/left-pad-1.3.0.txt in this folder')
    expect(notice).not.toContain('Rust crates of left-pad')
    expect(inventory.texts).toEqual(
      expect.arrayContaining([
        { path: 'rust/left-pad-1.3.0.txt', sha256: expect.any(String), attached: true },
        { path: 'rust/agent-1.0.0.txt', sha256: expect.any(String), attached: true },
        { path: 'texts/MPL-2.0.txt', sha256: expect.any(String) },
        { path: 'texts/OFL-1.1.txt', sha256: expect.any(String) }
      ])
    )

    expect(auditThirdPartyNotices({ resources }).issues).toEqual([])
    expect(assertThirdPartyNotices({ resources })).toMatchObject({
      npmPackages: 5,
      engineComponents: 4,
      frameworks: 4,
      bundles: ['fixture-runtime']
    })
  })

  it('is the same for the same inputs', () => {
    const first = writeNoticesFixture(temporary())
    const second = writeNoticesFixture(temporary())

    expect(second.inventory.notice.sha256).toBe(first.inventory.notice.sha256)
  })

  it('refuses an engine library the catalog does not list', () => {
    const { write } = packageFixture({ engine: { extra: ['Frameworks/libnew.1.dylib'] } })

    expect(() => write()).toThrow('engine_item_unlisted:Frameworks/libnew.1.dylib')
  })

  it('refuses an engine revision the catalog was not reviewed for', () => {
    const { write } = packageFixture({ engine: { sourceCommit: 'b'.repeat(40) } })

    expect(() => write()).toThrow(`engine_source_unlisted:${'b'.repeat(40)}`)
  })

  it('refuses when the licence texts were not packaged, or Electron is another version', () => {
    const { resources, write } = packageFixture({ texts: false })

    expect(() => write()).toThrow('license_texts_not_packaged')
    writeLicenseTexts(path.join(resources, 'licenses'))
    expect(() => write({ electronVersion: '41.0.0' })).toThrow(
      `electron_version_mismatch:${FIXTURE_ELECTRON_VERSION}:41.0.0`
    )
    expect(() => write({ electronVersion: undefined })).toThrow('electron_version_unknown')
  })

  it('refuses an app catalog written for another Electron, whose Chromium and FFmpeg sources differ', () => {
    const app = fixtureAppCatalog()
    app.electron.version = '39.0.0'
    const { write } = packageFixture({ app })

    expect(() => write()).toThrow(`app_catalog_electron_version:39.0.0:${FIXTURE_ELECTRON_VERSION}`)
  })

  it('refuses an entry of Contents/Frameworks the catalog does not list', () => {
    const { write } = packageFixture({
      appFixture: {
        frameworks: [
          'Electron Framework.framework',
          'Fixture Helper.app',
          'Fixture Helper (GPU).app',
          'Squirrel.framework',
          'Mantle.framework'
        ]
      }
    })

    expect(() => write()).toThrow('app_framework_item_unlisted:Mantle.framework')
  })

  it('refuses a bundle staged at another version than the catalog records, or missing a licence file', () => {
    expect(() => packageFixture({ appFixture: { pythonVersion: '3.12.0' } }).write()).toThrow(
      'bundle_pin_changed:fixture-runtime:python.version:3.12.0'
    )

    const { resources, write } = packageFixture()
    rmSync(path.join(resources, 'fixture-runtime', 'LICENSE.txt'))
    expect(() => write()).toThrow('bundle_file_missing:fixture-runtime:fixture-runtime/LICENSE.txt')
  })

  it('refuses a shipped package whose Rust notice belongs to another version', () => {
    const app = fixtureAppCatalog()
    app.rust[0].version = '1.2.0'
    const { write } = packageFixture({ app })

    expect(() => write()).toThrow('rust_notice_version:left-pad@1.3.0')
  })

  it('refuses a package with no licence file whose licence has no standard text', () => {
    const { repoRoot, write } = packageFixture()
    const manifest = path.join(repoRoot, 'node_modules/no-file/package.json')
    writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, 'utf8')), license: 'ISC' }))

    expect(() => write()).toThrow('package_license_text_missing:no-file@2.0.0:ISC')
  })

  it('refuses a bundled package that is not in the lockfile', () => {
    const root = temporary()

    expect(() => writeNoticesFixture(root, { bundled: [{ name: 'ghost', version: '1.0.0' }] })).toThrow(
      'bundled_package_unlocked:ghost@1.0.0'
    )
  })
})

describe('standard licence texts', () => {
  it('cover a package without a licence file only when the licence text names no holder', () => {
    expect(standardTextsFor('MIT')).toEqual(['texts/MIT.txt'])
    expect(standardTextsFor('(ISC OR MIT)')).toEqual(['texts/MIT.txt'])
    expect(standardTextsFor('Apache-2.0 AND MIT')).toEqual(['texts/Apache-2.0.txt', 'texts/MIT.txt'])
    expect(standardTextsFor('MIT AND ISC')).toEqual([])
    expect(standardTextsFor('BSD-3-Clause')).toEqual([])
    expect(standardTextsFor(null)).toEqual([])
  })
})

describe('the app catalog', () => {
  it('prints and packages the licence and notice for source adapted into the app', () => {
    const app = fixtureAppCatalog()
    app.base.includes = [
      {
        id: 'adapted-ui',
        name: 'Adapted UI',
        version: 'commit abc123',
        license: 'Apache-2.0',
        source: 'https://example.test/adapted-ui/tree/abc123',
        notes: ['Modified for the fixture shell.'],
        licenseFiles: ['texts/Apache-2.0.txt', 'app/adapted-ui-NOTICE.md']
      }
    ]
    const { resources, write } = packageFixture({ app })
    const inventory = write()
    const notice = readFileSync(path.join(resources, 'licenses', NOTICE_FILE), 'utf8')

    expect(notice).toContain('The app includes Adapted UI commit abc123, licensed under Apache-2.0.')
    expect(notice).toMatch(/Modified for the fixture\s+shell\./u)
    expect(inventory.texts.map(entry => entry.path)).toEqual(expect.arrayContaining([
      'texts/Apache-2.0.txt', 'app/adapted-ui-NOTICE.md'
    ]))
  })

  it('maps every entry of Contents/Frameworks, helper apps included', () => {
    const mapped = mapAppFrameworks(fixtureAppCatalog(), [
      'Electron Framework.framework',
      'Atum Helper (GPU).app',
      'Atum Helper.app',
      'Squirrel.framework'
    ])

    expect(mapped.map(framework => framework.shipped)).toEqual([
      ['Electron Framework.framework', 'Atum Helper (GPU).app', 'Atum Helper.app'],
      ['Squirrel.framework']
    ])
  })

  it('in the repository names licence texts that exist and the Electron the app is packaged with', () => {
    const real = readAppCatalog()
    const builder = JSON.parse(readFileSync(path.join(desktopRoot, 'matrix-release-builder.json'), 'utf8'))

    expect(real.electron.version).toBe(builder.electronVersion)
    expect(APP_CATALOG).toBe(path.join(desktopRoot, 'third-party', 'app-components.json'))

    // Every listed licence file refers only to texts the notice appends.
    for (const bundle of real.bundles) {
      for (const component of bundle.components) {
        for (const file of [...(component.licenseFiles ?? []), ...(component.attachedFiles ?? [])]) {
          for (const reference of readFileSync(path.join(LICENSES_SOURCE, file), 'utf8').match(
            /\btexts\/[\w.-]+\.txt\b/gu
          ) ?? []) {
            expect(
              readFileSync(path.join(LICENSES_SOURCE, reference), 'utf8').length,
              `${file} -> ${reference}`
            ).toBeGreaterThan(0)
          }
        }
      }
    }
  })
})

describe('the engine catalog', () => {
  const catalog = fixtureCatalog()

  it('maps each item to one component and every pattern to something shipped', () => {
    const items = [
      'Frameworks/QtCore.framework',
      'Frameworks/libz.1.dylib',
      'MacOS/Engine',
      'PlugIns/engine_plugin.so',
      'PlugIns/platforms/libqcocoa.dylib',
      'Resources/icon.icns'
    ]
    const mapped = mapEngineComponents(catalog, items)

    expect(mapped.find(component => component.id === 'qt').shipped).toEqual([
      'Frameworks/QtCore.framework',
      'PlugIns/platforms/libqcocoa.dylib'
    ])
    expect(() =>
      mapEngineComponents(
        catalog,
        items.filter(item => item !== 'Frameworks/libz.1.dylib')
      )
    ).toThrow('engine_pattern_unmatched:zlib:Frameworks/libz.1.dylib')
    const overlapping = fixtureCatalog()
    overlapping.components[2].files.push('Frameworks/Qt*.framework')
    expect(() => mapEngineComponents(overlapping, items)).toThrow('engine_item_ambiguous:Frameworks/QtCore.framework')
  })

  it('lists a bundle by its frameworks, libraries, plugins and resources, not its metadata', () => {
    const root = temporary()
    writeEngineFixture(root)

    expect(listEngineItems(path.join(root, 'drive-engine', 'Engine.app'))).not.toContain('Info.plist')
    expect(listEngineItems(path.join(root, 'drive-engine', 'Engine.app'))).toContain(
      'PlugIns/platforms/libqcocoa.dylib'
    )
  })

  it('in the repository names licence texts that exist, and the source the Settings row opens', () => {
    const real = readEngineCatalog()
    const sourceReference = real.engine.sourceTag ?? real.engine.sourceCommit

    expect(real.engine.sourceUrl).toBe(ATUM_LINKS.driveEngineSource)
    expect(new URL(real.engine.sourceUrl).pathname.endsWith(`/tree/${sourceReference}`)).toBe(true)
    expect(new URL(real.engine.buildingUrl).pathname).toContain(
      `/blob/${sourceReference}/BUILDING.md`
    )

    for (const required of REQUIRED_LICENSE_TEXTS) {
      expect(readFileSync(path.join(LICENSES_SOURCE, required), 'utf8').length, required).toBeGreaterThan(1000)
    }
  })

  it('in the repository gives every LGPL library its exact source archives, and the engine its GPL-3.0 text', () => {
    const real = readEngineCatalog()
    const repository = new URL(real.engine.sourceUrl).pathname.split('/tree/')[0]

    for (const field of ['instructionsUrl', 'releaseUrl']) {
      expect(new URL(real.engine[field]).pathname.startsWith(`${repository}/`), field).toBe(true)
    }

    const lgpl = real.components.filter(component => /^LGPL/u.test(component.license))
    expect(lgpl.length).toBeGreaterThan(0)

    for (const component of lgpl) {
      expect(component.source, component.id).toBe(real.engine.releaseUrl)
      expect(component.sourceArchives?.length, component.id).toBeGreaterThan(0)
    }

    const gpl = real.components.filter(component => component.license.startsWith('GPL-'))
    expect(gpl.length).toBeGreaterThan(0)

    for (const component of gpl) {
      expect(component.licenseFiles, component.id).toEqual(
        expect.arrayContaining(['texts/GPL-2.0.txt', 'texts/GPL-3.0.txt'])
      )
    }
  })

  it('in the repository gives each component every licence text its own texts refer to', () => {
    const real = readEngineCatalog()

    for (const component of real.components) {
      const included = (component.includes ?? []).flatMap(item => item.licenseFiles)

      for (const file of [...component.licenseFiles, ...included]) {
        const text = readFileSync(path.join(LICENSES_SOURCE, file), 'utf8')
        const references = text.match(/\btexts\/[\w.-]+\.txt\b/gu) ?? []

        for (const reference of references) {
          expect([...component.licenseFiles, ...included], `${component.id}: ${file} refers to ${reference}`).toContain(
            reference
          )
        }
      }
    }
  })

  it('is the catalog the notice reads by default', () => {
    expect(ENGINE_CATALOG).toBe(path.join(desktopRoot, 'third-party', 'engine-components.json'))
  })
})

describe('npm packages', () => {
  it('follows the production closure the way Node resolves it', () => {
    const lock = {
      packages: {
        'apps/desktop': { dependencies: { a: '1', linked: 'file:../lib' }, devDependencies: { d: '1' } },
        'apps/lib': { dependencies: { c: '1' } },
        'node_modules/linked': { link: true, resolved: 'apps/lib' },
        'node_modules/a': { version: '1.0.0', dependencies: { b: '1' } },
        'node_modules/a/node_modules/b': { version: '2.0.0' },
        'node_modules/b': { version: '1.0.0' },
        'node_modules/c': { version: '1.0.0', dependencies: { b: '1' } },
        'node_modules/d': { version: '1.0.0', dev: true }
      }
    }

    expect([...productionClosure(lock)].sort()).toEqual([
      'node_modules/a',
      'node_modules/a/node_modules/b',
      'node_modules/b',
      'node_modules/c'
    ])
    expect(() => productionClosure({ packages: { 'apps/desktop': { dependencies: { missing: '1' } } } })).toThrow(
      'lock_dependency_unresolved:apps/desktop:missing'
    )
  })

  it('refuses a package installed at another version than the lockfile says', () => {
    const repoRoot = temporary()
    writeRepositoryFixture(repoRoot)
    writeFileSync(
      path.join(repoRoot, 'node_modules/left-pad/package.json'),
      JSON.stringify({ name: 'left-pad', version: '9.9.9' })
    )

    expect(() => collectNpmPackages({ repoRoot })).toThrow('package_version_mismatch:node_modules/left-pad:9.9.9:1.3.0')
  })

  it('names the packages behind bundler module ids', () => {
    const manifests = {
      '/repo/node_modules/@scope/pkg': { name: '@scope/pkg', version: '1.0.0' },
      '/repo/node_modules/plain': { name: 'plain', version: '2.0.0' },
      '/repo/node_modules/plain/node_modules/inner': { name: 'inner', version: '3.0.0' }
    }

    expect(
      bundledPackagesFromModuleIds(
        [
          '/repo/node_modules/@scope/pkg/dist/index.js',
          '\0/repo/node_modules/plain/index.js?commonjs-proxy',
          '/repo/node_modules/plain/lib/x.css',
          '/repo/node_modules/plain/node_modules/inner/index.mjs',
          '/repo/apps/desktop/src/app.tsx',
          '\0vite/preload-helper.js',
          'relative/node_modules/skipped/index.js'
        ],
        root => manifests[root]
      )
    ).toEqual([
      { name: '@scope/pkg', version: '1.0.0' },
      { name: 'inner', version: '3.0.0' },
      { name: 'plain', version: '2.0.0' }
    ])
  })

  it('collects module ids from both renderer hooks and esbuild metafiles', () => {
    const collector = createBundledPackagesCollector({ cwd: '/repo/apps/desktop' })
    const plugin = collector.plugin()

    expect(plugin.enforce).toBe('pre')
    expect(plugin.transform('', '/repo/node_modules/katex/dist/katex.min.css')).toBeNull()
    plugin.generateBundle({}, { 'index.js': { modules: { '/repo/node_modules/react/index.js': {} } }, 'a.css': {} })
    collector.addMetafile({ inputs: { '../../node_modules/jose/dist/index.js': {} } })

    expect(
      collector.packages(root => ({ name: path.basename(root), version: '1.0.0' })).map(item => item.name)
    ).toEqual(['jose', 'katex', 'react'])
  })
})

describe('the check', () => {
  it('fails a package without a notice', () => {
    const resources = path.join(temporary(), 'Resources')
    writeEngineFixture(resources)
    writeLicenseTexts(path.join(resources, 'licenses'))

    expect(auditThirdPartyNotices({ resources }).issues).toEqual(
      expect.arrayContaining([
        'inventory_missing',
        'notice_missing',
        'electron_notice_missing:electron/LICENSES.chromium.html'
      ])
    )
    expect(() => assertThirdPartyNotices({ resources })).toThrow('third_party_notices_invalid:')
  })

  it('fails a notice that no longer matches the bundle', () => {
    const { resources } = writeNoticesFixture(temporary())
    writeFileSync(path.join(resources, 'licenses/texts/GPL-2.0.txt'), 'edited\n')
    writeFileSync(path.join(resources, 'licenses/rust/left-pad-1.3.0.txt'), 'edited\n')
    writeEngineFixture(resources, { extra: ['Frameworks/libnew.1.dylib'] })
    writeAppFixture(resources, {
      frameworks: [
        'Electron Framework.framework',
        'Fixture Helper.app',
        'Fixture Helper (GPU).app',
        'Squirrel.framework',
        'Mantle.framework'
      ]
    })
    rmSync(path.join(resources, 'fixture-runtime', 'LICENSE.txt'))
    rmSync(path.join(resources, 'licenses/electron/LICENSES.chromium.html'))

    expect(auditThirdPartyNotices({ resources }).issues).toEqual(
      expect.arrayContaining([
        'license_text_changed:texts/GPL-2.0.txt',
        'license_text_changed:rust/left-pad-1.3.0.txt',
        'engine_items_changed',
        'engine_item_uncovered:Frameworks/libnew.1.dylib',
        'app_frameworks_changed',
        'app_framework_uncovered:Mantle.framework',
        'bundle_file_missing:fixture-runtime:fixture-runtime/LICENSE.txt',
        'electron_notice_missing:electron/LICENSES.chromium.html'
      ])
    )
  })

  it('fails an edited notice or a missing engine', () => {
    const { resources } = writeNoticesFixture(temporary())
    writeFileSync(path.join(resources, 'licenses', NOTICE_FILE), 'nothing\n')
    rmSync(path.join(resources, 'drive-engine'), { recursive: true })

    expect(auditThirdPartyNotices({ resources }).issues).toEqual(['engine_manifest_missing', 'notice_changed'])
    expect(JSON.parse(readFileSync(path.join(resources, 'licenses', NOTICE_INVENTORY_FILE), 'utf8')).schema).toBe(
      NOTICE_INVENTORY_SCHEMA
    )
  })
})

describe('packaging', () => {
  const configs = ['matrix-builder.json', 'matrix-release-builder.json'].map(file => [
    file,
    JSON.parse(readFileSync(path.join(desktopRoot, file), 'utf8'))
  ])
  const desktop = JSON.parse(readFileSync(path.join(desktopRoot, 'package.json'), 'utf8'))

  it.each(configs)(
    '%s puts the licence texts in Resources/licenses and writes the notice after packing',
    (_file, config) => {
      expect(config.mac.extraResources).toContainEqual({ from: 'third-party/licenses', to: 'licenses' })
      expect(config.afterPack).toBe('scripts/matrix-after-pack.mjs')
    }
  )

  it.each(configs)('%s packages the Electron whose notices the installed package carries', (_file, config) => {
    expect(config.electronVersion).toBe(desktop.devDependencies.electron)
  })
})
