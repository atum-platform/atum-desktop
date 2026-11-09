import { useEffect, useRef } from 'react'

import { DEFAULT_LOCALE, type Locale, useI18n } from '@/i18n'
import { readKey, writeKey } from '@/lib/storage'
import { $atumAccountScopeId } from '@/store/atum-messaging'
import {
  $completionSoundVariantId,
  applyCompletionSoundVariantId,
  DEFAULT_COMPLETION_SOUND_VARIANT_ID,
  hasStoredCompletionSoundVariant
} from '@/store/completion-sound'
import {
  $nativeNotifyPrefs,
  applyNativeNotifyPrefs,
  DEFAULT_NATIVE_NOTIFY_PREFS,
  hasStoredNativeNotifyPrefs
} from '@/store/native-notifications'
import { $petRoam, applyPetRoam, hasStoredPetRoam } from '@/store/pet'
import { $activeGatewayProfile, normalizeProfileKey } from '@/store/profile'
import { $zoomPercent, setZoomPercent, storedZoomPercent } from '@/store/zoom'
import { hasStoredThemeMode, type ThemeMode, useTheme } from '@/themes/context'

import type { AtumAccountPreferences, AtumPreferencesStatus } from '../../../shared/atum-account-preferences'

import { $atumAgentArrangements, setAtumAgentArrangementForAccount } from './agents'
import { $chatPinsByAccount, setAtumChatPinsForAccount } from './chat-pins'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const LEGACY_CLAIM_KEY = 'atum.desktop.accountPreferencesLegacyClaim.v1'

type PreferenceField =
  | 'app.appearance_mode'
  | 'app.completion_sound_variant'
  | 'app.language'
  | 'app.notifications'
  | 'app.pet_roaming'
  | 'app.text_size_percent'
  | 'chat_pins'
  | 'roster'

interface PreferenceApplyPort {
  captureLegacyApp(): NonNullable<AtumAccountPreferences['app']>
  applyLocale(locale: Locale): void
  applyMode(mode: ThemeMode): void
}

function overlaySeed(cloud: AtumAccountPreferences, seed: AtumAccountPreferences): AtumAccountPreferences {
  return {
    schema_version: 1,
    ...(cloud.app || seed.app ? { app: { ...seed.app, ...cloud.app } } : {}),
    ...(cloud.roster ? { roster: cloud.roster } : seed.roster ? { roster: seed.roster } : {}),
    ...(cloud.chat_pins ? { chat_pins: cloud.chat_pins } : seed.chat_pins ? { chat_pins: seed.chat_pins } : {})
  }
}

function isAccountId(value: null | string): value is string {
  return Boolean(value && UUID.test(value))
}

function stableIds(ids: readonly string[]): string[] {
  return [...new Set(ids.filter(id => UUID.test(id)))]
}

function mergeSnapshot(snapshot: AtumAccountPreferences, patch: AtumAccountPreferences): AtumAccountPreferences {
  return {
    schema_version: 1,
    ...(snapshot.app || patch.app ? { app: { ...snapshot.app, ...patch.app } } : {}),
    ...(patch.roster ? { roster: patch.roster } : snapshot.roster ? { roster: snapshot.roster } : {}),
    ...(patch.chat_pins ? { chat_pins: patch.chat_pins } : snapshot.chat_pins ? { chat_pins: snapshot.chat_pins } : {})
  }
}

/**
 * Account-scoped renderer adapter. It deliberately names each portable leaf
 * rather than observing general localStorage: profile paths, skins, geometry,
 * credentials, and operating-system permissions never enter this boundary.
 */
export class AccountPreferencesSynchronizer {
  private activeAccount: null | string = null
  private activationSeed: AtumAccountPreferences | null = null
  private legacyAppClaim: null | { accountId: string; app: NonNullable<AtumAccountPreferences['app']> } = null
  private generation = 0
  private muted = false
  private readonly cached = new Map<string, AtumAccountPreferences>()
  private readonly pending = new Map<PreferenceField, AtumAccountPreferences>()
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private seedAttemptedGeneration: null | number = null
  private readonly watched = new Map<PreferenceField, unknown>()
  private ready = false

  constructor(private port: PreferenceApplyPort) {}

  setPort(port: PreferenceApplyPort): void {
    this.port = port
  }

  activate(accountId: null | string): void {
    this.generation += 1
    this.activeAccount = isAccountId(accountId) ? accountId : null
    this.ready = false
    this.pending.clear()
    this.watched.clear()
    this.seedAttemptedGeneration = null
    clearTimeout(this.retryTimer)
    // Capture before restoring the target account's cached/default values.
    // Otherwise an empty B would erase the only local A-era value eligible for
    // the documented first-account legacy claim.
    this.activationSeed = this.activeAccount ? this.collectSeed(this.activeAccount) : null

    this.apply(
      this.activeAccount
        ? (this.cached.get(this.activeAccount) ?? this.activationSeed ?? { schema_version: 1 })
        : { schema_version: 1 }
    )

    if (this.activeAccount) {
      void this.load(this.activeAccount, this.generation)
    }
  }

  async refresh(): Promise<void> {
    if (this.activeAccount) {
      await this.load(this.activeAccount, this.generation)
    }
  }

  observe(field: PreferenceField, value: unknown, patch: AtumAccountPreferences): void {
    const previous = this.watched.get(field)
    this.watched.set(field, value)

    if (
      this.muted ||
      previous === undefined ||
      JSON.stringify(previous) === JSON.stringify(value) ||
      !this.activeAccount
    ) {
      return
    }

    this.pending.set(field, patch)

    if (this.ready) {
      this.flush(field, patch)
    }
  }

  dispose(): void {
    this.generation += 1
    this.activeAccount = null
    this.activationSeed = null
    this.pending.clear()
    clearTimeout(this.retryTimer)
  }

  private bridge() {
    return window.hermesDesktop?.agentSync
  }

  private async load(accountId: string, generation: number): Promise<void> {
    const bridge = this.bridge()

    if (!bridge?.preferences) {
      return
    }

    try {
      const result = (await bridge.preferences()) as AtumPreferencesStatus

      if (generation !== this.generation || accountId !== this.activeAccount || result.accountId !== accountId) {
        return
      }

      const snapshot =
        result.revision === 0
          ? overlaySeed(result.snapshot, this.activationSeed ?? { schema_version: 1 })
          : result.snapshot

      this.cached.set(accountId, snapshot)
      this.apply(overlaySeed(snapshot, this.activationSeed ?? { schema_version: 1 }))
      this.ready = true

      if (result.revision === 0 && this.seedAttemptedGeneration !== generation) {
        this.seedAttemptedGeneration = generation
        const seed = this.activationSeed ?? { schema_version: 1 }

        if (Object.keys(seed).length > 1) {
          await bridge.seedPreferences?.(accountId, seed)

          if (generation !== this.generation || accountId !== this.activeAccount) {
            return
          }

        }
      }

      for (const [field, patch] of this.pending) {
        this.flush(field, patch)
      }
    } catch {
      // A transient account read leaves the current cache/defaults visible. A
      // later main-process onChanged event or account activation retries it.
    }
  }

  private flush(field: PreferenceField, patch: AtumAccountPreferences): void {
    const accountId = this.activeAccount
    const bridge = this.bridge()

    if (!accountId || !bridge?.patchPreferences || this.pending.get(field) !== patch) {
      return
    }

    void bridge
      .patchPreferences(accountId, patch)
      .then(() => {
        if (accountId !== this.activeAccount || this.pending.get(field) !== patch) {
          return
        }

        this.cached.set(accountId, mergeSnapshot(this.cached.get(accountId) ?? { schema_version: 1 }, patch))
        this.pending.delete(field)
      })
      .catch(() => {
        if (accountId === this.activeAccount && this.pending.get(field) === patch) {
          // Keep explicit intent across a temporary IPC failure. The main
          // process serializes accepted writes; this bounded renderer retry
          // only gets the still-current leaf to that queue.
          clearTimeout(this.retryTimer)
          this.retryTimer = setTimeout(() => this.flush(field, patch), 500)
        }
      })
  }

  private apply(snapshot: AtumAccountPreferences): void {
    // Account discovery is asynchronous. A signed-out/pre-account render must
    // never replace device settings or persist defaults before legacy capture.
    if (!this.activeAccount) { return }

    const app = snapshot.app
    const mayApply = (field: PreferenceField) => !this.pending.has(field)

    this.muted = true

    try {
      if (mayApply('app.language') && app?.language) {
        this.port.applyLocale(app.language)
        this.watched.set('app.language', app.language)
      } else if (mayApply('app.language')) {
        this.port.applyLocale(DEFAULT_LOCALE)
        this.watched.set('app.language', DEFAULT_LOCALE)
      }

      if (mayApply('app.appearance_mode') && app?.appearance_mode) {
        this.port.applyMode(app.appearance_mode)
        this.watched.set('app.appearance_mode', app.appearance_mode)
      } else if (mayApply('app.appearance_mode')) {
        this.port.applyMode('system')
        this.watched.set('app.appearance_mode', 'system')
      }

      if (mayApply('app.text_size_percent') && app?.text_size_percent !== undefined) {
        setZoomPercent(app.text_size_percent)
        this.watched.set('app.text_size_percent', app.text_size_percent)
      } else if (!this.watched.has('app.text_size_percent')) {
        this.watched.set('app.text_size_percent', Math.round($zoomPercent.get()))
      }

      if (mayApply('app.notifications')) {
        applyNativeNotifyPrefs(app?.notifications ?? DEFAULT_NATIVE_NOTIFY_PREFS)
        this.watched.set('app.notifications', app?.notifications ?? DEFAULT_NATIVE_NOTIFY_PREFS)
      }

      if (mayApply('app.completion_sound_variant')) {
        applyCompletionSoundVariantId(app?.completion_sound_variant ?? DEFAULT_COMPLETION_SOUND_VARIANT_ID)
        this.watched.set(
          'app.completion_sound_variant',
          app?.completion_sound_variant ?? DEFAULT_COMPLETION_SOUND_VARIANT_ID
        )
      }

      if (mayApply('app.pet_roaming')) {
        applyPetRoam(app?.pet_roaming ?? true)
        this.watched.set('app.pet_roaming', app?.pet_roaming ?? true)
      }

      if (mayApply('roster')) {
        if (this.activeAccount) {
          setAtumAgentArrangementForAccount(this.activeAccount, snapshot.roster ?? { order: [], pins: [] })
          this.watched.set('roster', snapshot.roster ?? { order: [], pins: [] })
        }
      }

      if (mayApply('chat_pins')) {
        if (this.activeAccount) {
          setAtumChatPinsForAccount(this.activeAccount, snapshot.chat_pins ?? [])
          this.watched.set('chat_pins', snapshot.chat_pins ?? [])
        }
      }
    } finally {
      this.muted = false
    }
  }

  private collectSeed(accountId: string): AtumAccountPreferences {
    const snapshot: AtumAccountPreferences = { schema_version: 1 }
    const app: NonNullable<AtumAccountPreferences['app']> = {}

    // Defaults are never seed intent. These stores can all report whether a
    // persisted value existed before the adapter saw them.
    const legacyClaim = readKey(LEGACY_CLAIM_KEY)
    const retainedClaim = this.legacyAppClaim

    if (legacyClaim === null) {
      // This is the one moment machine-global app preferences may be read.
      // Claim before applying any account cache/default so a fast existing-cloud
      // response for A cannot leave B eligible to inherit A's values.
      const captured = this.port.captureLegacyApp()

      if (hasStoredNativeNotifyPrefs()) {
        captured.notifications = $nativeNotifyPrefs.get()
      }

      if (hasStoredCompletionSoundVariant()) {
        captured.completion_sound_variant = $completionSoundVariantId.get()
      }

      if (hasStoredPetRoam()) {
        captured.pet_roaming = $petRoam.get()
      }

      this.legacyAppClaim = { accountId, app: captured }
      writeKey(LEGACY_CLAIM_KEY, accountId)
      Object.assign(app, captured)
    } else if (retainedClaim?.accountId === accountId) {
      // Never reread global stores here: while B is foreground they already
      // describe B's live account state, not A's pre-sync local intent.
      Object.assign(app, retainedClaim.app)
    }

    if (Object.keys(app).length) {
      snapshot.app = app
    }

    const arrangement = $atumAgentArrangements.get()[accountId]

    if (arrangement) {
      snapshot.roster = { order: stableIds(arrangement.order), pins: stableIds(arrangement.pins) }
    }

    const chatPins = $chatPinsByAccount.get()[accountId]

    if (chatPins) {
      snapshot.chat_pins = stableIds(chatPins).slice(0, 5)
    }

    return snapshot
  }
}

/** Mount once below I18nProvider and ThemeProvider. The root only composes it. */
export function AccountPreferencesSync() {
  const { applyLocale, hasConfiguredLocale, isLoadingConfig, locale } = useI18n()
  const { applyMode, mode } = useTheme()
  const sync = useRef<AccountPreferencesSynchronizer | null>(null)

  if (!sync.current) {
    sync.current = new AccountPreferencesSynchronizer({
      applyLocale,
      applyMode,
      captureLegacyApp: () => ({})
    })
  }

  const controller = sync.current
  const persistedZoom = storedZoomPercent()

  controller.setPort({
    applyLocale,
    applyMode,
    captureLegacyApp: () => ({
      ...(hasConfiguredLocale && (locale === 'vi' || locale === 'en') ? { language: locale } : {}),
      ...(hasStoredThemeMode(normalizeProfileKey($activeGatewayProfile.get())) ? { appearance_mode: mode } : {}),
      ...(persistedZoom !== null ? { text_size_percent: persistedZoom } : {})
    })
  })

  useEffect(() => {
    if (isLoadingConfig) {
      return
    }

    controller.activate($atumAccountScopeId.get())

    const stopAccount = $atumAccountScopeId.listen(next => controller.activate(next))
    const stopChanged = window.hermesDesktop?.agentSync?.onChanged(() => void controller.refresh())

    const stopNotifications = $nativeNotifyPrefs.listen(next =>
      controller.observe('app.notifications', next, { schema_version: 1, app: { notifications: next } })
    )

    const stopSound = $completionSoundVariantId.listen(next =>
      controller.observe('app.completion_sound_variant', next, {
        schema_version: 1,
        app: { completion_sound_variant: next }
      })
    )

    const stopRoam = $petRoam.listen(next =>
      controller.observe('app.pet_roaming', next, { schema_version: 1, app: { pet_roaming: next } })
    )

    const stopZoom = $zoomPercent.listen(next => {
      const canonical = Math.round(next)

      controller.observe('app.text_size_percent', canonical, {
        schema_version: 1,
        app: { text_size_percent: canonical }
      })
    })

    const stopRoster = $atumAgentArrangements.listen(arrangements => {
      const accountId = $atumAccountScopeId.get()

      if (!accountId) {
        return
      }

      const next = arrangements[accountId] ?? { order: [], pins: [] }
      controller.observe('roster', next, {
        schema_version: 1,
        roster: { order: stableIds(next.order), pins: stableIds(next.pins) }
      })
    })

    const stopChats = $chatPinsByAccount.listen(pinsByAccount => {
      const accountId = $atumAccountScopeId.get()

      if (!accountId) {
        return
      }

      const next = pinsByAccount[accountId] ?? []
      controller.observe('chat_pins', next, { schema_version: 1, chat_pins: stableIds(next).slice(0, 5) })
    })

    return () => {
      stopAccount()
      stopChanged?.()
      stopNotifications()
      stopSound()
      stopRoam()
      stopZoom()
      stopRoster()
      stopChats()
      controller.dispose()
    }
  }, [controller, isLoadingConfig])

  useEffect(() => {
    controller.observe('app.language', locale, { schema_version: 1, app: { language: locale === 'vi' ? 'vi' : 'en' } })
  }, [controller, locale])

  useEffect(() => {
    controller.observe('app.appearance_mode', mode, { schema_version: 1, app: { appearance_mode: mode } })
  }, [controller, mode])

  return null
}
