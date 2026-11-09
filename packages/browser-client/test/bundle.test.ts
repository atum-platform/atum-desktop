import { expect, it } from 'vitest'

// Inspect the actual bundler dependency graph, not source text or source regexes.
it('bundles canonical SDK + openid-client for a browser with no native imports', async () => {
  // @ts-expect-error The build script is intentionally plain Node ESM.
  const { bundle } = await import('../build.mjs')
  const result = await bundle(false)
  const inputs: string[] = Object.keys(result.metafile.inputs)
  for (const module of ['sdk.ts', 'sdk-host-serve.ts', 'sdk-host-queue.ts']) {
    expect(inputs.some(file => file.endsWith(`/apps/desktop/src/matrix/${module}`))).toBe(true)
  }
  expect(inputs.some(file => file.includes('openid-client/build/index.js'))).toBe(true)
  expect(inputs.some(file => file.includes('/electron/'))).toBe(false)
  const imports = Object.values(result.metafile.outputs).flatMap((output: any) => output.imports)
  expect(imports.some((entry: any) => entry.path === '/crypto/index.mjs')).toBe(true)
  expect(imports.some((entry: any) => /^(node:|electron|fs$|path$)/.test(entry.path))).toBe(false)
})
