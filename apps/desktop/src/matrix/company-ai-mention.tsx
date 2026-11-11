import { AtumAssistantAvatar } from '@/app/atum/assistant-avatar'
import { ConsentBoundary } from '@/components/ui/consent-boundary'
import { useI18n } from '@/i18n'

import { matrixCompanyBoardCopy } from '../../shared/matrix-company-board-copy'

import type { CompanyAIView } from './company-desktop-adapter'

const DISPLAY_NAME = 'Chief of Staff'

export interface CompanyAIMentionMatch {
  start: number
  end: number
}

export function companyAIMentionMatch(text: string, cursor = text.length): CompanyAIMentionMatch | null {
  const before = text.slice(0, cursor)
  const match = /(^|\s)@([^@\n]*)$/u.exec(before)

  if (!match) {
    return null
  }

  const query = match[2]!.trim().toLocaleLowerCase()

  if (query && !DISPLAY_NAME.toLocaleLowerCase().startsWith(query)) {
    return null
  }

  return { start: cursor - match[2]!.length - 1, end: cursor }
}

export function insertCompanyAIMention(text: string, match: CompanyAIMentionMatch): string {
  return `${text.slice(0, match.start)}@${DISPLAY_NAME} ${text.slice(match.end)}`
}

/** The Chief of Staff is mentioned only while it can answer: a not-ready mention would wait forever. */
export function companyAIMentionUserIds(text: string, view: CompanyAIView | undefined): string[] {
  return view?.enabled && view.state === 'ready' && text.includes(`@${DISPLAY_NAME}`) ? [view.agent.userId] : []
}

export function CompanyAIMentionMenu({ onPick, view }: { onPick(): void; view: CompanyAIView }) {
  const { locale } = useI18n()
  const copy = matrixCompanyBoardCopy(locale)

  return (
    <ConsentBoundary><div aria-label={copy.mentionChief} className="px-1 pt-1" data-company-ai-mention role="listbox">
      <button
        aria-selected="true"
        className="flex w-full items-center gap-2 rounded-(--atum-r-row) px-2 py-1.5 text-start hover:bg-(--atum-row-hover) focus-visible:bg-(--atum-row-hover)"
        onClick={onPick}
        onMouseDown={event => event.preventDefault()}
        role="option"
        type="button"
      >
        <AtumAssistantAvatar
          className="size-6 text-[0.5625rem] leading-none"
          id={view.agent.principal}
          name={view.agent.displayName}
        />
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium text-(--atum-ink)">{copy.chiefOfStaff}</span>
          <span className="block text-xs text-(--atum-ink-muted)">{copy.mentionHint}</span>
        </span>
      </button>
    </div></ConsentBoundary>
  )
}
