// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'

import { I18nProvider } from '@/i18n'

import { MATRIX_FIRST_LEARNING_SOURCES } from '../../shared/matrix-first-learning'

import { MatrixFirstLearningTiles } from './first-learning-tiles'

afterEach(cleanup)

it('renders all eight approved tiles from Next through terminal states with one narration line', () => {
  const view = render(
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixFirstLearningTiles
        progress={{ mail: 'reading', calendar: 'done', messages: 'skipped', team_spaces: 'unavailable' }}
      />
    </I18nProvider>
  )

  const card = view.container.querySelector('[data-matrix-first-learning-tiles]')!
  expect(card.classList.contains('atum-glass-card')).toBe(false)
  expect((card as HTMLElement).style.background).toBe('var(--ak-ground)')
  expect(card.querySelectorAll('[data-learning-source]')).toHaveLength(8)
  expect(
    [...card.querySelectorAll<HTMLElement>('[data-learning-source]')].every(
      source => source.style.background === 'var(--ak-surface)'
    )
  ).toBe(true)
  expect(card.querySelector('[data-learning-source="mail"]')?.getAttribute('data-learning-state')).toBe('reading')
  expect(card.querySelector('[data-learning-source="calendar"]')?.getAttribute('data-learning-state')).toBe('done')
  expect(card.querySelector('[data-learning-source="files"]')?.getAttribute('data-learning-state')).toBe('next')
  expect(card.querySelector('[data-learning-source="messages"]')?.getAttribute('data-learning-state')).toBe('skipped')
  expect(card.querySelector('[data-learning-source="team_spaces"]')?.getAttribute('data-learning-state')).toBe(
    'unavailable'
  )
  expect(screen.getAllByText('I’m starting with the things you use most…')).toHaveLength(1)
})

it.each(['en', 'vi', 'ja', 'zh', 'zh-hant'] as const)(
  'has localized labels and states for every tile in %s',
  locale => {
    const view = render(
      <I18nProvider configClient={null} initialLocale={locale}>
        <MatrixFirstLearningTiles progress={{ mail: 'reading' }} />
      </I18nProvider>
    )

    for (const source of MATRIX_FIRST_LEARNING_SOURCES) {
      expect(view.container.querySelector(`[data-learning-source="${source}"]`)).toBeTruthy()
    }
  }
)
