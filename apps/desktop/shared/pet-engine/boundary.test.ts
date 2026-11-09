import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'
import { expect, it } from 'vitest'

it('bundles the portable engine for a browser with only portable shared modules', async () => {
  const result = await build({
    absWorkingDir: fileURLToPath(new URL('../', import.meta.url)),
    entryPoints: ['pet-engine/decide.ts', 'pet-engine/motion.ts', 'pet-engine/lane.ts'],
    outdir: 'unused',
    bundle: true,
    write: false,
    metafile: true,
    platform: 'browser',
    format: 'esm',
    logLevel: 'silent'
  })

  const inputs = Object.keys(result.metafile!.inputs).map(file => file.replaceAll('\\', '/'))

  expect(result.outputFiles.every(file => file.contents.byteLength > 0)).toBe(true)
  expect(inputs.every(file => file.startsWith('pet-engine/') || file === 'pet.ts')).toBe(true)
})
