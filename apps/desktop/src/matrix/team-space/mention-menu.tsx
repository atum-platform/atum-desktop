import { AtumAssistantAvatar } from '@/app/atum/assistant-avatar'
import { ConsentBoundary } from '@/components/ui/consent-boundary'
import { Hash } from '@/lib/icons'

import type { MatrixTeamSpaceCopy } from '../../../shared/matrix-team-space-copy'
import type { CompanyAIView } from '../company-desktop-adapter'
import type { MatrixHumanMention } from '../matrix-mentions'
import { MatrixPersonAvatar } from '../member-avatar'
import { PersonHandleLine } from '../person-handle-line'

export type TeamSpaceMentionOption =
  | { kind: 'person'; mention: MatrixHumanMention }
  | { kind: 'channel' }
  | { kind: 'company_ai'; view: CompanyAIView }

/** The Chief of Staff while it can't answer: a quiet line in the menu, never a pickable target. */
export interface TeamSpaceCompanyAINotice {
  view: CompanyAIView
  line: string
}

export function TeamSpaceMentionMenu({
  companyAINotice,
  copy,
  onPick,
  options,
  selected
}: {
  companyAINotice?: TeamSpaceCompanyAINotice
  copy: MatrixTeamSpaceCopy
  onPick(option: TeamSpaceMentionOption): void
  options: readonly TeamSpaceMentionOption[]
  selected: number
}) {
  if (!options.length && !companyAINotice) {
    return null
  }

  return (
    <ConsentBoundary><div className="px-1 pt-1">
      {options.length > 0 && (
        <TeamSpaceMentionOptions copy={copy} onPick={onPick} options={options} selected={selected} />
      )}
      {companyAINotice && (
        <p className="flex items-center gap-2 px-2 py-1.5" data-company-ai-mention-state={companyAINotice.view.state} role="status">
          <AtumAssistantAvatar
            className="size-6 shrink-0 text-[0.5625rem] leading-none opacity-60"
            id={companyAINotice.view.agent.principal}
            name={companyAINotice.view.agent.displayName}
          />
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium text-(--atum-ink-muted)">
              {companyAINotice.view.agent.displayName}
            </span>
            <span className="block truncate text-xs text-(--atum-ink-muted)">{companyAINotice.line}</span>
          </span>
        </p>
      )}
    </div></ConsentBoundary>
  )
}

function TeamSpaceMentionOptions({
  copy,
  onPick,
  options,
  selected
}: {
  copy: MatrixTeamSpaceCopy
  onPick(option: TeamSpaceMentionOption): void
  options: readonly TeamSpaceMentionOption[]
  selected: number
}) {
  return (
    <ConsentBoundary><div aria-label={copy.mentionPeople} data-team-space-mentions role="listbox">
      {options.map((option, index) => {
        const key =
          option.kind === 'person'
            ? option.mention.userId
            : option.kind === 'company_ai'
              ? option.view.agent.userId
              : 'channel'

        const name =
          option.kind === 'person'
            ? option.mention.name
            : option.kind === 'company_ai'
              ? option.view.agent.displayName
              : '@channel'

        // A person's line is their @handle when the directory vouched for one, else nothing: the
        // name alone (never the name again as a token).
        const hint =
          option.kind === 'person'
            ? undefined
            : option.kind === 'company_ai'
              ? copy.mentionCompanyAI
              : copy.mentionChannelHint

        return (
          <button
            aria-selected={index === selected}
            className="flex w-full items-center gap-2 rounded-(--atum-r-row) px-2 py-1.5 text-start hover:bg-(--atum-row-hover) focus-visible:bg-(--atum-row-hover) aria-selected:bg-(--atum-row-hover)"
            data-mention-kind={option.kind}
            key={key}
            onClick={() => onPick(option)}
            onMouseDown={event => event.preventDefault()}
            role="option"
            type="button"
          >
            {option.kind === 'person' ? (
              <MatrixPersonAvatar
                avatarMxc={option.mention.avatarMxc}
                className="size-6 shrink-0 text-[0.5625rem] leading-none"
                id={option.mention.userId}
                name={option.mention.name}
              />
            ) : option.kind === 'company_ai' ? (
              <AtumAssistantAvatar
                className="size-6 text-[0.5625rem] leading-none"
                id={option.view.agent.principal}
                name={option.view.agent.displayName}
              />
            ) : (
              <span className="grid size-6 shrink-0 place-items-center rounded-full bg-(--atum-row-hover) text-(--atum-ink)">
                <Hash aria-hidden className="size-4" />
              </span>
            )}
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-(--atum-ink)">{name}</span>
              {option.kind === 'person' ? (
                <PersonHandleLine handle={option.mention.handle} name={name} />
              ) : (
                <span className="block truncate text-xs text-(--atum-ink-muted)">{hint}</span>
              )}
            </span>
          </button>
        )
      })}
    </div></ConsentBoundary>
  )
}
