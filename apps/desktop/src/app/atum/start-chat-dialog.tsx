import { type FC, useEffect, useMemo, useRef, useState } from 'react'

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { SearchField } from '@/components/ui/search-field'
import { useI18n } from '@/i18n'
import { Plus, UserCircle, Users } from '@/lib/icons'
import { cn } from '@/lib/utils'

import { ATUM_AGENT_ID } from './agents'
import { AtumAssistantAvatar } from './assistant-avatar'
import { type AtumRosterEntry, type AtumRosterKind, filterRoster } from './roster'

/** A row the picker can act on, in the order the sections are shown. */
type PickerSection = 'assistant' | 'person' | 'app'

const SECTION_OF: Record<AtumRosterKind, PickerSection | null> = {
  app: 'app',
  assistant: 'assistant',
  // One of the master's own chats: a conversation that already EXISTS. This
  // surface starts one, so it lists who you can talk to — offering a thread
  // here would make it a second, worse copy of the roster below it.
  chat: null,
  direct: 'person',
  group: 'person',
  // A room this build cannot render. Unopenable, so never offered as a way in.
  unsupported: null
}

/**
 * "Everything is chat" needs one place that answers "who do you want to talk
 * to?" — an assistant of yours, a person, or an app.
 *
 * The plus button used to open a menu whose first item made a new chat with
 * the master assistant, which the master's own row in the roster already does,
 * one click away and without a menu. So the menu's headline action was a
 * duplicate, and the two things it offered that were NOT duplicates (a group,
 * adding a friend) sat under it as though they were variations on it.
 *
 * This inverts that: the directory leads, creation is the footer.
 */
export const AtumStartChatDialog: FC<{
  entries: readonly AtumRosterEntry[]
  onAddFriends: () => void
  onCreateAgent: () => void
  onCreateGroup: (() => void) | null
  onOpenChange: (open: boolean) => void
  onPick: (entry: AtumRosterEntry) => void
  open: boolean
}> = ({ entries, onAddFriends, onCreateAgent, onCreateGroup, onOpenChange, onPick, open }) => {
  const { t } = useI18n()
  const copy = t.atum.roster
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

  // Each opening starts from the whole directory; a query left over from last
  // time would hide most of it with no sign of why.
  useEffect(() => {
    if (open) {
      setQuery('')
    }
  }, [open])

  const sections = useMemo(() => {
    const matched = filterRoster(entries, query)
    const of = (section: PickerSection) => matched.filter(entry => SECTION_OF[entry.kind] === section)

    return { app: of('app'), assistant: of('assistant'), person: of('person') }
  }, [entries, query])

  const total = sections.assistant.length + sections.person.length + sections.app.length

  const pick = (entry: AtumRosterEntry) => {
    onOpenChange(false)
    onPick(entry)
  }

  const act = (run: () => void) => {
    onOpenChange(false)
    run()
  }

  const renderRow = (entry: AtumRosterEntry) => (
    <button
      className="atum-row flex h-11 w-full items-center gap-2.5 px-2 text-left"
      data-atum-start-chat-row
      key={entry.id}
      onClick={() => pick(entry)}
      type="button"
    >
      {entry.kind === 'assistant' ? (
        <AtumAssistantAvatar
          avatarUrl={entry.avatarUrl}
          brand={entry.agentId === ATUM_AGENT_ID}
          className="size-(--atum-avatar-md) shrink-0 rounded-(--atum-r-avatar) text-[0.8125rem] leading-none"
          id={entry.agentId}
          name={entry.title}
        />
      ) : entry.avatarUrl ? (
        <img alt="" className="atum-avatar size-(--atum-avatar-md) shrink-0 object-cover" src={entry.avatarUrl} />
      ) : (
        <span
          aria-hidden="true"
          className="ak-avatar atum-avatar grid size-(--atum-avatar-md) shrink-0 place-items-center bg-(--ak-fill-quiet) text-[0.8125rem] leading-none font-semibold text-(--ak-ink-2)"
          data-face={entry.kind === 'app' ? 'app' : undefined}
          style={entry.kind === 'app' && entry.accent ? { background: entry.accent } : undefined}
        >
          {entry.title.slice(0, 1).toUpperCase()}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-(length:--atum-t-control) text-(--atum-ink)">{entry.title}</span>
        {(entry.role || entry.preview) && (
          <span className="block truncate text-(length:--atum-t-caption) leading-(--atum-lh-caption) text-(--atum-ink-muted)">
            {entry.role || entry.preview}
          </span>
        )}
      </span>
    </button>
  )

  const renderSection = (label: string, rows: readonly AtumRosterEntry[]) =>
    rows.length > 0 && (
      <div>
        <div className="px-2 pb-1 pt-3 text-(length:--atum-t-label) leading-(--atum-lh-label) font-semibold uppercase tracking-[0.06em] text-(--atum-ink-faint)">
          {label}
        </div>
        <div className="flex flex-col gap-0.5">{rows.map(renderRow)}</div>
      </div>
    )

  const footerAction = (
    { icon: Icon, label, onSelect, testId }:
    { icon: typeof Plus; label: string; onSelect: () => void; testId: string }
  ) => (
    <button
      className={cn(
        'atum-row flex h-9 flex-1 items-center justify-center gap-1.5 bg-(--atum-sunk) px-2',
        'text-(length:--atum-t-caption) font-medium text-(--atum-ink-muted) hover:text-(--atum-ink)',
        'disabled:opacity-45 disabled:hover:text-(--atum-ink-muted)'
      )}
      data-testid={testId}
      disabled={false}
      onClick={() => act(onSelect)}
      type="button"
    >
      <Icon aria-hidden className="size-4 shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  )

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-md gap-0 p-0" data-atum-start-chat>
        <DialogHeader className="px-4 pb-2 pt-4">
          <DialogTitle>{copy.startChat}</DialogTitle>
          <DialogDescription className="sr-only">{copy.startChatHint}</DialogDescription>
        </DialogHeader>
        <div className="px-3">
          <SearchField
            aria-label={copy.startChatSearch}
            containerClassName="h-[2.125rem] min-w-0 rounded-[var(--atum-r-row)] border-none bg-(--atum-sunk) px-2 text-[0.8125rem] !opacity-100 transition-colors focus-within:bg-(--atum-hover)"
            inputClassName="min-w-0 flex-1 text-(--atum-ink) placeholder:text-(--atum-ink-faint)"
            inputRef={searchRef}
            onChange={setQuery}
            placeholder={copy.startChatSearch}
            value={query}
          />
        </div>
        <div className="max-h-[22rem] min-h-0 overflow-y-auto px-3 pb-2">
          {total === 0 ? (
            <p className="px-2 py-8 text-center text-(length:--atum-t-caption) text-(--atum-ink-muted)">
              {copy.emptySearch}
            </p>
          ) : (
            <>
              {renderSection(copy.assistants, sections.assistant)}
              {renderSection(copy.people, sections.person)}
              {renderSection(copy.apps, sections.app)}
            </>
          )}
        </div>
        {/* Making something new is a different act from picking someone who
            already exists, so it sits below the directory rather than inside
            it — never mistaken for a contact. */}
        <div className="flex items-center gap-1.5 border-t border-(--atum-line) px-3 py-2.5">
          {onCreateGroup &&
            footerAction({ icon: Users, label: t.dm.group.create.title, onSelect: onCreateGroup, testId: 'atum-start-chat-group' })}
          {footerAction({ icon: Plus, label: t.atum.agents.create, onSelect: onCreateAgent, testId: 'atum-start-chat-agent' })}
          {footerAction({ icon: UserCircle, label: copy.addFriends, onSelect: onAddFriends, testId: 'atum-start-chat-friends' })}
        </div>
      </DialogContent>
    </Dialog>
  )
}
