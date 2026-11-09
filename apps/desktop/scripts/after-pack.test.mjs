import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vitest'

const hookMocks = vi.hoisted(() => ({
  stageBundledRuntime: vi.fn(),
  writeAtumPublicConfig: vi.fn()
}))

vi.mock('./stage-bundled-runtime.mjs', () => ({ stageBundledRuntime: hookMocks.stageBundledRuntime }))
vi.mock('./write-atum-public-config.mjs', async importOriginal => ({
  ...(await importOriginal()),
  writeAtumPublicConfig: hookMocks.writeAtumPublicConfig
}))

import afterPack, { assertProductionGoogleAuthEnabled } from './after-pack.mjs'

const productionConfig = {
  hostedBaseUrl: 'https://deployment.example.invalid',
  supabaseUrl: 'https://public-config.example.invalid',
  providers: { google: true, password: true }
}

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
})

test('packaging accepts the production plane only when Google authentication is enabled', () => {
  assert.equal(assertProductionGoogleAuthEnabled(productionConfig), productionConfig)
  // Both production hostnames are the production plane: the canonical api.
  // name and the historical vercel.app alias older builds still bake.
  const canonical = { ...productionConfig, hostedBaseUrl: 'https://api.atumplatform.com' }
  assert.equal(assertProductionGoogleAuthEnabled(canonical), canonical)
  assert.throws(
    () => assertProductionGoogleAuthEnabled({ ...canonical, providers: { google: false, password: true } }),
    /production plane with Google authentication disabled/
  )
  assert.throws(
    () => assertProductionGoogleAuthEnabled({ ...productionConfig, providers: { google: false, password: true } }),
    /production plane with Google authentication disabled/
  )
  assert.throws(
    () => assertProductionGoogleAuthEnabled({ ...productionConfig, providers: { password: true } }),
    /production plane with Google authentication disabled/
  )
})

test('packaging does not impose the production Google policy on a nonproduction or CI plane', () => {
  const ciConfig = {
    hostedBaseUrl: 'https://atum-ci.invalid',
    supabaseUrl: 'https://atum-ci.supabase.invalid',
    providers: { google: false, password: true }
  }

  assert.equal(assertProductionGoogleAuthEnabled(ciConfig), ciConfig)
  assert.throws(
    () => assertProductionGoogleAuthEnabled({ ...ciConfig, hostedBaseUrl: productionConfig.hostedBaseUrl }),
    /mixed production\/nonproduction Atum control plane/
  )
  assert.throws(
    () => assertProductionGoogleAuthEnabled({ ...ciConfig, supabaseUrl: productionConfig.supabaseUrl }),
    /mixed production\/nonproduction Atum control plane/
  )
})

test('the macOS afterPack hook rejects production Google-off before staging or writing', async () => {
  vi.stubEnv('ATUM_PUBLIC_HOSTED_BASE_URL', productionConfig.hostedBaseUrl)
  vi.stubEnv('ATUM_PUBLIC_SUPABASE_URL', productionConfig.supabaseUrl)
  vi.stubEnv('ATUM_PUBLIC_SUPABASE_ANON_KEY', 'anon-key')
  vi.stubEnv('ATUM_PUBLIC_GOOGLE_AUTH_ENABLED', 'false')

  await assert.rejects(
    () =>
      afterPack({
        appOutDir: '/tmp/atum-after-pack-test',
        electronPlatformName: 'darwin',
        packager: { appInfo: { productFilename: 'Atum' } }
      }),
    /production plane with Google authentication disabled/
  )
  assert.equal(hookMocks.stageBundledRuntime.mock.calls.length, 0)
  assert.equal(hookMocks.writeAtumPublicConfig.mock.calls.length, 0)
})

test('packaging refuses a bundle whose pets are still inside app.asar', async () => {
  const { assertBundledPetsUnpacked } = await import('./after-pack.mjs')
  const appRoot = '/tmp/Atum.app/Contents/Resources'
  const unpacked = '/tmp/Atum.app/Contents/Resources/app.asar.unpacked/assets/pets'
  const fakeFs = (dirs, files) => ({
    readdirSync: dir => {
      if (dir !== unpacked) throw new Error('ENOENT')
      return dirs.map(name => ({ name, isDirectory: () => true }))
    },
    existsSync: file => files.includes(file)
  })

  assert.throws(() => assertBundledPetsUnpacked(appRoot, { fs: { readdirSync: () => { throw new Error('ENOENT') }, existsSync: () => false } }), /not unpacked from app\.asar/)
  assert.throws(() => assertBundledPetsUnpacked(appRoot, { fs: fakeFs([], []) }), /no pets/)
  assert.throws(() => assertBundledPetsUnpacked(appRoot, { fs: fakeFs(['gigi', 'cookie'], [`${unpacked}/gigi/pet.json`]) }), /no pet\.json for cookie/)
  assert.deepEqual(assertBundledPetsUnpacked(appRoot, { fs: fakeFs(['gigi', 'cookie'], [`${unpacked}/gigi/pet.json`, `${unpacked}/cookie/pet.json`]) }), ['gigi', 'cookie'])
})
