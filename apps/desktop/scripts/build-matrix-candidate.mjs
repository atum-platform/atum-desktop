import { build as bundle } from 'esbuild'
import { build as renderer } from 'vite'
import { matrixPetCompositionEvidence } from './matrix-pet-composition.mjs'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveStamp } from './write-build-stamp.mjs'
import { stageAtumAppWindow } from './stage-atum-app-window.mjs'
import { stageAtumKeys } from './stage-atum-keys.mjs'
import { deviceHubDefine, stageAtumDeviceKey } from './stage-atum-device-key.mjs'
import { stageAtumDisclaimLauncher } from './stage-atum-disclaim-launcher.mjs'
import { GOOGLE_DESKTOP_CLIENT_ASAR_PATH, stageGoogleClient } from './stage-google-client.mjs'
import { BUNDLED_PACKAGES_FILE, createBundledPackagesCollector } from './third-party-notices.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
if (Number(process.versions.node.split('.')[0]) < 22)
  throw new Error('The Matrix candidate build requires Node 22 or later.')
const require = createRequire(path.join(root, 'package.json'))
const out = path.join(root, 'dist-matrix')
const repoRoot = path.resolve(root, '../..')
// Use the checkout actually being bundled, not an inherited CI SHA. Untracked
// source is not part of git archive and must not attest a clean package either.
const stamp = resolveStamp({ env: {}, repoRoot })
stamp.dirty ||= Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' }).trim())
// Every npm package that ends up in the bundle, from the module graphs themselves: the open-source
// notice lists them (third-party-notices.mjs, read back from app.asar at packaging).
const bundledPackages = createBundledPackagesCollector()
await renderer({
  configFile: path.join(root, 'vite.config.ts'),
  root,
  plugins: [
    bundledPackages.plugin(),
    {
      name: 'matrix-composition-evidence',
      generateBundle(_options, output) {
        const modules = [
          ...new Set(
            Object.values(output)
              .filter(file => file.type === 'chunk')
              .flatMap(file => Object.keys(file.modules))
              .filter(file => file.startsWith(root + '/src/'))
          )
        ]
          .map(file => path.relative(root, file))
          .sort()
        // Check the actual bundle graph, not import spelling: presentation reuse
        // must not silently pull the retired account/gateway roots into Matrix.
        const forbidden = modules.filter(
          file =>
            file.startsWith('src/matrix/playground/') ||
            file === 'src/hermes.ts' ||
            file === 'src/themes/context.tsx' ||
            /^src\/store\/(gateway|profile|session|atum-messaging)([./]|$)/.test(file)
        )
        if (forbidden.length)
          this.error(`Matrix renderer imported playground or legacy authority roots: ${forbidden.join(', ')}`)
        this.emitFile({
          type: 'asset',
          fileName: 'matrix-renderer-modules.json',
          source: JSON.stringify(modules, null, 2)
        })
      }
    }
  ],
  build: { outDir: out, emptyOutDir: true, rolldownOptions: { input: path.join(root, 'matrix.html') } }
})
// Management pages reuse old presentation in a separate trusted contents, never
// via a wider chat bridge or a weakened chat import-graph gate.
await renderer({
  configFile: path.join(root, 'vite.config.ts'),
  root,
  plugins: [
    bundledPackages.plugin(),
    {
      name: 'matrix-pages-composition-evidence',
      generateBundle(_options, output) {
        const modules = [
          ...new Set(
            Object.values(output)
              .filter(file => file.type === 'chunk')
              .flatMap(file => Object.keys(file.modules))
              .filter(file => file.startsWith(root + '/src/'))
          )
        ]
          .map(file => path.relative(root, file))
          .sort()
        const forbidden = modules.filter(
          file =>
            file.startsWith('src/matrix/playground/') ||
            file === 'src/hermes.ts' ||
            file === 'src/themes/context.tsx' ||
            /^src\/store\/(gateway|profile|session|atum-messaging)([./]|$)/.test(file)
        )
        if (forbidden.length)
          this.error(`Matrix pages imported playground or legacy authority roots: ${forbidden.join(', ')}`)
        this.emitFile({
          type: 'asset',
          fileName: 'matrix-pages-modules.json',
          source: JSON.stringify(modules, null, 2)
        })
      }
    }
  ],
  build: {
    outDir: path.join(out, 'pages'),
    emptyOutDir: true,
    rolldownOptions: { input: path.join(root, 'matrix-pages.html') }
  }
})
await renderer({
  configFile: path.join(root, 'vite.config.ts'), root,
  plugins: [bundledPackages.plugin(), matrixPetCompositionEvidence(root)],
  build: { outDir: out, emptyOutDir: false, rolldownOptions: { input: path.join(root, 'matrix-pet.html') } }
})
for (const name of ['main', 'ui-preload', 'sdk-preload', 'pages-preload', 'app-panel-preload', 'pet-overlay-preload', 'work-preload']) {
  const result = await bundle({
    entryPoints: [path.join(root, name === 'work-preload' ? 'electron/work/sidecar/preload.ts' : `electron/matrix/${name}.ts`)],
    outfile: path.join(out, name === 'pet-overlay-preload' ? 'matrix-pet-preload.js' : `matrix-${name}.${name === 'main' ? 'mjs' : 'js'}`),
    bundle: true,
    platform: 'node',
    format: name === 'main' ? 'esm' : 'cjs',
    target: 'node22',
    sourcemap: 'external',
    external: ['electron'],
    metafile: true,
    ...(name === 'main'
      ? {
          banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
          // S1: the device hub is compiled in. Production builds leave it empty (only the
          // production hub); a dev build for the SSM port-forward sets ws://127.0.0.1:<port>/v1,
          // and a release refuses any override (deviceHubDefine).
          define: { 'process.env.ATUM_DEVICE_HUB_URL': deviceHubDefine() }
        }
      : {})
  })
  bundledPackages.addMetafile(result.metafile)
  const modules = Object.keys(result.metafile.inputs)
    .map(file => path.relative(root, path.resolve(file)))
    .sort()
  const forbidden = modules.filter(file => file.startsWith('electron/atum-messaging/') || file === 'electron/main.ts')
  if (forbidden.length)
    throw new Error(`Matrix native composition imported legacy authority roots: ${forbidden.join(', ')}`)
  writeFileSync(path.join(out, name === 'pet-overlay-preload' ? 'matrix-pet-preload-modules.json' : `matrix-${name}-modules.json`), JSON.stringify(modules, null, 2))
}
const sdk = await bundle({
  entryPoints: [path.join(root, 'src/matrix/sdk-entry.ts')],
  outfile: path.join(out, 'matrix-sdk.js'),
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'chrome140',
  sourcemap: 'external',
  metafile: true,
  define: { 'process.env.NODE_ENV': '"production"' }
})
bundledPackages.addMetafile(sdk.metafile)
mkdirSync(path.join(out, 'pkg'), { recursive: true })
copyFileSync(
  path.join(path.dirname(require.resolve('@matrix-org/matrix-sdk-crypto-wasm')), 'pkg/matrix_sdk_crypto_wasm_bg.wasm'),
  path.join(out, 'pkg/matrix_sdk_crypto_wasm_bg.wasm')
)
copyFileSync(path.join(root, 'matrix-sdk.html'), path.join(out, 'matrix-sdk.html'))
stageAtumAppWindow({ output: path.join(out, 'atum-app-window') })
// Atum Keys keeps the recovery key in iCloud Keychain, only in a build with its own provisioning
// profile (ATUM_KEYS_PROFILE); otherwise its folder stays empty and the vault alone keeps the key.
stageAtumKeys({ root })
// S1: the Secure Enclave device-key helper, unpacked beside atum-app-window (matrix-*builder.json).
stageAtumDeviceKey({ output: path.join(out, 'atum-device-key') })
stageAtumDisclaimLauncher({ output: path.join(out, 'atum-disclaim-launcher') })
// The registration is ignored from source control. It is optional for normal
// development/CI builds, but a configured value must be valid and land at the
// exact app.asar path the Matrix main process resolves.
stageGoogleClient({
  source: path.join(root, GOOGLE_DESKTOP_CLIENT_ASAR_PATH),
  output: path.join(out, GOOGLE_DESKTOP_CLIENT_ASAR_PATH)
})
// Everything except Electron/Node builtins is bundled. A minimal app manifest
// keeps legacy production dependencies and packaging hooks out of the candidate.
const source = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
writeFileSync(
  path.join(out, 'package.json'),
  JSON.stringify(
    {
      name: 'atum-matrix-candidate',
      version: source.version,
      private: true,
      description: 'Isolated Atum Matrix migration candidate',
      author: 'Atum',
      main: 'matrix-main.mjs',
      dependencies: {}
    },
    null,
    2
  )
)
writeFileSync(path.join(out, BUNDLED_PACKAGES_FILE), JSON.stringify(bundledPackages.packages(), null, 2))
writeFileSync(path.join(out, 'matrix-build-stamp.json'), JSON.stringify(stamp))
