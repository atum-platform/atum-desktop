import { useI18n } from '@/i18n'

import {
  MATRIX_FIRST_LEARNING_SOURCES,
  type MatrixFirstLearningProgress,
  matrixFirstLearningTilesCopy
} from '../../shared/matrix-first-learning'

export function MatrixFirstLearningTiles({ progress }: { progress: MatrixFirstLearningProgress }) {
  const { locale } = useI18n()
  const copy = matrixFirstLearningTilesCopy(locale)

  return (
    <section
      className="flex w-auto flex-col"
      data-matrix-first-learning-tiles
      style={{
        background: 'var(--ak-ground)',
        borderRadius: 'var(--ak-r-xl)',
        gap: 'var(--ak-s3)',
        margin: 'var(--ak-s3) var(--ak-s4)',
        padding: 'var(--ak-s4)'
      }}
    >
      <p className="ak-text-2" style={{ font: 'var(--ak-t-body)' }}>
        {copy.narration}
      </p>
      <div className="grid grid-cols-2 sm:grid-cols-4" role="list" style={{ gap: 'var(--ak-s2)' }}>
        {MATRIX_FIRST_LEARNING_SOURCES.map(source => {
          const state = progress[source] ?? 'next'

          return (
            <div
              className="flex flex-col"
              data-learning-source={source}
              data-learning-state={state}
              key={source}
              role="listitem"
              style={{
                background: 'var(--ak-surface)',
                borderRadius: 'var(--ak-r-lg)',
                boxShadow: 'var(--ak-shadow-1)',
                gap: 'var(--ak-s2)',
                padding: 'var(--ak-s3)'
              }}
            >
              <span className="block truncate" style={{ color: 'var(--ak-ink)', font: 'var(--ak-t-body-strong)' }}>
                {copy.sources[source]}
              </span>
              <span className="ak-text-3 block" role="status" style={{ font: 'var(--ak-t-callout)' }}>
                {copy.states[state]}
              </span>
            </div>
          )
        })}
      </div>
    </section>
  )
}
