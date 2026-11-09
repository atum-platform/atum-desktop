import { afterEach, describe, expect, it, vi } from 'vitest'

import { MATRIX_BACKGROUND_SWEEP_SETTING_PROFILE } from '../../shared/background-sweep'

import {
  parseMatrixBackgroundSweepSetting,
  readMatrixBackgroundSweepSetting,
  validMatrixBackgroundSweepWrite,
  writeMatrixBackgroundSweepSetting
} from './background-sweep-settings'

const ASSISTANT = '00000000-0000-4000-8000-288c0dd127cf'
const REQUEST = '00000000-0000-4000-8000-93342ecaba36'
const setting = (enabled = true, revision = 1, activeForOwner = true) => ({
  profile: MATRIX_BACKGROUND_SWEEP_SETTING_PROFILE,
  assistantId: ASSISTANT,
  enabled,
  revision,
  activeForOwner
})

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the background follow-up owner setting transport', () => {
  it('accepts only the frozen snapshot and write shapes', () => {
    expect(parseMatrixBackgroundSweepSetting(setting())).toEqual(setting())
    expect(parseMatrixBackgroundSweepSetting(setting(true, 1, false))).toEqual(setting(true, 1, false))
    expect(parseMatrixBackgroundSweepSetting({ ...setting(), owner: 'forged' })).toBeNull()
    expect(parseMatrixBackgroundSweepSetting({ ...setting(), revision: 0 })).toBeNull()
    expect(parseMatrixBackgroundSweepSetting({ ...setting(), activeForOwner: undefined })).toBeNull()

    const write = {
      profile: MATRIX_BACKGROUND_SWEEP_SETTING_PROFILE,
      requestId: REQUEST,
      expectedRevision: 1,
      enabled: false
    }
    expect(validMatrixBackgroundSweepWrite(write)).toBe(true)
    expect(validMatrixBackgroundSweepWrite({ ...write, model: 'expensive' })).toBe(false)
    expect(validMatrixBackgroundSweepWrite({ ...write, agentPrincipal: ASSISTANT })).toBe(false)
  })

  it('reads only the addressed assistant with the native-held bearer', async () => {
    const fetch = vi.fn(async () => json(setting()))
    vi.stubGlobal('fetch', fetch)

    await expect(
      readMatrixBackgroundSweepSetting(
        'https://platform.test/api/matrix/v1',
        'secret',
        ASSISTANT,
        new AbortController().signal
      )
    ).resolves.toEqual(setting())
    expect(fetch).toHaveBeenCalledWith(
      `https://platform.test/api/matrix/v1/agents/${ASSISTANT}/background-sweep`,
      expect.objectContaining({
        method: 'GET',
        headers: { Authorization: 'Bearer secret', Accept: 'application/json' },
        credentials: 'omit',
        redirect: 'error'
      })
    )
  })

  it('posts the exact CAS write and returns authoritative server truth', async () => {
    let sent: RequestInit | undefined
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent = init
      return json(setting(false, 2))
    })
    vi.stubGlobal('fetch', fetch)
    const write = {
      profile: MATRIX_BACKGROUND_SWEEP_SETTING_PROFILE,
      requestId: REQUEST,
      expectedRevision: 1,
      enabled: false
    } as const

    await expect(
      writeMatrixBackgroundSweepSetting(
        'https://platform.test/api/matrix/v1',
        'secret',
        ASSISTANT,
        write,
        new AbortController().signal
      )
    ).resolves.toEqual({ status: 'saved', setting: setting(false, 2) })
    expect(JSON.parse(String(sent?.body))).toEqual(write)
  })

  it('returns the current snapshot on a revision conflict', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(setting(true, 3), 409))
    )

    await expect(
      writeMatrixBackgroundSweepSetting(
        'https://platform.test/api/matrix/v1',
        'secret',
        ASSISTANT,
        {
          profile: MATRIX_BACKGROUND_SWEEP_SETTING_PROFILE,
          requestId: REQUEST,
          expectedRevision: 1,
          enabled: false
        },
        new AbortController().signal
      )
    ).resolves.toEqual({ status: 'conflict', setting: setting(true, 3) })
  })

  it('fails closed on the wrong assistant or a non-JSON answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ ...setting(), assistantId: REQUEST }))
    )
    await expect(
      readMatrixBackgroundSweepSetting('https://platform.test', 'secret', ASSISTANT, new AbortController().signal)
    ).rejects.toThrow('matrix_background_sweep_invalid')

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('no', { status: 200, headers: { 'Content-Type': 'text/plain' } }))
    )
    await expect(
      readMatrixBackgroundSweepSetting('https://platform.test', 'secret', ASSISTANT, new AbortController().signal)
    ).rejects.toThrow('matrix_background_sweep_unavailable')
  })
})
