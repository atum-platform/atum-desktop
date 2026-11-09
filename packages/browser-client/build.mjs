import { build } from 'esbuild'
import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
export async function bundle(write = true) {
  // WASM remains the upstream browser entry point with its original adjacent pkg/ URL.
  // Do not transform SDK crypto or replace its loader.
  const result = await build({ absWorkingDir: root, entryPoints: { page: 'src/page.ts' }, outdir: 'dist',
    bundle: true, format: 'esm', platform: 'browser', target: 'es2022', metafile: true, write,
    plugins: [{ name: 'upstream-browser-wasm', setup(builder) {
      builder.onResolve({ filter: /^@matrix-org\/matrix-sdk-crypto-wasm$/ }, () => ({ path: '/crypto/index.mjs', external: true }))
    } }],
    define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'warning' })
  const inputs = Object.keys(result.metafile.inputs)
  if (inputs.some(path => path.includes('/electron/') || /^(node:|electron)/.test(path))) throw new Error('Browser bundle contains a native dependency')
  if (write) {
    await mkdir(resolve(root, 'dist/crypto/pkg'), { recursive: true })
    await copyFile(resolve(root, 'index.html'), resolve(root, 'dist/index.html'))
    await copyFile(resolve(root, 'src/page.css'), resolve(root, 'dist/page.css'))
    const cryptoEntry = fileURLToPath(import.meta.resolve('@matrix-org/matrix-sdk-crypto-wasm'))
    const cryptoRoot = dirname(cryptoEntry)
    for (const file of ['index.mjs', 'pkg/matrix_sdk_crypto_wasm_bg.js', 'pkg/matrix_sdk_crypto_wasm_bg.wasm']) {
      await copyFile(resolve(cryptoRoot, file), resolve(root, 'dist/crypto', file))
    }
  }
  return result
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await bundle()
  console.log('Built browser proof with canonical Matrix SDK and upstream WASM assets.')
}
