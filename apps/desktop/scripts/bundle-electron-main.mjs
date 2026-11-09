#!/usr/bin/env node
// bundle-electron-main.mjs — bundles electron/main.ts and electron/preload.ts
// into self-contained js files in dist/ so the packaged app doesn't need
// node_modules/ or tsx at runtime.
//
// Output:
//   dist/electron-main.mjs    (MJS bundle — entry point for packaged app)
//   dist/electron-preload.js (CJS bundle — loaded via BrowserWindow preload)
//
// `electron` and `node-pty` are external (provided by the runtime / staged
// separately via stage-native-deps).
import { build } from 'esbuild'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const external = ['electron', 'node-pty', 'fs']

/**
 * Bundle electron/main.ts and electron/preload.ts into self-contained js files.
 *
 * @param {Object} options
 * @param {string} options.root — project root containing electron/ and the output distDir.
 * @param {string} options.distDir — directory for the bundled outputs.
 * @param {boolean} [options.dev=false] — dev bundles leave the env alone;
 *   production bundles bake `process.env.HERMES_DESKTOP_IS_PACKAGED=true`.
 * @param {boolean} [options.silent=false] — when true, esbuild logLevel is 'warning'.
 */
export async function bundleElectronMain({ root, distDir, dev = false, silent = false }) {
  mkdirSync(distDir, { recursive: true })

  const mainEntry = resolve(root, 'electron/main.ts')
  const mainOut = resolve(distDir, 'electron-main.mjs')
  const preloadEntry = resolve(root, 'electron/preload.ts')
  const preloadOut = resolve(distDir, 'electron-preload.js')

  const define = dev
    ? {}
    : { 'process.env.HERMES_DESKTOP_IS_PACKAGED': JSON.stringify(true) }

  // Bundle main.ts → dist/electron-main.mjs
  await build({
    entryPoints: [mainEntry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile: mainOut,
    sourcemap: 'external',
    external,
    // The raw TypeScript probe needs fflate's Node ESM entry, while the
    // packaged main process only uses synchronous ZIP helpers. Bundle the
    // browser entry there so fflate cannot inject a second createRequire.
    plugins: [
      {
        name: 'fflate-browser-entry',
        setup(build) {
          build.onResolve({ filter: /^fflate$/ }, args =>
            build.resolve('fflate/browser', {
              importer: args.importer,
              kind: args.kind,
              resolveDir: args.resolveDir
            })
          )
        }
      }
    ],
    banner: {
      js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
    },
    define,
    logLevel: silent ? 'warning' : 'info',
  })
  console.log(`bundled ${mainOut}${dev ? ' (dev)' : ''}`)

  // Bundle preload.ts → dist/electron-preload.js
  await build({
    entryPoints: [preloadEntry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: preloadOut,
    sourcemap: 'external',
    external,
    define,
    logLevel: silent ? 'warning' : 'info',
  })
  console.log(`bundled ${preloadOut}${dev ? ' (dev)' : ''}`)
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const distDir = resolve(root, 'dist')
  await bundleElectronMain({ root, distDir, dev: process.argv.includes('--dev') })
}
