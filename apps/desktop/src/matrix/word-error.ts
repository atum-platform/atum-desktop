import type { Translations } from '@/i18n/types'

export function matrixWordError(error: unknown, copy: Translations['atum']['workspace'], fallback: string): string {
  const code = String(error).match(/\bWORD_[A-Z_]+\b/)?.[0]

  const messages: Record<string, string> = {
    WORD_NOT_INSTALLED: copy.wordMissing,
    WORD_AUTOMATION_DENIED: copy.wordPermission,
    WORD_EXIT_FULLSCREEN: copy.wordFullscreen,
    WORD_SCREEN_TOO_SMALL: copy.wordSmallScreen,
    WORD_DOCUMENT_UNAVAILABLE: copy.wordDocumentUnavailable,
    WORD_LAYOUT_FAILED: copy.wordOpenError
  }

  return code ? messages[code] ?? fallback : fallback
}
