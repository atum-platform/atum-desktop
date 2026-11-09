import { beforeEach, describe, expect, it, vi } from 'vitest'

import { setCompletionSoundVariantId } from '@/store/completion-sound'
import { $petRoam } from '@/store/pet'

import type { AtumPreferencesStatus } from '../../../shared/atum-account-preferences'

import { AccountPreferencesSynchronizer } from './account-preferences-sync'

const ACCOUNT_A = '00000000-0000-1000-8000-2ffe00a2071e'
const ACCOUNT_B = '00000000-0000-1000-8000-ac768db8b68e'

function status(
  accountId: string,
  snapshot: AtumPreferencesStatus['snapshot'] = { schema_version: 1 }
): AtumPreferencesStatus {
  return { accountId, revision: 0, snapshot, status: 'synced' }
}

async function settle() {
  await Promise.resolve()
  await Promise.resolve()
}

describe('AccountPreferencesSynchronizer', () => {
  const applyLocale = vi.fn()
  const applyMode = vi.fn()
  const preferences = vi.fn<() => Promise<AtumPreferencesStatus>>()
  const patchPreferences = vi.fn<(account: string, patch: AtumPreferencesStatus['snapshot']) => Promise<void>>()
  const seedPreferences = vi.fn<(account: string, snapshot: AtumPreferencesStatus['snapshot']) => Promise<void>>()

  beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.clear()
    $petRoam.set(true)
    preferences.mockResolvedValue(status(ACCOUNT_A))
    patchPreferences.mockResolvedValue()
    seedPreferences.mockResolvedValue()
    window.hermesDesktop = {
      agentSync: {
        onChanged: () => () => {},
        patchPreferences,
        preferences,
        seedPreferences
      }
    } as unknown as typeof window.hermesDesktop
  })

  function sync(legacyApp: AtumPreferencesStatus['snapshot']['app'] = {}) {
    return new AccountPreferencesSynchronizer({ applyLocale, applyMode, captureLegacyApp: () => legacyApp ?? {} })
  }

  it('leaves signed-out settings untouched before account discovery and on sign-out', async () => {
    const setPercent = vi.fn()
    window.hermesDesktop.zoom = { setPercent } as unknown as typeof window.hermesDesktop.zoom
    window.localStorage.setItem('hermes:desktop:zoomLevel', '1')
    $petRoam.set(false)
    const controller = sync({ language: 'en', appearance_mode: 'dark', text_size_percent: 120 })
    controller.activate(null)
    await settle()
    expect(setPercent).not.toHaveBeenCalled()
    expect(applyLocale).not.toHaveBeenCalled()
    expect(applyMode).not.toHaveBeenCalled()
    expect($petRoam.get()).toBe(false)
    expect(window.localStorage.getItem('hermes:desktop:zoomLevel')).toBe('1')
    controller.activate(ACCOUNT_A)
    await settle()
    expect(seedPreferences).toHaveBeenCalledWith(ACCOUNT_A, expect.objectContaining({
      app: expect.objectContaining({ text_size_percent: 120, language: 'en' })
    }))
    setPercent.mockClear()
    applyLocale.mockClear()
    controller.activate(null)
    expect(setPercent).not.toHaveBeenCalled()
    expect(applyLocale).not.toHaveBeenCalled()
  })

  it('drops an old account read after switching accounts', async () => {
    let resolveA: (value: AtumPreferencesStatus) => void = () => {}

    let resolveB: (value: AtumPreferencesStatus) => void = () => {}
    preferences
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            resolveA = resolve
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            resolveB = resolve
          })
      )

    const controller = sync()
    controller.activate(ACCOUNT_A)
    controller.activate(ACCOUNT_B)
    resolveA(status(ACCOUNT_A, { schema_version: 1, app: { language: 'en' } }))
    resolveB(status(ACCOUNT_B, { schema_version: 1, app: { language: 'vi' } }))
    await settle()

    expect(applyLocale).not.toHaveBeenCalledWith('en')
    expect(applyLocale).toHaveBeenLastCalledWith('vi')
  })

  it('does not persist default zoom on a returning account while its snapshot loads', async () => {
    const setPercent = vi.fn()
    window.hermesDesktop.zoom = { setPercent } as unknown as typeof window.hermesDesktop.zoom
    window.localStorage.setItem('atum.desktop.accountPreferencesLegacyClaim.v1', ACCOUNT_A)
    preferences.mockResolvedValue({ ...status(ACCOUNT_A), revision: 2 })
    const controller = sync()
    controller.activate(ACCOUNT_A)
    await settle()
    expect(setPercent).not.toHaveBeenCalled()
    controller.observe('app.text_size_percent', 110, { schema_version: 1, app: { text_size_percent: 110 } })
    expect(patchPreferences).toHaveBeenCalledWith(ACCOUNT_A, { schema_version: 1, app: { text_size_percent: 110 } })
  })

  it('does not echo an applied remote value back as a patch', async () => {
    preferences.mockResolvedValue(status(ACCOUNT_A, { schema_version: 1, app: { pet_roaming: false } }))
    const controller = sync()

    controller.activate(ACCOUNT_A)
    await settle()
    controller.observe('app.pet_roaming', false, { schema_version: 1, app: { pet_roaming: false } })

    expect(patchPreferences).not.toHaveBeenCalled()
  })

  it('does not echo a remote locale after the provider has rendered it', async () => {
    preferences.mockResolvedValue(status(ACCOUNT_A, { schema_version: 1, app: { language: 'en' } }))
    const controller = sync()

    controller.activate(ACCOUNT_A)
    await settle()
    // This mirrors the I18nProvider's next render after applyLocale(), when
    // the effect observes the new context value rather than the synchronous
    // store setter used by the other preferences.
    controller.observe('app.language', 'en', { schema_version: 1, app: { language: 'en' } })

    expect(patchPreferences).not.toHaveBeenCalled()
  })

  it('does not publish fresh defaults as a seed', async () => {
    preferences.mockResolvedValue({ ...status(ACCOUNT_A), status: 'pending' })
    const controller = sync()

    controller.activate(ACCOUNT_A)
    await settle()

    expect(seedPreferences).not.toHaveBeenCalled()
  })

  it('seeds an empty revision-zero cloud row even when main has already marked it synced', async () => {
    preferences.mockResolvedValue(status(ACCOUNT_A))
    const controller = sync({ appearance_mode: 'dark' })

    controller.activate(ACCOUNT_A)
    await settle()

    expect(seedPreferences).toHaveBeenCalledWith(ACCOUNT_A, {
      schema_version: 1,
      app: { appearance_mode: 'dark' }
    })
  })

  it('keeps an explicit legacy dark mode visible while the empty cloud row seeds', async () => {
    const controller = sync({ appearance_mode: 'dark' })

    controller.activate(ACCOUNT_A)
    await settle()

    expect(applyMode).toHaveBeenLastCalledWith('dark')
  })

  it('claims legacy app settings for A before an existing cloud row can expose B', async () => {
    preferences
      .mockResolvedValueOnce({ ...status(ACCOUNT_A, { schema_version: 1, app: { language: 'en' } }), revision: 3 })
      .mockResolvedValueOnce(status(ACCOUNT_B))
    const captureLegacyApp = vi.fn(() => ({ appearance_mode: 'dark' as const, text_size_percent: 120 }))
    const controller = new AccountPreferencesSynchronizer({ applyLocale, applyMode, captureLegacyApp })

    controller.activate(ACCOUNT_A)
    await settle()
    controller.activate(ACCOUNT_B)
    await settle()

    expect(captureLegacyApp).toHaveBeenCalledTimes(1)
    expect(seedPreferences).not.toHaveBeenCalledWith(
      ACCOUNT_B,
      expect.objectContaining({ app: expect.objectContaining({ appearance_mode: 'dark' }) })
    )
    expect(applyMode).toHaveBeenLastCalledWith('system')
  })

  it('keeps the first account claim immutable across A → B → A', async () => {
    preferences.mockResolvedValue(status(ACCOUNT_A))
    const captureLegacyApp = vi.fn(() => ({ appearance_mode: 'dark' as const }))
    const controller = new AccountPreferencesSynchronizer({ applyLocale, applyMode, captureLegacyApp })

    controller.activate(ACCOUNT_A)
    await settle()
    preferences.mockResolvedValue(status(ACCOUNT_B))
    controller.activate(ACCOUNT_B)
    await settle()
    preferences.mockResolvedValue(status(ACCOUNT_A))
    controller.activate(ACCOUNT_A)
    await settle()

    expect(captureLegacyApp).toHaveBeenCalledTimes(1)
    expect(applyMode).toHaveBeenLastCalledWith('dark')
  })

  it('persists an explicit edit and holds it against a changed notification until queued', async () => {
    let resolvePatch: () => void = () => {}
    patchPreferences.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          resolvePatch = resolve
        })
    )
    preferences.mockResolvedValue(status(ACCOUNT_A, { schema_version: 1, app: { pet_roaming: false } }))
    const controller = sync()

    controller.activate(ACCOUNT_A)
    await settle()
    $petRoam.set(true)
    controller.observe('app.pet_roaming', true, { schema_version: 1, app: { pet_roaming: true } })

    expect(patchPreferences).toHaveBeenCalledWith(ACCOUNT_A, { schema_version: 1, app: { pet_roaming: true } })

    await controller.refresh()
    expect($petRoam.get()).toBe(true)

    resolvePatch()
    await settle()
  })

  it('claims legacy global values for the first signed-in account only', async () => {
    setCompletionSoundVariantId(2)
    preferences
      .mockResolvedValueOnce({ ...status(ACCOUNT_A), status: 'pending' })
      .mockResolvedValueOnce({ ...status(ACCOUNT_B), status: 'pending' })
    const controller = sync()

    controller.activate(ACCOUNT_A)
    await settle()
    controller.activate(ACCOUNT_B)
    await settle()

    expect(seedPreferences).toHaveBeenCalledTimes(1)
    expect(seedPreferences).toHaveBeenCalledWith(ACCOUNT_A, {
      schema_version: 1,
      app: { completion_sound_variant: 2 }
    })
  })

  it('retains an explicit edit and retries a transient bridge failure', async () => {
    vi.useFakeTimers()
    patchPreferences.mockRejectedValueOnce(new Error('temporary')).mockResolvedValueOnce()
    const controller = sync()

    controller.activate(ACCOUNT_A)
    await settle()
    controller.observe('app.pet_roaming', false, { schema_version: 1, app: { pet_roaming: false } })
    await settle()
    await vi.advanceTimersByTimeAsync(500)

    expect(patchPreferences).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('does not echo a remote zoom value after canonical rounding', async () => {
    preferences.mockResolvedValue(status(ACCOUNT_A, { schema_version: 1, app: { text_size_percent: 110 } }))
    const controller = sync()

    controller.activate(ACCOUNT_A)
    await settle()
    controller.observe('app.text_size_percent', Math.round(110.000000001), {
      schema_version: 1,
      app: { text_size_percent: 110 }
    })

    expect(patchPreferences).not.toHaveBeenCalled()
  })
})
