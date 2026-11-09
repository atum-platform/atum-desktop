import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'
import { expect, it } from 'vitest'

// The SDK seam (G8-36) is for hosts other than the desktop: a browser client and a headless
// executor bundle the engine, its serving and the command queue without any of Electron.
it.each(['browser', 'node'] as const)('bundles the SDK seam for a %s host without Electron', async platform => {
  const root = fileURLToPath(new URL('../../', import.meta.url))

  const result = await build({
    absWorkingDir: root,
    stdin: {
      contents: [
        "export { serveMatrixSdk } from './src/matrix/sdk-host-serve'",
        "export { connectMatrixSdk, MatrixSdkHost } from './src/matrix/sdk-host-queue'"
      ].join('\n'),
      resolveDir: root,
      loader: 'ts'
    },
    bundle: true,
    write: false,
    metafile: true,
    platform,
    format: 'esm',
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent'
  })

  const inputs = Object.keys(result.metafile!.inputs).map(file => file.replaceAll('\\', '/'))
  const imports = Object.values(result.metafile!.outputs).flatMap(output => output.imports.map(each => each.path))

  expect(inputs).toContain('src/matrix/sdk.ts')
  expect(inputs).toContain('src/matrix/sdk-host-queue.ts')
  expect(inputs.some(file => file.startsWith('electron/'))).toBe(false)
  expect(imports).not.toContain('electron')

  if (platform === 'browser') {
    // Nothing for a browser to resolve at run time, and no Node built-in inside.
    expect(imports).toEqual([])
    expect(inputs.some(file => file.startsWith('node:'))).toBe(false)
  }
})
