import { atom } from 'nanostores'

/**
 * Whether each screen's right panel is open (layout r2 §2, owner 2026-11-24): open by default on Chat
 * and Team Space, where the neutral panel is useful; closed on Store and Drive, where the main area
 * wants the width. Each screen remembers the person's own choice on this Mac.
 */
export type MatrixRightPanelScreen = 'chat' | 'workplace' | 'discover' | 'drive'

export const MATRIX_RIGHT_PANEL_DEFAULTS: Record<MatrixRightPanelScreen, boolean> = {
  chat: true,
  workplace: true,
  discover: false,
  drive: false
}

const KEY = 'io.atum.rightPanel'

function read(): Record<MatrixRightPanelScreen, boolean> {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? '{}')
    const saved = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

    return Object.fromEntries(
      Object.entries(MATRIX_RIGHT_PANEL_DEFAULTS).map(([screen, open]) => [
        screen,
        typeof saved[screen] === 'boolean' ? saved[screen] : open
      ])
    ) as Record<MatrixRightPanelScreen, boolean>
  } catch {
    return { ...MATRIX_RIGHT_PANEL_DEFAULTS }
  }
}

export const $matrixRightPanel = atom<Record<MatrixRightPanelScreen, boolean>>(read())

export function setMatrixRightPanel(screen: MatrixRightPanelScreen, open: boolean): void {
  const next = { ...$matrixRightPanel.get(), [screen]: open }
  $matrixRightPanel.set(next)

  try {
    window.localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // Storage off: remembered for this window only.
  }
}

/** A window narrower than this keeps the main area whole: a default-open panel waits to be asked for. */
export const MATRIX_RIGHT_PANEL_MIN_WINDOW = 1180

/** The C toggle's words. Five locales, changed together. */
const toggleCopies = {
  en: { show: 'Show right panel', hide: 'Hide right panel' },
  vi: { show: 'Hiện bảng bên phải', hide: 'Ẩn bảng bên phải' },
  ja: { show: '右パネルを表示', hide: '右パネルを隠す' },
  zh: { show: '显示右侧面板', hide: '隐藏右侧面板' },
  'zh-hant': { show: '顯示右側面板', hide: '隱藏右側面板' }
} as const

export function rightPanelToggleCopy(locale: keyof typeof toggleCopies) {
  return toggleCopies[locale]
}
