import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react'

import type { HermesConfigRecord } from '@/hermes'

import { TRANSLATIONS } from './catalog'
import {
  DEFAULT_LOCALE,
  FALLBACK_LOCALE,
  isSupportedLocaleValue,
  localeConfigValue,
  normalizeLocale
} from './languages'
import { setRuntimeI18nLocale } from './runtime'
import type { Locale, Translations } from './types'

export { LOCALE_META } from './languages'

export interface I18nConfigClient {
  getConfig: () => Promise<HermesConfigRecord>
  saveConfig: (config: HermesConfigRecord) => Promise<{ ok: boolean }>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function getConfigDisplayLanguage(config: HermesConfigRecord): unknown {
  return isRecord(config.display) ? config.display.language : undefined
}

export function withConfigDisplayLanguage(config: HermesConfigRecord, locale: Locale): HermesConfigRecord {
  const display = isRecord(config.display) ? config.display : {}

  return {
    ...config,
    display: {
      ...display,
      language: localeConfigValue(locale)
    }
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

export interface I18nContextValue {
  configLoadError: Error | null
  hasConfiguredLocale: boolean
  isLoadingConfig: boolean
  isSavingLocale: boolean
  locale: Locale
  /** Apply an already-authoritative locale without writing profile config. */
  applyLocale: (next: Locale) => void
  saveError: Error | null
  setLocale: (next: Locale) => Promise<void>
  t: Translations
}

const I18nContext = createContext<I18nContextValue>({
  configLoadError: null,
  hasConfiguredLocale: false,
  isLoadingConfig: false,
  isSavingLocale: false,
  // The mounted app always owns an I18nProvider. English here keeps isolated
  // components and emergency renders on the complete catalog.
  locale: FALLBACK_LOCALE,
  applyLocale: () => {},
  saveError: null,
  setLocale: async () => {},
  t: TRANSLATIONS[FALLBACK_LOCALE]
})

export interface I18nProviderProps {
  children: ReactNode
  configClient?: I18nConfigClient | null
  initialLocale?: unknown
}

export function I18nProvider({ children, configClient = null, initialLocale }: I18nProviderProps) {
  const [locale, setLocaleState] = useState<Locale>(() => normalizeLocale(initialLocale))
  // The sync adapter mounts beneath this provider. Start in loading state so
  // it cannot seed/reset language before the existing config value arrives.
  const [isLoadingConfig, setIsLoadingConfig] = useState(() => Boolean(configClient))
  const [hasConfiguredLocale, setHasConfiguredLocale] = useState(false)
  const [isSavingLocale, setIsSavingLocale] = useState(false)
  const [configLoadError, setConfigLoadError] = useState<Error | null>(null)
  const [saveError, setSaveError] = useState<Error | null>(null)

  useEffect(() => {
    setRuntimeI18nLocale(locale)
    document.documentElement.lang = locale
  }, [locale])

  useEffect(() => {
    if (!configClient) {
      return
    }

    let cancelled = false

    setIsLoadingConfig(true)
    setConfigLoadError(null)

    configClient
      .getConfig()
      .then(config => {
        if (!cancelled) {
          const configured = getConfigDisplayLanguage(config)
          const next = normalizeLocale(configured)
          setHasConfiguredLocale(isSupportedLocaleValue(configured))
          setLocaleState(next)
          void window.hermesDesktop?.setLocale?.(next)
        }
      })
      .catch(error => {
        if (!cancelled) {
          setHasConfiguredLocale(false)
          setConfigLoadError(toError(error))
          setLocaleState(DEFAULT_LOCALE)
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingConfig(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [configClient, initialLocale])

  const setLocale = useCallback(
    async (next: Locale) => {
      // Roll back to this render's visible locale. An effect-maintained ref
      // can still hold the startup default when a newly loaded locale paints.
      const previousLocale = locale

      setSaveError(null)
      setLocaleState(next)

      if (!configClient) {
        return
      }

      setIsSavingLocale(true)

      try {
        const latestConfig = await configClient.getConfig()
        const result = await configClient.saveConfig(withConfigDisplayLanguage(latestConfig, next))

        if (!result.ok) {
          throw new Error('Failed to save language')
        }

        await window.hermesDesktop?.setLocale?.(next)
      } catch (error) {
        const nextError = toError(error)

        setLocaleState(previousLocale)
        setSaveError(nextError)

        throw nextError
      } finally {
        setIsSavingLocale(false)
      }
    },
    [configClient, locale]
  )

  // Account preference sync has already resolved authority in the main
  // process. It needs the same React-owned locale transition as the picker,
  // but must not re-save a cloud value into this machine's profile config.
  const applyLocale = useCallback((next: Locale) => {
    setSaveError(null)
    setLocaleState(normalizeLocale(next))
  }, [])

  const value = useMemo<I18nContextValue>(
    () => ({
      configLoadError,
      hasConfiguredLocale,
      isLoadingConfig,
      isSavingLocale,
      locale,
      applyLocale,
      saveError,
      setLocale,
      t: TRANSLATIONS[locale]
    }),
    [applyLocale, configLoadError, hasConfiguredLocale, isLoadingConfig, isSavingLocale, locale, saveError, setLocale]
  )

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext)
}
