import * as requireFs from 'node:fs'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const { unpack, digest } = vi.hoisted(() => ({ unpack: vi.fn(), digest: vi.fn() }))
vi.mock('node:child_process', () => ({ execFileSync: unpack }))
vi.mock('node:crypto', () => ({ createHash: () => ({ update: () => ({ digest }) }) }))
import beforePack from './stage-cloudflared.mjs'

const homes = []
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
})
it('stages a pinned executable into the app directory and rejects corrupt archives', async () => {
  const appDir = await mkdtemp(path.join(tmpdir(), 'atum-package-helper-'))
  homes.push(appDir)
  vi.stubGlobal('fetch', vi.fn(async () => new Response('fixture archive')))
  digest.mockReturnValue('8c2f90277ef06a6080bb40b964d33f09f1188102f8798f2e344174b6cf41accf')
  unpack.mockImplementation((_file, args) => {
    if (args[0] === 'swiftc') {
      requireFs.writeFileSync(args.at(-1), 'compiled relay fixture')
      return
    }
    const bytes = Buffer.alloc(8)
    bytes.writeUInt32LE(0x100000c, 4)
    // The real archive extraction is synchronous.
    requireFs.writeFileSync(path.join(args[3], 'cloudflared'), bytes)
  })
  await beforePack({ electronPlatformName: 'darwin', arch: 3, packager: { info: { appDir } } })
  expect((await stat(path.join(appDir, 'cloudflared'))).mode & 0o777).toBe(0o755)
  expect((await readFile(path.join(appDir, 'cloudflared'))).readUInt32LE(4)).toBe(0x100000c)
  // Every executable staged by beforePack must remain addressable outside ASAR.
  for (const builder of ['matrix-builder.json', 'matrix-release-builder.json']) {
    const config = JSON.parse(await readFile(new URL('../' + builder, import.meta.url), 'utf8'))
    for (const helper of await readdir(appDir)) {
      expect(config.asarUnpack, builder + ': ' + helper).toContain(helper)
      expect((await stat(path.join(appDir, helper))).mode & 0o111).not.toBe(0)
    }
  }
  digest.mockReturnValue('invalid')
  await expect(beforePack({ electronPlatformName: 'darwin', arch: 3, packager: { info: { appDir } } })).rejects.toThrow('digest')
})
