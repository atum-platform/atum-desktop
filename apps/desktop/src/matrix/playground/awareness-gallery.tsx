import { useState } from 'react'

import { PAGE_INSET_X } from '@/app/layout-constants'
import { NoticeBand } from '@/components/ui/error-state'
import { useI18n } from '@/i18n'

import { awarenessFixture } from '../awareness/fixtures'
import { AwarenessPanel } from '../awareness/panel'
import type { AwarenessCitationRequest, AwarenessData } from '../awareness/types'

export function AwarenessGallery({ view }: { view: string }) {
  const { t } = useI18n()
  const [fixture] = useState(() => awarenessFixture(Date.now()))
  const [opened, setOpened] = useState<AwarenessCitationRequest | null>(null)

  const snapshot = {
    ...fixture,
    status: view === 'awareness-unavailable' ? ('unavailable' as const) : fixture.status,
    freshness: view === 'awareness-stale' ? ('stale' as const) : fixture.freshness,
    sources: view === 'awareness-empty' ? [] : fixture.sources,
    evidence: view === 'awareness-empty' ? [] : fixture.evidence
  }

  const data: AwarenessData = view === 'awareness-loading' ? { state: 'loading' } : { state: 'ready', snapshot }

  return (
    <div className={`mx-auto grid w-full max-w-5xl gap-6 overflow-y-auto pt-20 pb-8 ${PAGE_INSET_X}`}>
      <NoticeBand tone="notice">{t.atum.awareness.previewDescription}</NoticeBand>
      <AwarenessPanel
        currentScopeKey={fixture.scopeKey}
        data={data}
        onOpenCitation={async request => {
          setOpened(request)
        }}
      />
      {opened && (
        <NoticeBand role="status" tone="notice">
          <span data-awareness-citation-kind={opened.citation.kind}>
            {t.atum.awareness.previewCitation(t.atum.awareness.citationKinds[opened.citation.kind])}
          </span>
        </NoticeBand>
      )}
    </div>
  )
}
