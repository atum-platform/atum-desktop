import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'
import { expect, it } from 'vitest'

it('bundles the shared pet canvas without the legacy account, profile or session roots', async () => {
  const result = await build({
    absWorkingDir: fileURLToPath(new URL('../../', import.meta.url)),
    entryPoints: ['src/components/pet/pet-sprite-canvas.tsx'],
    bundle: true,
    write: false,
    metafile: true,
    platform: 'browser',
    format: 'esm',
    logLevel: 'silent'
  })

  const inputs = Object.keys(result.metafile!.inputs).map(file => file.replaceAll('\\', '/'))

  expect(result.outputFiles[0]!.contents.byteLength).toBeGreaterThan(0)
  expect(inputs).toContain('shared/pet.ts')
  expect(inputs.some(file => /src\/(?:store\/|hermes\.ts|themes\/context\.tsx)/u.test(file))).toBe(false)
  expect(inputs.some(file => file.includes('electron/'))).toBe(false)
})

it('keeps the overlay renderer free of Electron, SDK, account and gateway roots', async () => {
  const result = await build({
    absWorkingDir: fileURLToPath(new URL('../../', import.meta.url)),
    entryPoints: ['src/matrix/pet/overlay-root.tsx'],
    bundle: true,
    write: false,
    outdir: '/tmp/matrix-pet-boundary',
    metafile: true,
    platform: 'browser',
    format: 'esm',
    loader: { '.css': 'empty' },
    logLevel: 'silent'
  })

  const inputs = Object.keys(result.metafile!.inputs).map(file => file.replaceAll('\\', '/'))
  expect(result.outputFiles[0]!.contents.byteLength).toBeGreaterThan(0)
  expect(inputs.some(file => /src\/(?:store\/|sdk\/|hermes\.ts|themes\/context\.tsx)/u.test(file))).toBe(false)
  expect(
    inputs.some(file => file.includes('electron/') || /(?:matrix-js-sdk|json-rpc-gateway|gateway\.)/u.test(file))
  ).toBe(false)
})
