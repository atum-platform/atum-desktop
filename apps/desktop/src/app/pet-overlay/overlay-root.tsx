import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { ErrorBoundary } from '@/components/error-boundary'
import { I18nProvider } from '@/i18n'
import { hermesI18nConfigClient } from '@/i18n/hermes-config-client'
import { ThemeProvider } from '@/themes/context'

import { PetOverlayApp } from './pet-overlay-app'

/**
 * Boot the pet-overlay window. Loaded by the same bundle as the main app but
 * via `?win=overlay`, so it shares CSS/atoms while mounting a minimal, transparent
 * surface: no app shell and no gateway of its own.
 *
 * It DOES mount `I18nProvider`, at the same locale as the main window. Without
 * it `useI18n` silently falls back to English, so a Vietnamese user got an
 * English composer placeholder sitting on their desktop — a silent fallback is
 * worse than a missing translation, because nothing surfaces the gap.
 *
 * The index.html boot script paints an OPAQUE themed background to avoid a flash
 * in normal windows; the overlay must be see-through, so we force every host
 * layer transparent with a late, high-specificity style tag.
 */
export function mountPetOverlay(): void {
  const style = document.createElement('style')
  style.textContent = 'html,body,#root{background:transparent !important;}'
  document.head.appendChild(style)

  const root = document.getElementById('root')

  if (!root) {
    return
  }

  createRoot(root).render(
    <StrictMode>
      <ErrorBoundary label="pet-overlay">
        <I18nProvider configClient={hermesI18nConfigClient} initialLocale="vi">
          <ThemeProvider>
            <PetOverlayApp />
          </ThemeProvider>
        </I18nProvider>
      </ErrorBoundary>
    </StrictMode>
  )
}
