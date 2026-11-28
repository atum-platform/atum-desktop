import '../../styles.css'

import { createRoot } from 'react-dom/client'

import { I18nProvider } from '@/i18n'

import { MatrixAppearance } from '../appearance'

import { PlaygroundRelay } from './relay-gallery'

/**
 * The relay gallery (`?relay=<state>`) on a page of its own, dev only. The full playground loads the
 * whole window, whose updater imports reach Node's `net` and stop a plain browser; the picker needs
 * none of that, so its screenshots come from here (picker-relay-fixture.html).
 */
;(window as unknown as { atumMatrix: unknown }).atumMatrix = { command: async () => null }

createRoot(document.getElementById('root')!).render(
  <I18nProvider configClient={null} initialLocale="en">
    <MatrixAppearance />
    <main className="atum-shell atum-window-ground flex h-dvh min-h-0 flex-col overflow-hidden text-(--atum-ink)">
      <PlaygroundRelay />
    </main>
  </I18nProvider>
)
