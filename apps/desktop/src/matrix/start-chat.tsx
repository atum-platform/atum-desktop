import { type ReactNode, useEffect, useRef, useState } from 'react'

import { AppCatalogAvatar } from '@/app/atum/app-catalog-presentation'
import { AtumAssistantAvatar } from '@/app/atum/assistant-avatar'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { MessagePlus, Search, Users, X } from '@/lib/icons'

import { appLocalizedCopy } from '../../shared/app-catalog'
import type { MatrixAgentView, MatrixSnapshot } from '../../shared/matrix'

import { agentStatus } from './agent-roster'
import { appRoster } from './app-roster'
import { MainAgentBadge } from './main-agent-badge'
import { groupConversations, knownPeople, matchesName, parsePersonQuery } from './people'
import { useMatrixHandleContacts } from './person-handle-contacts'
import { PersonHandleLine } from './person-handle-line'
import { useMatrixHandles } from './person-handles'
import { PERSON_AVATAR } from './person-search'
import { MatrixProfileAvatar } from './profile-avatar'
import { useRosterCreateCopy } from './roster-create-copy'
import { matrixRosterAgentName, projectMatrixRoster } from './roster-model'

/** New chat, in the roster's title bar: one question, who do you want to talk to? */
export function MatrixStartChatButton({ disabled, onClick }: { disabled?: boolean; onClick(): void }) {
  const copy = useRosterCreateCopy()

  return (
    <Tip label={copy.newMenu}>
      <button
        aria-label={copy.newMenu}
        className="atum-icon-btn grid size-7 shrink-0 place-items-center rounded-full [-webkit-app-region:no-drag] disabled:opacity-45"
        data-atum-create-menu
        data-icon-only
        disabled={disabled}
        onClick={onClick}
        type="button"
      >
        <MessagePlus aria-hidden className="size-4" />
      </button>
    </Tip>
  )
}

export interface MatrixStartChatProps {
  open: boolean
  onOpenChange(open: boolean): void
  snapshot: MatrixSnapshot
  /** The platform can make another assistant here (`snapshot.agentCreation`). */
  canCreateAssistant: boolean
  /** People can be found by @name here (the alias directory is reachable). */
  canFindPeople: boolean
  /** The composer decides which of the assistant's chats opens (its one conversation). */
  onPickAssistant(agent: MatrixAgentView): void
  onPickRoom(roomId: string): void
  onPickApp(appId: string): void
  /** Add a friend, optionally searching for what was typed here. */
  onFindPerson(query?: string): void
  onNewGroup(): void
  onNewAssistant(): void
}

interface StartRow {
  key: string
  avatar: ReactNode
  name: string
  main?: boolean
  caption?: string
  /** A person's @handle, under the name (it finds them too). */
  handle?: string
  run(): void
}

/**
 * The directory leads and creation is the footer (the old app's `AtumStartChatDialog`, on
 * Matrix state): your assistants, the people and groups you already talk to, and your
 * apps, one search across them; then a new group, a new assistant, or a friend. A query
 * that could be someone's @name offers to find them on Atum, so a search never dead-ends.
 */
export function MatrixStartChat({
  canCreateAssistant,
  canFindPeople,
  onFindPerson,
  onNewAssistant,
  onNewGroup,
  onOpenChange,
  onPickApp,
  onPickAssistant,
  onPickRoom,
  open,
  snapshot
}: MatrixStartChatProps) {
  const copy = useRosterCreateCopy()
  const { locale, t } = useI18n()
  const [query, setQuery] = useState('')
  const sheetRef = useRef<HTMLDivElement>(null)
  const ready = snapshot.state === 'ready'
  const scopeKey = `${snapshot.petScope ?? ''}/${snapshot.identity?.userId}/${snapshot.identity?.deviceId}`
  const handles = useMatrixHandles(snapshot.identity?.userId)

  // Each opening starts from the whole directory; a leftover query would hide most of it.
  useEffect(() => {
    if (open) {
      setQuery('')
    }
  }, [open])

  const act = (run: () => void) => {
    onOpenChange(false)
    run()
  }

  const assistants: StartRow[] = projectMatrixRoster(snapshot).groups.flatMap(({ agent }) => {
    const name = matrixRosterAgentName(agent, t.matrixShell.assistantName)
    const status = agentStatus(agent)

    return matchesName(name, query)
      ? [
          {
            key: agent.principal,
            avatar: (
              <MatrixProfileAvatar
                avatarUrl={agent.avatarUrl}
                brand={agent.isDefault}
                className={PERSON_AVATAR}
                id={agent.principal}
                mark={agent.mark}
                name={name}
                profile={agent.profile}
                scopeKey={scopeKey}
                target={{ kind: 'agent', principal: agent.principal }}
              />
            ),
            name,
            main: agent.isDefault,
            caption: status ? t.matrixShell[status] : undefined,
            run: () => onPickAssistant(agent)
          }
        ]
      : []
  })

  const known = knownPeople(snapshot)
  useMatrixHandleContacts(snapshot.identity?.userId, open ? known.map(person => person.userId) : [], Boolean(snapshot.domainEnabled))

  const people: StartRow[] = known
    .filter(person => matchesName(person.name, query, handles[person.userId]))
    .map(person => ({
      key: person.userId,
      avatar: <AtumAssistantAvatar className={PERSON_AVATAR} id={person.userId} name={person.name} />,
      name: person.name,
      handle: handles[person.userId],
      run: () => onPickRoom(person.roomId!)
    }))

  const groups: StartRow[] = groupConversations(snapshot)
    .filter(room => matchesName(room.name, query))
    .map(room => ({
      key: room.id,
      avatar: <AtumAssistantAvatar className={PERSON_AVATAR} id={room.id} name={room.name} />,
      name: room.name.trim(),
      caption: copy.members(
        Math.max(1, (room.participants ?? []).filter(member => member.membership === 'join').length)
      ),
      run: () => onPickRoom(room.id)
    }))

  const apps: StartRow[] = (snapshot.apps ? appRoster(snapshot.apps.apps, snapshot.appShortcuts) : []).flatMap(app => {
    const name = appLocalizedCopy(app.name, locale, app.app)

    return matchesName(name, query)
      ? [
          {
            key: app.app_id,
            avatar: <AppCatalogAvatar app={app} className={PERSON_AVATAR} locale={locale} tile />,
            name,
            run: () => onPickApp(app.app_id)
          }
        ]
      : []
  })

  const rows = [...assistants, ...people, ...groups, ...apps]
  const parsed = parsePersonQuery(query)
  const findable = parsed.kind === 'handle' ? parsed.handle : parsed.kind === 'matrixId' ? parsed.userId.slice(1) : null
  const offerFind = canFindPeople && findable !== null

  const section = (label: string, entries: StartRow[], extra?: ReactNode) =>
    (entries.length > 0 || extra) && (
      <div aria-label={label} role="group">
        <div className="ak-section">
          {label}
        </div>
        <div className="flex flex-col gap-0.5">
          {entries.map(entry => (
            <button
              className="ak-row w-full text-left disabled:opacity-45"
              data-atum-start-chat-row={entry.key}
              disabled={!ready}
              key={entry.key}
              onClick={() => act(entry.run)}
              type="button"
            >
              {entry.avatar}
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-center gap-1.5 text-(length:--atum-t-control) text-(--atum-ink)">
                  <span className="truncate">{entry.name}</span>
                  {entry.main && <MainAgentBadge />}
                </span>
                <PersonHandleLine handle={entry.handle} name={entry.name} />
                {entry.caption && (
                  <span className="block truncate text-(length:--atum-t-caption) leading-(--atum-lh-caption) text-(--atum-ink-muted)">
                    {entry.caption}
                  </span>
                )}
              </span>
            </button>
          ))}
          {extra}
        </div>
      </div>
    )

  const footerAction = (label: string, onSelect: () => void, testId: string) => (
    <button
      className="ak-btn ak-btn--plain ak-btn--sm"
      data-testid={testId}
      disabled={!ready}
      onClick={() => act(onSelect)}
      type="button"
    >
      {label}
    </button>
  )

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="ak-sheet max-w-none gap-0 overflow-hidden border-0 p-0"
        data-atum-start-chat
        onCloseAutoFocus={event => {
          if (
            document.querySelector('[data-slot="dialog-content"][data-state="open"]') ||
            document.querySelector('[data-atum-create-menu]')?.closest('[inert]')
          ) {
            event.preventDefault()
          }
        }}
        onOpenAutoFocus={event => {
          event.preventDefault()
          sheetRef.current?.focus()
        }}
        ref={sheetRef}
        showCloseButton={false}
        tabIndex={-1}
      >
        <div className="ak-sheet-head">
          <DialogTitle className="ak-sheet-title">{copy.startTitle}</DialogTitle>
          <DialogDescription className="sr-only">{copy.startHint}</DialogDescription>
          <Tip label={t.common.close}>
            <DialogClose asChild>
              <button aria-label={t.common.close} className="ak-iconbtn" type="button">
                <X aria-hidden className="ak-icon" />
              </button>
            </DialogClose>
          </Tip>
        </div>
        <div className="ak-sheet-body min-h-0">
          <form
            onSubmit={event => {
              event.preventDefault()

              if (!ready) {
                return
              }

              if (rows[0]) {
                act(rows[0].run)
              } else if (offerFind) {
                act(() => onFindPerson(query.trim()))
              }
            }}
          >
            <label className="ak-field ak-field--search">
              <Search aria-hidden className="ak-icon ak-icon--sm" />
              <input
                aria-label={copy.startSearch}
                onChange={event => setQuery(event.currentTarget.value)}
                placeholder={copy.startSearch}
                value={query}
              />
            </label>
          </form>
          <div className="min-h-0 overflow-y-auto" data-atum-start-chat-list>
            <span aria-atomic aria-live="polite" className="sr-only">
              {query.trim() ? t.atum.roster.results(rows.length) : ''}
            </span>
            {section(copy.assistants, assistants)}
            {section(
              copy.people,
              [...people, ...groups],
              !query.trim() && (
                <button
                  className="ak-row w-full text-left disabled:opacity-45"
                  data-testid="atum-start-chat-group"
                  disabled={!ready}
                  onClick={() => act(onNewGroup)}
                  type="button"
                >
                  <span className="ak-avatar">
                    <Users aria-hidden className="ak-icon ak-icon--sm" />
                  </span>
                  <span>{copy.newGroup}</span>
                </button>
              )
            )}
            {section(copy.apps, apps)}
            {rows.length === 0 && !offerFind && (
              <div className="ak-state" role="status">
                <p className="ak-state-title">{copy.noMatches}</p>
                {canFindPeople && <p className="ak-state-body">{copy.noMatchesHint}</p>}
              </div>
            )}
            {offerFind && (
              <button
                className="ak-row w-full text-left disabled:opacity-45"
                data-atum-start-chat-find
                disabled={!ready}
                onClick={() => act(() => onFindPerson(query.trim()))}
                type="button"
              >
                <span className="ak-avatar">
                  <Search aria-hidden className="ak-icon ak-icon--sm" />
                </span>
                <span className="min-w-0 flex-1 truncate">{copy.findOnAtum(findable!)}</span>
              </button>
            )}
          </div>
        </div>
        <div className="ak-sheet-foot justify-start" data-atum-start-chat-footer>
          {canCreateAssistant && footerAction(copy.newAssistant, onNewAssistant, 'atum-start-chat-agent')}
          {canFindPeople && footerAction(copy.addFriend, () => onFindPerson(), 'atum-start-chat-friends')}
        </div>
      </DialogContent>
    </Dialog>
  )
}
