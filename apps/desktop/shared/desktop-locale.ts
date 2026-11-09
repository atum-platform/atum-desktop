/** Canonical desktop locale IDs shared by the presentation and native boundary. */
export const DESKTOP_LOCALES = ['en', 'vi', 'zh', 'zh-hant', 'ja'] as const
export type DesktopLocale = (typeof DESKTOP_LOCALES)[number]
export const DEFAULT_DESKTOP_LOCALE: DesktopLocale = 'vi'

export function isDesktopLocale(value: unknown): value is DesktopLocale {
  return typeof value === 'string' && DESKTOP_LOCALES.some(locale => locale === value)
}

/**
 * The first of the system's preferred languages (`navigator.languages`) that Atum speaks,
 * by language and, for Chinese, script or region; nothing when none is supported (the
 * caller then keeps Vietnamese, the fresh-profile default). Used only where nobody has
 * chosen yet: the first sign-in screen, and an account that never picked a language.
 */
export function desktopLocaleFor(languages: readonly string[] | undefined): DesktopLocale | undefined {
  for (const tag of languages ?? []) {
    if (typeof tag !== 'string') {
      continue
    }

    const parts = tag.toLowerCase().replace(/_/g, '-').split('-')
    const language = parts[0]

    if (language === 'zh') {
      return parts.some(part => part === 'hant' || part === 'tw' || part === 'hk' || part === 'mo') ? 'zh-hant' : 'zh'
    }

    if (language === 'en' || language === 'vi' || language === 'ja') {
      return language
    }
  }

  return undefined
}
