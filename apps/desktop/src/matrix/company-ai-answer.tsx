import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'

import { matrixCompanyBoardCopy } from '../../shared/matrix-company-board-copy'

import { companyAIAnswerProjection } from './company-ai-answer-projection'
import {
  type CompanyCitationContext,
  companyCitationSource
} from './company-citation'
import {
  type CompanyAIAnswerProjection,
  companyDesktopAdapter
} from './company-desktop-adapter'

export { companyAIAnswerProjection }

export interface CompanyAIAnswerProps {
  answer: CompanyAIAnswerProjection
  /** The room's display name, when the answer is read where it was asked. */
  channelName?: string
  /** Display-only resolution for sources from channels outside the open room. */
  citationContext?: CompanyCitationContext
}

export function CompanyAIAnswer({ answer, channelName, citationContext }: CompanyAIAnswerProps) {
  const { locale } = useI18n()
  const copy = matrixCompanyBoardCopy(locale)
  const current = answer.coverage.state === 'live' || answer.coverage.state === 'partial'

  const checked =
    current && answer.coverage.asOf
      ? `${copy.answerFresh} ${new Intl.DateTimeFormat(locale, {
          dateStyle: 'medium',
          timeStyle: 'short'
        }).format(new Date(answer.coverage.asOf))}`
      : copy.answerChecking

  const context: CompanyCitationContext = {
    channelName: channelId =>
      channelId === answer.channelId ? channelName : citationContext?.channelName?.(channelId),
    senderName: citationContext?.senderName
  }

  return (
    <div
      className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-(--atum-ink-muted)"
      data-company-ai-answer
      data-company-ai-freshness={answer.coverage.state}
    >
      <span className="font-medium">{copy.sources}</span>
      {answer.citations.length === 0 ? (
        <span>{copy.noSources}</span>
      ) : (
        answer.citations.map(citation => (
          <Tip key={`${citation.sourceId}:${citation.kind === 'channel' ? citation.eventId : citation.file.name}`} label={checked}>
            <Button
              className="underline decoration-current"
              onClick={() => void companyDesktopAdapter()?.openCitation(answer.companyId, citation).catch(() => {})}
              size="inline"
              variant="link"
            >
              {companyCitationSource(citation, locale, context, copy.citedMessage).label}
            </Button>
          </Tip>
        ))
      )}
    </div>
  )
}
