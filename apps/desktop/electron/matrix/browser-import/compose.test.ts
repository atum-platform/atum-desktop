import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createBrowserImport } from './compose'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function host(change: Partial<Parameters<typeof createBrowserImport>[0]> = {}) {
  const userData = mkdtempSync(path.join(tmpdir(), 'atum-compose-'))
  dirs.push(userData)

  return {
    userData,
    options: {
      home: userData,
      userData,
      identity: () => undefined,
      call: vi.fn(),
      owner: () => '@owner:atum.example',
      primaryAgent: () => ({ principal: '00000000-0000-4000-8000-bd7662a5eeb4', name: 'Nova' }),
      locale: () => 'en',
      setPaused: vi.fn(),
      log: vi.fn(),
      ...change
    } satisfies Parameters<typeof createBrowserImport>[0]
  }
}

describe('composing the import for main', () => {
  it('is ready for a signed-in owner and unavailable without one', async () => {
    const { options } = host()
    const service = createBrowserImport(options)

    expect(await service.status()).toMatchObject({ state: process.platform === 'darwin' ? 'ready' : 'unavailable' })

    const out = createBrowserImport(host({ owner: () => null }).options)

    expect(await out.status()).toEqual({ state: 'unavailable' })
  })

  it('finds no Chrome in an empty home without asking the platform or the Keychain for anything', async () => {
    const call = vi.fn()
    const log = vi.fn()
    const service = createBrowserImport(host({ call, log }).options)

    const outcome = await service.run()

    expect(outcome).toEqual({
      outcome: 'unavailable',
      reason: process.platform === 'darwin' ? 'chrome_not_found' : 'unsupported'
    })
    expect(call).not.toHaveBeenCalled()
  })

  it('keeps its one record in the user data folder, and nowhere is created before an import succeeds', () => {
    const { options, userData } = host()
    createBrowserImport(options)

    expect(readdirSync(userData)).toEqual([])
  })
})
