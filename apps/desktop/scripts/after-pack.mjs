/**
 * after-pack.mjs — electron-builder afterPack hook.
 *
 * Final target-specific package staging:
 *
 * - macOS gets the pinned, relocatable Python + Hermes payload under
 *   Contents/Resources/runtime before electron-builder signs the bundle.
 * - Windows gets its Hermes icon + identity stamped via rcedit. That cosmetic
 *   stamp remains best-effort; runtime staging fails closed because omitting it
 *   would produce an app that cannot start on a clean Mac.
 *
 * electron-builder passes a context with:
 *   - electronPlatformName: 'win32' | 'darwin' | 'linux'
 *   - appOutDir:            the unpacked app directory for this target
 *   - packager.appInfo.productFilename: the exe basename (e.g. 'Hermes')
 */

import fs from 'node:fs'
import path from 'node:path'
import { Arch } from 'electron-builder'

import { assertPackagedRenderer } from './assert-packaged-renderer.mjs'
import { ATUM_PROD_HOSTED_ORIGINS, ATUM_PROD_PLANE } from './atum-product-defaults.mjs'
import { stampExeIdentity } from './set-exe-identity.mjs'
import { stageBundledRuntime } from './stage-bundled-runtime.mjs'
import { publicConfigFromEnvironment, writeAtumPublicConfig } from './write-atum-public-config.mjs'

/**
 * The pets that ship with the app are installed by the Python backend copying
 * real files. Inside app.asar they are visible to Electron and to nobody
 * else, so packaging must unpack them (package.json `asarUnpack`); a bundle
 * where it did not would ship a store whose "From Atum" shelf is empty.
 */
export function assertBundledPetsUnpacked(resourcesDir, { fs: fsModule = fs } = {}) {
  const unpacked = path.join(resourcesDir, 'app.asar.unpacked', 'assets', 'pets')
  let slugs = []

  try {
    slugs = fsModule.readdirSync(unpacked, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch {
    throw new Error(`bundled pets are not unpacked from app.asar (${unpacked}); add assets/pets/** to asarUnpack`)
  }

  const missing = slugs.filter(slug => !fsModule.existsSync(path.join(unpacked, slug, 'pet.json')))

  if (slugs.length === 0 || missing.length > 0) {
    throw new Error(`bundled pets are incomplete in ${unpacked}: ${slugs.length === 0 ? 'no pets' : `no pet.json for ${missing.join(', ')}`}`)
  }

  return slugs
}

export function assertProductionGoogleAuthEnabled(config) {
  const hostedIsProduction = ATUM_PROD_HOSTED_ORIGINS.has(config?.hostedBaseUrl)
  const supabaseIsProduction = config?.supabaseUrl === ATUM_PROD_PLANE.ATUM_PUBLIC_SUPABASE_URL

  if (hostedIsProduction !== supabaseIsProduction) {
    throw new Error('refusing to package a mixed production/nonproduction Atum control plane')
  }

  const isProductionPlane = hostedIsProduction && supabaseIsProduction

  if (isProductionPlane && config?.providers?.google !== true) {
    throw new Error('refusing to package the Atum production plane with Google authentication disabled')
  }

  return config
}

export default async function afterPack(context) {
  if (context.electronPlatformName === 'darwin') {
    const productName = context.packager?.appInfo?.productFilename || 'Hermes'
    const arch = typeof context.arch === 'number' ? Arch[context.arch] : process.arch
    const appRoot = path.join(context.appOutDir, `${productName}.app`)
    const runtimeRoot = path.join(context.appOutDir, `${productName}.app`, 'Contents', 'Resources', 'runtime')
    const publicConfigPath = path.join(
      context.appOutDir,
      `${productName}.app`,
      'Contents',
      'Resources',
      'atum-public-config.json'
    )

    const publicConfig = publicConfigFromEnvironment(process.env)

    assertProductionGoogleAuthEnabled(publicConfig)
    assertPackagedRenderer(appRoot)
    assertBundledPetsUnpacked(path.join(appRoot, 'Contents', 'Resources'))
    stageBundledRuntime({ targetRoot: runtimeRoot, platform: 'darwin', arch })
    writeAtumPublicConfig({ outputPath: publicConfigPath })
    return
  }

  if (context.electronPlatformName !== 'win32') {
    return
  }

  const productName = context.packager?.appInfo?.productFilename || 'Hermes'
  const exe = path.join(context.appOutDir, `${productName}.exe`)
  const desktopRoot = path.resolve(import.meta.dirname, '..')

  // Same contract on Windows: the backend reads bundled pets from real files.
  assertBundledPetsUnpacked(path.join(context.appOutDir, 'resources'))

  try {
    await stampExeIdentity(exe, desktopRoot)
  } catch (err) {
    // Never fail the build over a cosmetic stamp.
    console.warn(`[after-pack] exe identity stamp failed (${err.message}); Hermes.exe keeps the stock Electron icon`)
  }
}
