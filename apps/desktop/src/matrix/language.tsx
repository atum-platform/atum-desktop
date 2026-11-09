import { type ReactNode, useEffect, useMemo } from 'react'

import { LanguageSwitcher } from '@/components/language-switcher'
import { NoticeBand } from '@/components/ui/error-state'
import { I18nProvider, useI18n } from '@/i18n'
import { getConfigDisplayLanguage, type I18nConfigClient } from '@/i18n/context'
import { DEFAULT_LOCALE, isSupportedLocaleValue, normalizeLocale } from '@/i18n/languages'

import { desktopLocaleFor } from '../../shared/desktop-locale'
import type { MatrixSnapshot } from '../../shared/matrix'

import { useMatrixDisplaySetting } from './display-settings'

/**
 * Signed-out presentation only. Never seed an account from this unowned global key. Until
 * someone picks a language here, the first screen speaks the system's language where Atum
 * speaks it (Vietnamese otherwise).
 */
export function matrixLanguageConfig(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  languages: readonly string[] | undefined = globalThis.navigator?.languages
): I18nConfigClient {
  const key = 'io.atum.desktop.language'

  return {
    async getConfig() {
      return { display: { language: storage.getItem(key) ?? desktopLocaleFor(languages) ?? null } }
    },
    async saveConfig(config) {
      const language = getConfigDisplayLanguage(config)

      if (!isSupportedLocaleValue(language)) {
        throw new Error('matrix_language_invalid')
      }

      storage.setItem(key, normalizeLocale(language))

      return { ok: true }
    }
  }
}

const quietControl =
  '-me-2 h-7 min-w-0 border-transparent bg-transparent px-2 text-(--atum-ink-faint) shadow-none hover:bg-(--atum-hover) hover:text-(--atum-ink)'

/** A setting's value at the end of its row (Settings › General): normal ink, not a hint. */
const rowControl =
  '-me-2 h-7 min-w-0 border-transparent bg-transparent px-2 text-(--atum-ink) shadow-none hover:bg-(--atum-hover)'

/** One i18n scope per human/device: old optimistic config writes cannot roll back a new account. */
export function MatrixLanguageProvider({ snapshot, children }: { snapshot: MatrixSnapshot; children: ReactNode }) {
  const signedOutConfig = useMemo(() => matrixLanguageConfig(localStorage), [])

  return (
    <I18nProvider configClient={snapshot.identity ? null : signedOutConfig} key={JSON.stringify(snapshot.identity)}>
      {snapshot.identity && <MatrixLanguageProjection snapshot={snapshot} />}
      {children}
    </I18nProvider>
  )
}

function MatrixLanguageProjection({ snapshot }: { snapshot: MatrixSnapshot }) {
  const { applyLocale } = useI18n()
  const language = snapshot.displayPreferences?.language?.value ?? DEFAULT_LOCALE

  useEffect(() => applyLocale(language), [applyLocale, language])

  return null
}

function AccountLanguageSettings({ snapshot, quiet }: { snapshot: MatrixSnapshot; quiet: boolean }) {
  const { change, disabled, readonly, notice, copy } = useMatrixDisplaySetting(snapshot, 'language')

  return (
    <div className={quiet ? undefined : 'py-2'} data-matrix-language-settings>
      <LanguageSwitcher
        className={quiet ? `ak-select ${rowControl}` : undefined}
        disabled={disabled}
        onChange={change}
        showIcon={!quiet}
      />
      {(notice || readonly) && (
        <NoticeBand role="status" tone="notice">
          {notice ? copy[notice] : copy.readonly}
        </NoticeBand>
      )}
    </div>
  )
}

export function MatrixLanguageSettings({ quiet = false, snapshot }: { quiet?: boolean; snapshot?: MatrixSnapshot }) {
  return snapshot?.identity ? (
    <AccountLanguageSettings key={JSON.stringify(snapshot.identity)} quiet={quiet} snapshot={snapshot} />
  ) : (
    <SignedOutLanguageSettings quiet={quiet} />
  )
}

function SignedOutLanguageSettings({ quiet }: { quiet: boolean }) {
  const { configLoadError, isLoadingConfig, saveError, t } = useI18n()

  return (
    <div className={quiet ? undefined : 'py-2'} data-matrix-language-settings>
      {!isLoadingConfig && (
        <LanguageSwitcher
          className={
            // Quiet: a text-weight control at the end of a row (sign-in, Settings), not a field.
            quiet ? `ak-select ${quietControl}` : undefined
          }
          showIcon={!quiet}
        />
      )}
      {(configLoadError || saveError) && (
        <NoticeBand role="status" tone="notice">
          {saveError ? t.language.saveError : t.matrixShell.languageLoadFailed}
        </NoticeBand>
      )}
    </div>
  )
}
