import { useStore } from '@nanostores/react'
import { useEffect } from 'react'

import { Tip } from '@/components/ui/tooltip'
import { type Locale, useI18n } from '@/i18n'
import { ArrowLeft, ArrowRight } from '@/lib/icons'

import { $matrixNavCan, stepMatrixNav } from './navigation-history'

/** Five locales, changed together. */
const copies: Record<Locale, { back: string; forward: string }> = {
  en: { back: 'Back', forward: 'Forward' },
  vi: { back: 'Quay lại', forward: 'Tiến tới' },
  ja: { back: '戻る', forward: '進む' },
  zh: { back: '后退', forward: '前进' },
  'zh-hant': { back: '上一頁', forward: '下一頁' }
}

export function navArrowsCopy(locale: Locale) {
  return copies[locale]
}

function editable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  )
}

/**
 * ← → for the whole window (layout r2 §1, option B, owner 2026-11-24): T3's pair of quiet icon
 * buttons, drawn with Atum's Phosphor arrows, ending on the left panel's right edge (or right after
 * the panel toggle while the panel is hidden). ⌘[ and ⌘] step too, outside a text field.
 */
export function MatrixNavArrows() {
  const { locale } = useI18n()
  const copy = copies[locale]
  const can = useStore($matrixNavCan)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.metaKey || event.altKey || event.ctrlKey || event.shiftKey || editable(event.target)) {
        return
      }

      if (event.key === '[' || event.key === ']') {
        event.preventDefault()
        stepMatrixNav(event.key === '[' ? -1 : 1)
      }
    }

    window.addEventListener('keydown', onKey)

    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const arrow = (direction: 'back' | 'forward') => {
    const Icon = direction === 'back' ? ArrowLeft : ArrowRight
    const enabled = direction === 'back' ? can.back : can.forward
    const label = copy[direction]

    return (
      <Tip label={`${label} ${direction === 'back' ? '⌘[' : '⌘]'}`}>
        <button
          aria-disabled={enabled ? undefined : true}
          aria-label={label}
          className="atum-icon-btn relative grid size-7 shrink-0 place-items-center after:absolute after:-inset-0.5 aria-disabled:opacity-38 aria-disabled:hover:bg-transparent [-webkit-app-region:no-drag]"
          data-icon-only
          data-matrix-nav={direction}
          onClick={() => {
            if (enabled) {
              stepMatrixNav(direction === 'back' ? -1 : 1)
            }
          }}
          type="button"
        >
          <Icon aria-hidden className="size-4" />
        </button>
      </Tip>
    )
  }

  return (
    <div className="flex shrink-0 items-center gap-0.5" data-matrix-nav-arrows role="group">
      {arrow('back')}
      {arrow('forward')}
    </div>
  )
}
