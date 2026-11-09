import {
  closestCorners,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors
} from '@dnd-kit/core'
import { useStore } from '@nanostores/react'
import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react'

import { AtumAssistantAvatar } from '@/app/atum/assistant-avatar'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Loader } from '@/components/ui/loader'
import { Textarea } from '@/components/ui/textarea'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import {
  Archive,
  ArrowDown,
  ArrowUp,
  Calendar,
  Checklist,
  Flag,
  GripVertical,
  List,
  MessageCircle,
  MoreHorizontal,
  Plus,
  Search,
  SlidersHorizontal,
  Trash2,
  User,
  X
} from '@/lib/icons'

import { matrixCompanyBoardCopy } from '../../shared/matrix-company-board-copy'
import { companyBoardOwnerChoice, toggleCompanyBoardOwner } from '../../shared/matrix-company-board-ownership'
import type { MatrixMessageLinkTarget } from '../../shared/matrix-message-link'

import { companyBoardCardSource } from './company-board-capture'
import {
  type CompanyCitationContext,
  companyCitationPlace,
  companyCitationSource,
  companyCitationTimestamp
} from './company-citation'
import {
  COMPANY_BOARD_CHECKLIST_TEXT_CHARACTERS,
  COMPANY_BOARD_COLUMNS,
  COMPANY_BOARD_DESCRIPTION_CHARACTERS,
  COMPANY_BOARD_PRIORITIES,
  COMPANY_BOARD_SEARCH_CHARACTERS,
  COMPANY_BOARD_TITLE_CHARACTERS,
  type CompanyAICitation,
  type CompanyAIFileRefV1,
  type CompanyAIFileRefV2,
  type CompanyBoardActivityEvent,
  type CompanyBoardCard,
  type CompanyBoardColumn,
  type CompanyBoardCommand,
  type CompanyBoardDue,
  type CompanyBoardPage,
  type CompanyBoardPriority,
  type CompanyBoardSearchPage,
  companyDesktopAdapter,
  isCompanyBoardCardV11,
  listCompleteCompanyBoard,
  readCompleteCompanyBoardActivity,
  searchCompleteCompanyBoard
} from './company-desktop-adapter'
import { CompanyProjectBrief } from './company-project-brief'
import {
  $companySpacePreferences,
  clearCompanySpaceFilters,
  type CompanyBoardViewMode,
  companySpacePreferences,
  patchCompanySpacePreferences
} from './company-space-store'
import { requestMatrixMessageLink } from './team-space/message-links'
import { useCompanyBoardLiveRefresh } from './use-company-board-live-refresh'

export interface CompanyBoardMember {
  memberRef: string
  displayName: string
  avatarUri?: string
}

export interface CompanyBoardProject {
  id: string
  displayName: string
}

type CardPatch = Extract<CompanyBoardCommand, { operation: 'patch' }>['patch']

export interface CompanyBoardProps {
  companyId: string
  members: CompanyBoardMember[]
  /** Display names for citation channels, resolved by the company directory. */
  citationChannels?: Readonly<Record<string, string>>
  /** Display-only resolution of a cited message's sender. Never authority. */
  citationContext?: CompanyCitationContext
  onOpenDiscussion?(channelId: string, threadRootEventId: string): void
  projects: CompanyBoardProject[]
  scope: string
  viewerMemberRef?: string
  /** The viewer is a company owner or admin (undefined while the role is not known: the platform decides). */
  viewerManages?: boolean
}

const statusCopy = (column: CompanyBoardColumn, copy: ReturnType<typeof matrixCompanyBoardCopy>) =>
  ({
    suggested: copy.suggested,
    to_do: copy.toDo,
    in_progress: copy.inProgress,
    blocked: copy.blocked,
    done: copy.done
  })[column]

const priorityCopy = (priority: CompanyBoardPriority, copy: ReturnType<typeof matrixCompanyBoardCopy>) =>
  ({
    low: copy.priorityLow,
    normal: copy.priorityNormal,
    high: copy.priorityHigh,
    urgent: copy.priorityUrgent
  })[priority]

const priorityTone: Record<CompanyBoardPriority, string> = {
  urgent: 'bg-(--ak-danger-fill) text-(--ak-danger)',
  high: 'bg-(--ak-fill-selected) text-(--ak-ink)',
  normal: 'bg-(--ak-fill-quiet) text-(--ak-ink-2)',
  low: 'bg-(--ak-fill-quiet) text-(--ak-ink-3)'
}

function PriorityBadge({ priority, copy }: {
  copy: ReturnType<typeof matrixCompanyBoardCopy>
  priority: CompanyBoardPriority
}) {
  return (
    <span
      className={`inline-flex h-5 shrink-0 items-center gap-1 rounded-(--ak-r-xs) px-1.5 text-[0.6875rem] leading-none font-medium ${priorityTone[priority]}`}
      data-board-priority={priority}
    >
      {(priority === 'urgent' || priority === 'high') && <Flag aria-hidden className="size-3" />}
      {priorityCopy(priority, copy)}
    </span>
  )
}

function dueText(card: CompanyBoardCard, locale: string): string | null {
  if (!card.due) {
    return null
  }

  const value = card.due.kind === 'date' ? `${card.due.date}T12:00:00Z` : card.due.at
  const date = new Date(value)

  if (!Number.isFinite(date.getTime())) {
    return null
  }

  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    ...(card.due.kind === 'instant' ? { hour: 'numeric', minute: '2-digit' } : {})
  }).format(date)
}

function dueDateValue(due: CompanyBoardDue | null): string {
  if (!due) {
    return ''
  }

  return due.kind === 'date' ? due.date : due.at.slice(0, 10)
}

const MY_TASK_COLUMNS = ['to_do', 'in_progress', 'blocked'] as const

/** Where a human-created task lands (the platform's `create` always sets To do). */
const CREATED_CARD_COLUMN: CompanyBoardColumn = 'to_do'

const priorityOrder = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3
} as const

type CompanyBoardListSort = 'due' | 'priority'
type CompanyBoardListSortDirection = 'ascending' | 'descending'

function cardPriority(card: CompanyBoardCard): number {
  const priority = (card as CompanyBoardCard & { priority?: unknown }).priority
  const rank = typeof priority === 'string' ? priorityOrder[priority as keyof typeof priorityOrder] : undefined

  return typeof rank === 'number' ? rank : Number.MAX_SAFE_INTEGER
}

function cardDueOrder(card: CompanyBoardCard): number {
  if (!card.due) {
    return Number.MAX_SAFE_INTEGER
  }

  const value = card.due.kind === 'date' ? `${card.due.date}T00:00:00Z` : card.due.at
  const parsed = Date.parse(value)

  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER
}

function compareMyTasks(left: CompanyBoardCard, right: CompanyBoardCard): number {
  return (
    cardPriority(left) - cardPriority(right) ||
    cardDueOrder(left) - cardDueOrder(right) ||
    left.title.localeCompare(right.title)
  )
}

function compareListCards(
  left: CompanyBoardCard,
  right: CompanyBoardCard,
  sort: CompanyBoardListSort,
  direction: CompanyBoardListSortDirection
): number {
  const leftValue = sort === 'due' ? cardDueOrder(left) : cardPriority(left)
  const rightValue = sort === 'due' ? cardDueOrder(right) : cardPriority(right)

  if (leftValue === Number.MAX_SAFE_INTEGER || rightValue === Number.MAX_SAFE_INTEGER) {
    if (leftValue !== rightValue) {
      return leftValue === Number.MAX_SAFE_INTEGER ? 1 : -1
    }
  } else if (leftValue !== rightValue) {
    return direction === 'ascending' ? leftValue - rightValue : rightValue - leftValue
  }

  return left.title.localeCompare(right.title)
}

type CompanyBoardLaneSort = CompanyBoardListSort | null

/**
 * One lane of the board: a rounded surface set on the board's ground, with its
 * name, count and a sort menu on top, the cards in their own scroller, and an
 * optional foot (the add-task composer in the lane new tasks land in). Sorting
 * is a view of this lane only; the server's order comes back when it is off.
 */
function BoardLane({
  cards,
  column,
  copy,
  footer,
  renderCard,
  supportsV11
}: {
  cards: CompanyBoardCard[]
  column: CompanyBoardColumn
  copy: ReturnType<typeof matrixCompanyBoardCopy>
  footer?: React.ReactNode
  renderCard(card: CompanyBoardCard): React.ReactNode
  supportsV11: boolean
}) {
  const { isOver, setNodeRef } = useDroppable({ id: `column:${column}` })
  const [sort, setSort] = useState<CompanyBoardLaneSort>(null)
  const title = statusCopy(column, copy)
  const activeSort = sort === 'priority' && !supportsV11 ? null : sort

  const sortedCards = useMemo(
    () => (activeSort ? cards.toSorted((left, right) => compareListCards(left, right, activeSort, 'ascending')) : cards),
    [activeSort, cards]
  )

  return (
    <section
      aria-label={title}
      className="company-board-lane flex max-h-full w-[17rem] shrink-0 flex-col rounded-(--ak-r-lg)"
      data-board-column={column}
      data-board-lane-over={isOver || undefined}
      ref={setNodeRef}
    >
      <header className="flex h-10 shrink-0 items-center gap-2 ps-3.5 pe-1.5">
        <h2 className="min-w-0 truncate text-[0.8125rem] leading-[1.125rem] font-semibold text-(--ak-ink)">{title}</h2>
        <span
          className="grid h-[1.125rem] min-w-[1.125rem] place-items-center rounded-full bg-(--ak-fill-quiet) px-1.5 text-[0.6875rem] leading-none font-semibold text-(--ak-ink-3) tabular-nums"
          data-board-lane-count
        >
          {cards.length}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label={`${copy.sort}: ${title}`}
              className="relative ms-auto text-(--ak-ink-3)"
              size="icon-xs"
              variant="ghost"
            >
              <MoreHorizontal aria-hidden />
              {activeSort && (
                <span
                  aria-hidden
                  className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-(--atum-accent)"
                  data-board-lane-sorted
                />
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            <DropdownMenuLabel>{copy.sort}</DropdownMenuLabel>
            {supportsV11 && (
              <DropdownMenuCheckboxItem
                checked={activeSort === 'priority'}
                onCheckedChange={checked => setSort(checked ? 'priority' : null)}
              >
                {copy.priority}
              </DropdownMenuCheckboxItem>
            )}
            <DropdownMenuCheckboxItem
              checked={activeSort === 'due'}
              onCheckedChange={checked => setSort(checked ? 'due' : null)}
            >
              {copy.dueDate}
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      <div className="grid min-h-0 flex-1 content-start gap-2 overflow-y-auto px-2 pt-0.5 pb-2" data-board-lane-cards>
        {sortedCards.map(renderCard)}
        {sortedCards.length === 0 && (
          // An empty lane still reads as a place: a slot a card can be dropped into.
          <div aria-hidden className="company-board-lane-slot h-16 rounded-(--ak-r-md)" data-board-lane-empty />
        )}
      </div>
      {footer && <div className="shrink-0 px-2 pb-2">{footer}</div>}
    </section>
  )
}

function isOverdue(card: CompanyBoardCard, now: number): boolean {
  if (!card.due || card.status === 'done') {
    return false
  }

  // A date is due through its whole day; an instant is due at that moment.
  const value = card.due.kind === 'date' ? Date.parse(`${card.due.date}T23:59:59`) : Date.parse(card.due.at)

  return Number.isFinite(value) && value < now
}

const cardChip =
  'inline-flex h-5 items-center gap-1 rounded-(--ak-r-xs) px-1.5 text-[0.6875rem] leading-none font-medium'

function BoardCard({
  card,
  locale,
  members,
  onArchive,
  archiveDisabled,
  onOpen,
  projectName
}: {
  archiveDisabled: boolean
  card: CompanyBoardCard
  locale: string
  members: CompanyBoardMember[]
  onArchive(): void
  onOpen(): void
  projectName?: string
}) {
  const { attributes, isDragging, listeners, setNodeRef, transform } = useDraggable({
    id: card.cardId,
    disabled: !card.canEdit && !card.canAccept,
    data: { status: card.status }
  })

  const copy = matrixCompanyBoardCopy(locale)
  const due = dueText(card, locale)
  const overdue = isOverdue(card, Date.now())
  const extension = isCompanyBoardCardV11(card) ? card : undefined
  const checklistDone = extension?.checklist.filter(item => item.done).length ?? 0
  const priority = extension && extension.priority !== 'normal' ? extension.priority : undefined

  const style = transform
    ? ({ transform: `translate3d(${transform.x}px, ${transform.y}px, 0) rotate(2deg)` } satisfies CSSProperties)
    : undefined

  const owners = card.owners
    .map(owner => members.find(member => member.memberRef === owner))
    .filter(Boolean) as CompanyBoardMember[]

  const hasLabels = Boolean(priority || projectName)
  const hasBadges = Boolean(due || card.description || card.conversation || (extension && extension.checklist.length > 0))

  return (
    <article
      aria-label={card.title}
      className="company-board-card group/card relative grid gap-2 rounded-(--ak-r-md) px-3 pt-2.5 pb-2.5"
      data-board-card={card.cardId}
      data-board-card-dragging={isDragging || undefined}
      data-board-status={card.status}
      onClick={onOpen}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen()
        }
      }}
      ref={setNodeRef}
      style={style}
      tabIndex={0}
    >
      {hasLabels && (
        <div className="flex min-w-0 flex-wrap items-center gap-1 pe-12">
          {priority && <PriorityBadge copy={copy} priority={priority} />}
          {projectName && (
            <span className={`${cardChip} min-w-0 bg-(--ak-fill-quiet) text-(--ak-ink-2)`} data-board-project>
              <span className="truncate">{projectName}</span>
            </span>
          )}
        </div>
      )}
      <p
        className={
          hasLabels
            ? 'line-clamp-3 min-w-0 text-[0.8125rem] leading-[1.125rem] font-medium text-(--ak-ink)'
            : 'line-clamp-3 min-w-0 pe-12 text-[0.8125rem] leading-[1.125rem] font-medium text-(--ak-ink)'
        }
      >
        {card.title}
      </p>
      <div className="absolute top-1.5 right-1.5 flex items-center gap-0.5">
        {card.canArchive && (
          <Tip label={copy.archive}>
            <Button
              aria-label={`${copy.archive}: ${card.title}`}
              className="text-(--ak-ink-3) opacity-0 transition-opacity duration-100 group-focus-within/card:opacity-100 group-hover/card:opacity-100 focus-visible:opacity-100"
              disabled={archiveDisabled}
              onClick={event => {
                event.stopPropagation()
                onArchive()
              }}
              onKeyDown={event => event.stopPropagation()}
              size="icon-xs"
              variant="ghost"
            >
              <Archive aria-hidden />
            </Button>
          </Tip>
        )}
        <button
          aria-label={`${copy.moveTask}: ${card.title}`}
          className="grid size-6 place-items-center rounded-full text-(--ak-ink-4) transition-colors duration-100 group-hover/card:text-(--ak-ink-3) hover:bg-(--ak-fill-hover) focus-visible:bg-(--ak-fill-hover)"
          onClick={event => event.stopPropagation()}
          type="button"
          {...attributes}
          {...listeners}
        >
          <GripVertical aria-hidden className="size-4" />
        </button>
      </div>
      {(hasBadges || owners.length > 0 || card.owners.length === 0) && (
        <div className="flex min-h-6 items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-1 text-(--ak-ink-3)">
            {due && (
              <span
                className={
                  overdue
                    ? `${cardChip} bg-(--ak-danger-fill) text-(--ak-danger)`
                    : `${cardChip} text-(--ak-ink-3)`
                }
                data-board-due={overdue ? 'overdue' : 'set'}
              >
                <Calendar aria-hidden className="size-3.5" />
                {due}
              </span>
            )}
            {extension && extension.checklist.length > 0 && (
              <span className={`${cardChip} text-(--ak-ink-3)`} data-board-checklist-progress>
                <Checklist aria-hidden className="size-3.5" />
                <span className="sr-only">{copy.progress} </span>
                {checklistDone}/{extension.checklist.length}
              </span>
            )}
            {card.description && (
              <span className={`${cardChip} px-1 text-(--ak-ink-4)`} data-board-has-description>
                <List aria-hidden className="size-3.5" />
                <span className="sr-only">{copy.description}</span>
              </span>
            )}
            {card.conversation && (
              <span className={`${cardChip} px-1 text-(--ak-ink-4)`} data-board-has-discussion>
                <MessageCircle aria-hidden className="size-3.5" />
                <span className="sr-only">{copy.discussion}</span>
              </span>
            )}
          </div>
          <div aria-label={copy.ownerFilter} className="flex shrink-0 -space-x-1.5">
            {owners.map(owner => (
              <AtumAssistantAvatar
                className="company-board-card-face size-6 text-[0.5625rem] leading-none"
                id={owner.memberRef}
                key={owner.memberRef}
                name={owner.displayName}
              />
            ))}
            {card.owners.length === 0 && (
              <Tip label={copy.unassigned}>
                <span
                  className="grid size-6 place-items-center rounded-full border border-dashed border-(--ak-line-2) text-(--ak-ink-4)"
                  data-board-unassigned
                >
                  <User aria-hidden className="size-3.5" />
                  <span className="sr-only">{copy.unassigned}</span>
                </span>
              </Tip>
            )}
          </div>
        </div>
      )}
    </article>
  )
}

function MyTaskRow({
  card,
  locale,
  onOpen
}: {
  card: CompanyBoardCard
  locale: string
  onOpen(): void
}) {
  const due = dueText(card, locale)
  const copy = matrixCompanyBoardCopy(locale)

  return (
    <button
      className="flex min-w-0 items-center gap-3 rounded-(--atum-r-control) px-3 py-2 text-start hover:bg-(--atum-row-hover) focus-visible:bg-(--atum-row-hover)"
      data-my-task-card={card.cardId}
      onClick={onOpen}
      type="button"
    >
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-(--atum-ink)">{card.title}</span>
      {isCompanyBoardCardV11(card) && card.priority !== 'normal' && (
        <PriorityBadge copy={copy} priority={card.priority} />
      )}
      {due && (
        <span className="flex shrink-0 items-center gap-1 text-xs text-(--atum-ink-muted)">
          <Calendar aria-hidden className="size-3.5" />
          {due}
        </span>
      )}
    </button>
  )
}

function MyTaskGroup({
  cards,
  column,
  locale,
  onOpen
}: {
  cards: CompanyBoardCard[]
  column: CompanyBoardColumn
  locale: string
  onOpen(cardId: string): void
}) {
  const copy = matrixCompanyBoardCopy(locale)

  return (
    <section className="grid gap-1" data-my-tasks-group={column}>
      <h2 className="px-3 text-xs font-semibold text-(--atum-ink-muted)">
        {statusCopy(column, copy)} <span className="text-(--atum-ink-faint)">{cards.length}</span>
      </h2>
      <div className="grid divide-y divide-(--atum-panel-line)">
        {cards.map(card => (
          <MyTaskRow card={card} key={card.cardId} locale={locale} onOpen={() => onOpen(card.cardId)} />
        ))}
      </div>
    </section>
  )
}

function MyTasksList({
  cards,
  locale,
  onOpen
}: {
  cards: CompanyBoardCard[]
  locale: string
  onOpen(cardId: string): void
}) {
  const copy = matrixCompanyBoardCopy(locale)

  const groups = Object.fromEntries(
    [...MY_TASK_COLUMNS, 'done'].map(column => [
      column,
      cards.filter(card => card.status === column).toSorted(compareMyTasks)
    ])
  ) as Record<(typeof MY_TASK_COLUMNS)[number] | 'done', CompanyBoardCard[]>

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4" data-company-my-tasks>
      <div className="mx-auto grid w-full max-w-3xl gap-5">
        {MY_TASK_COLUMNS.map(column => (
          <MyTaskGroup cards={groups[column]} column={column} key={column} locale={locale} onOpen={onOpen} />
        ))}
        <details data-my-tasks-done>
          <summary className="cursor-pointer rounded-(--atum-r-control) px-3 py-1 text-xs font-semibold text-(--atum-ink-muted) hover:bg-(--atum-row-hover)">
            {copy.done} <span className="text-(--atum-ink-faint)">{groups.done.length}</span>
          </summary>
          <div className="mt-1 grid divide-y divide-(--atum-panel-line)">
            {groups.done.map(card => (
              <MyTaskRow card={card} key={card.cardId} locale={locale} onOpen={() => onOpen(card.cardId)} />
            ))}
          </div>
        </details>
      </div>
    </div>
  )
}

function CompanyBoardList({
  cards,
  locale,
  members,
  onOpen,
  supportsV11
}: {
  cards: CompanyBoardCard[]
  locale: string
  members: CompanyBoardMember[]
  onOpen(cardId: string): void
  supportsV11: boolean
}) {
  const copy = matrixCompanyBoardCopy(locale)
  const [sort, setSort] = useState<CompanyBoardListSort>('due')
  const [direction, setDirection] = useState<CompanyBoardListSortDirection>('ascending')
  const [focusedRow, setFocusedRow] = useState(0)
  const rowRefs = useRef<Array<HTMLDivElement | null>>([])

  const gridColumns = supportsV11
    ? 'sm:grid-cols-[minmax(12rem,2fr)_minmax(6rem,0.8fr)_minmax(8rem,1fr)_minmax(6rem,0.8fr)_minmax(6rem,0.8fr)_minmax(5rem,0.7fr)]'
    : 'sm:grid-cols-[minmax(12rem,2fr)_minmax(6rem,0.8fr)_minmax(8rem,1fr)_minmax(6rem,0.8fr)]'

  const sortedCards = useMemo(
    () => cards.toSorted((left, right) => compareListCards(left, right, sort, direction)),
    [cards, direction, sort]
  )

  useEffect(() => {
    setFocusedRow(current => Math.min(current, Math.max(sortedCards.length - 1, 0)))
  }, [sortedCards.length])

  useEffect(() => {
    if (!supportsV11 && sort === 'priority') {
      setSort('due')
      setDirection('ascending')
    }
  }, [sort, supportsV11])

  const chooseSort = (next: CompanyBoardListSort) => {
    if (next === sort) {
      setDirection(current => current === 'ascending' ? 'descending' : 'ascending')
    } else {
      setSort(next)
      setDirection('ascending')
    }
  }

  const focusRow = (index: number) => {
    const next = Math.max(0, Math.min(index, sortedCards.length - 1))
    setFocusedRow(next)
    rowRefs.current[next]?.focus()
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3" data-company-board-list>
      <div className="mx-auto grid w-full max-w-6xl gap-2">
        <div aria-label={copy.sort} className="flex items-center gap-1 px-2" role="group">
          <span className="me-1 text-xs text-(--atum-ink-muted)">{copy.sort}</span>
          {(['due', ...(supportsV11 ? ['priority'] as const : [])] as const).map(key => (
            <Button
              aria-pressed={sort === key}
              key={key}
              onClick={() => chooseSort(key)}
              size="xs"
              variant={sort === key ? 'secondary' : 'text'}
            >
              {key === 'due' ? copy.dueDate : copy.priority}
              {sort === key && (direction === 'ascending' ? <ArrowUp aria-hidden /> : <ArrowDown aria-hidden />)}
            </Button>
          ))}
        </div>
        <div aria-label={copy.list} role="grid">
          <div className={`hidden items-center gap-3 px-3 py-1 text-xs font-semibold text-(--atum-ink-muted) sm:grid ${gridColumns}`} role="row">
            <span role="columnheader">{copy.taskTitle}</span>
            <span role="columnheader">{copy.status}</span>
            <span role="columnheader">{copy.owner}</span>
            <span role="columnheader">{copy.dueDate}</span>
            {supportsV11 && <span role="columnheader">{copy.priority}</span>}
            {supportsV11 && <span role="columnheader">{copy.checklist}</span>}
          </div>
          <div className="grid divide-y divide-(--atum-panel-line)" role="rowgroup">
            {sortedCards.map((card, index) => {
              const due = dueText(card, locale)
              const extension = isCompanyBoardCardV11(card) ? card : undefined

              const ownerNames = card.owners
                .map(owner => members.find(member => member.memberRef === owner)?.displayName)
                .filter((name): name is string => Boolean(name))

              const checklistDone = extension?.checklist.filter(item => item.done).length ?? 0

              return (
                <div
                  aria-label={card.title}
                  className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-(--atum-r-control) px-3 py-2 text-start hover:bg-(--atum-row-hover) focus-visible:bg-(--atum-row-hover) sm:grid ${gridColumns}`}
                  data-company-board-list-row={card.cardId}
                  key={card.cardId}
                  onClick={() => onOpen(card.cardId)}
                  onFocus={() => setFocusedRow(index)}
                  onKeyDown={event => {
                    if (event.key === 'ArrowDown') {
                      event.preventDefault()
                      focusRow(index + 1)
                    } else if (event.key === 'ArrowUp') {
                      event.preventDefault()
                      focusRow(index - 1)
                    } else if (event.key === 'Home') {
                      event.preventDefault()
                      focusRow(0)
                    } else if (event.key === 'End') {
                      event.preventDefault()
                      focusRow(sortedCards.length - 1)
                    } else if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      onOpen(card.cardId)
                    }
                  }}
                  ref={element => {
                    rowRefs.current[index] = element
                  }}
                  role="row"
                  tabIndex={focusedRow === index ? 0 : -1}
                >
                  <span className="min-w-0 flex-1 basis-2/3 truncate text-sm font-medium text-(--atum-ink) sm:basis-auto" role="gridcell">
                    {card.title}
                  </span>
                  <span className="shrink-0 text-xs text-(--atum-ink-muted)" role="gridcell">
                    {statusCopy(card.status, copy)}
                  </span>
                  <span className="min-w-0 basis-full truncate text-xs text-(--atum-ink-muted) sm:basis-auto" role="gridcell">
                    {ownerNames.length > 0 ? ownerNames.join(', ') : copy.unassigned}
                  </span>
                  <span className="flex shrink-0 items-center gap-1 text-xs text-(--atum-ink-muted)" role="gridcell">
                    {due && <Calendar aria-hidden />}
                    {due ?? copy.noDue}
                  </span>
                  {extension && (
                    <span className="shrink-0" role="gridcell">
                      <PriorityBadge copy={copy} priority={extension.priority} />
                    </span>
                  )}
                  {extension && (
                    <span className="shrink-0 text-xs text-(--atum-ink-muted)" data-board-checklist-progress role="gridcell">
                      {copy.progress} {checklistDone}/{extension.checklist.length}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

function SearchResults({
  locale,
  onOpen,
  page
}: {
  locale: string
  onOpen(cardId: string): void
  page: CompanyBoardSearchPage
}) {
  const copy = matrixCompanyBoardCopy(locale)

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4" data-company-board-search-results>
      <div className="mx-auto grid w-full max-w-3xl divide-y divide-(--atum-panel-line)">
        {page.results.map(result => (
          <button
            className="flex min-w-0 items-center gap-3 px-3 py-3 text-start hover:bg-(--atum-row-hover) focus-visible:bg-(--atum-row-hover)"
            data-company-board-search-result={result.cardId}
            key={result.cardId}
            onClick={() => onOpen(result.cardId)}
            type="button"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-(--atum-ink)">{result.title}</span>
              {result.description && (
                <span className="mt-0.5 block truncate text-xs text-(--atum-ink-muted)">{result.description}</span>
              )}
            </span>
            {result.priority !== 'normal' && <PriorityBadge copy={copy} priority={result.priority} />}
            {result.checklistProgress.total > 0 && (
              <span className="shrink-0 text-xs text-(--atum-ink-muted)">
                {result.checklistProgress.done}/{result.checklistProgress.total}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  )
}

function activitySource(
  event: CompanyBoardActivityEvent,
  context: CompanyCitationContext,
  fallback: string
): string | undefined {
  return event.sourceCitations
    .filter((citation): citation is CompanyAICitation => citation.kind !== 'board_event')
    .map(citation => companyCitationPlace(citation, context, fallback))
    .find(Boolean)
}

function CardDetail({
  busy = false,
  card,
  citationContext,
  companyId,
  members,
  onClose,
  onDismiss,
  onEditingChange,
  onOpenDiscussion,
  onOpenSource,
  onMove,
  onPatch,
  onAttachment,
  onChecklist,
  onUndo,
  viewerManages,
  viewerMemberRef
}: {
  /**
   * A board command is in flight (for this card or any other): one runs at a time, so every control that
   * would send another is disabled until it settles, and a draft being edited is kept, never dropped.
   */
  busy?: boolean
  card: CompanyBoardCard
  citationContext?: CompanyCitationContext
  companyId: string
  members: CompanyBoardMember[]
  onClose(): void
  /** A suggestion the person does not want: archived, like the card's own dismiss icon. */
  onDismiss?(): void
  onEditingChange(editing: boolean): void
  onOpenDiscussion?(channelId: string, threadRootEventId: string): void
  /** A task made from a message ("Turn into task") opens that message. */
  onOpenSource?(target: MatrixMessageLinkTarget): void
  onMove(status: CompanyBoardColumn): void
  onPatch(patch: CardPatch): void
  onAttachment(mutation: Extract<CompanyBoardCommand, { operation: 'attachment' }>['mutation']): void
  onChecklist(mutation: Extract<CompanyBoardCommand, { operation: 'checklist' }>['mutation']): void
  onUndo(event: Extract<CompanyBoardActivityEvent['undo'], { state: 'available' }>): void
  viewerManages?: boolean
  viewerMemberRef?: string
}) {
  const { locale } = useI18n()
  const copy = matrixCompanyBoardCopy(locale)
  const added = card.updatedAt === card.createdAt
  const actor = added ? card.createdBy : card.updatedBy
  const activityAt = added ? card.createdAt : card.updatedAt

  const actorName =
    actor.kind === 'cos'
      ? copy.changedByChief
      : (members.find(member => member.memberRef === actor.memberRef)?.displayName ?? copy.changedByMember)

  const latestActivitySource = card.citations
    .map(citation => companyCitationPlace(citation, citationContext ?? {}, copy.citedMessage))
    .find(Boolean)

  const activityTime = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(
    new Date(activityAt)
  )

  // Every owner, the primary first; one the directory no longer lists keeps its place unnamed.
  const owners = [...card.owners]
    .sort((a, b) => Number(b === card.primaryOwner) - Number(a === card.primaryOwner))
    .map(memberRef => members.find(member => member.memberRef === memberRef))
    .filter((member): member is CompanyBoardMember => Boolean(member))

  const ownerNames = owners.map(member => member.displayName).join(', ')
  const canChooseOwner = companyBoardOwnerChoice(card, { memberRef: viewerMemberRef, manages: viewerManages })
  const ownerChoices = members.filter(member => card.owners.includes(member.memberRef) || canChooseOwner(member.memberRef))
  const ownerEditable = ownerChoices.some(member => canChooseOwner(member.memberRef))
  // The message it was made from, as the last line of its description: shown as a link, not raw text.
  const source = companyBoardCardSource(card.description)
  const descriptionText = source ? source.text : card.description
  const dueValue = dueDateValue(card.due)
  const extension = isCompanyBoardCardV11(card) ? card : undefined
  const [editingField, setEditingField] = useState<'title' | 'description'>()
  const [draft, setDraft] = useState('')
  const [checklistText, setChecklistText] = useState('')
  const [activity, setActivity] = useState<CompanyBoardActivityEvent[]>()
  const [activityFailed, setActivityFailed] = useState(false)
  const [attachmentFailed, setAttachmentFailed] = useState(false)
  const editingFieldRef = useRef<'title' | 'description' | undefined>(undefined)

  useEffect(() => {
    if (!extension) {
      setActivity(undefined)
      setActivityFailed(false)

      return
    }

    const adapter = companyDesktopAdapter()
    let current = true
    setActivity(undefined)
    setActivityFailed(false)

    if (!adapter) {
      setActivityFailed(true)

      return
    }

    void readCompleteCompanyBoardActivity(adapter, companyId, card.cardId)
      .then(page => current && setActivity(page.events))
      .catch(() => current && setActivityFailed(true))

    return () => {
      current = false
    }
  }, [card.cardId, card.revision, companyId, extension])

  const beginEditing = (field: 'title' | 'description') => {
    if (!card.canEdit) {
      return
    }

    editingFieldRef.current = field
    setDraft(field === 'title' ? card.title : (card.description ?? ''))
    setEditingField(field)
    onEditingChange(true)
  }

  const finishEditing = () => {
    editingFieldRef.current = undefined
    setEditingField(undefined)
    onEditingChange(false)
  }

  const cancelEditing = () => finishEditing()

  const saveTitle = () => {
    // Another change is still running: the draft stays open, to be saved once it settles.
    if (editingFieldRef.current !== 'title' || busy) {
      return
    }

    const title = draft.trim()
    finishEditing()

    if (title && title !== card.title) {
      onPatch({ title })
    }
  }

  const saveDescription = () => {
    if (editingFieldRef.current !== 'description' || busy) {
      return
    }

    const description = draft.trim() || null
    finishEditing()

    if (description !== card.description) {
      onPatch({ description })
    }
  }

  const openCitation = (citation: CompanyAICitation) => {
    void companyDesktopAdapter()?.openCitation(companyId, citation).catch(() => {})
  }

  // One owner on or off: the others, the primary and the participants travel with it unchanged.
  const toggleOwner = (memberRef: string) => {
    if (!busy && canChooseOwner(memberRef)) {
      onPatch(toggleCompanyBoardOwner(card, memberRef))
    }
  }

  const chooseDue = (value: string) => {
    if (busy) {
      return
    }

    onPatch({
      due: value
        ? {
            kind: 'date',
            date: value,
            timeZone: new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
            originalText: value
          }
        : null
    })
  }

  const addChecklistItem = () => {
    const text = checklistText.trim()

    if (!extension || !text || busy) {
      return
    }

    onChecklist({
      action: 'add',
      item: { itemId: globalThis.crypto.randomUUID(), text, order: extension.checklist.length }
    })
    setChecklistText('')
    onEditingChange(false)
  }

  const attachedFiles = new Set(
    extension?.attachments.map(attachment => `${attachment.file.v}:${attachment.file.file_id}:${attachment.file.revision}`)
  )

  const attachmentChoices = card.citations
    .filter((citation): citation is Extract<CompanyAICitation, { kind: 'company_file' }> =>
      citation.kind === 'company_file')
    .filter(citation => !attachedFiles.has(`${citation.file.v}:${citation.file.file_id}:${citation.file.revision}`))

  const openAttachment = (file: CompanyAIFileRefV1 | CompanyAIFileRefV2) => {
    setAttachmentFailed(false)
    void companyDesktopAdapter()
      ?.openBoardAttachment(companyId, file)
      .catch(() => setAttachmentFailed(true))
  }

  return (
    <aside
      aria-label={copy.taskDetails}
      className="absolute inset-y-0 end-0 z-20 flex w-[min(30rem,100%)] flex-col border-s border-(--atum-panel-line) bg-(--atum-main-bg) shadow-nous"
      data-company-card-detail={card.cardId}
    >
      <header className="flex h-(--atum-l-header) shrink-0 items-center justify-between gap-3 border-b border-(--atum-panel-line) px-5">
        <h2 className="text-sm font-semibold text-(--atum-ink)">{copy.taskDetails}</h2>
        <Button onClick={onClose} size="sm" variant="text">
          {copy.close}
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        {editingField === 'title' ? (
          <Input
            aria-label={copy.taskTitle}
            autoFocus
            maxLength={COMPANY_BOARD_TITLE_CHARACTERS}
            onBlur={saveTitle}
            onChange={event => setDraft(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                cancelEditing()
              } else if (event.key === 'Enter') {
                event.preventDefault()
                saveTitle()
              }
            }}
            value={draft}
          />
        ) : card.canEdit ? (
          <button
            aria-label={`${copy.editTitle}: ${card.title}`}
            className="block w-full rounded-(--atum-r-control) text-start text-lg font-semibold text-(--atum-ink) hover:bg-(--atum-row-hover) focus-visible:bg-(--atum-row-hover)"
            onClick={() => beginEditing('title')}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.preventDefault()
                beginEditing('title')
              }
            }}
            type="button"
          >
            {card.title}
          </button>
        ) : (
          <p className="text-lg font-semibold text-(--atum-ink)">{card.title}</p>
        )}
        {editingField === 'description' ? (
          <div className="mt-2 grid gap-2">
            <Textarea
              aria-label={copy.description}
              autoFocus
              maxLength={COMPANY_BOARD_DESCRIPTION_CHARACTERS}
              onChange={event => setDraft(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  event.stopPropagation()
                  cancelEditing()
                } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault()
                  saveDescription()
                }
              }}
              rows={6}
              value={draft}
            />
            <div className="flex gap-2">
              <Button disabled={busy} onClick={saveDescription} size="sm">
                {copy.save}
              </Button>
              <Button onClick={cancelEditing} size="sm" variant="text">
                {copy.cancel}
              </Button>
            </div>
          </div>
        ) : card.canEdit ? (
          <button
            aria-label={descriptionText ? `${copy.editDescription}: ${descriptionText}` : copy.addDescription}
            className="mt-2 block w-full rounded-(--atum-r-control) text-start text-sm text-(--atum-ink-muted) hover:bg-(--atum-row-hover) focus-visible:bg-(--atum-row-hover)"
            onClick={() => beginEditing('description')}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.preventDefault()
                beginEditing('description')
              }
            }}
            type="button"
          >
            {descriptionText ?? copy.addDescription}
          </button>
        ) : (
          descriptionText && <p className="mt-2 text-sm text-(--atum-ink-muted)">{descriptionText}</p>
        )}
        {source && onOpenSource && editingField !== 'description' && (
          <Button
            className="mt-2 justify-self-start underline decoration-current"
            data-company-card-source
            onClick={() => onOpenSource(source.target)}
            size="inline"
            variant="link"
          >
            {copy.openSourceMessage}
          </Button>
        )}
        {(card.canAccept || (card.status === 'suggested' && card.canArchive && onDismiss)) && (
          <div className="mt-5 flex items-center gap-2" data-company-card-suggestion>
            {card.canAccept && (
              <Button disabled={busy} onClick={() => onMove('to_do')} size="sm">
                {copy.accept}
              </Button>
            )}
            {card.status === 'suggested' && card.canArchive && onDismiss && (
              <Button disabled={busy} onClick={onDismiss} size="sm" variant="secondary">
                {copy.dismiss}
              </Button>
            )}
          </div>
        )}
        {card.canEdit && (
          <div className="mt-5 grid gap-4">
            <label className="grid gap-1 text-xs text-(--atum-ink-muted)">
              {copy.status}
              <select
                className="atum-input h-8 text-sm"
                disabled={busy}
                onChange={event => onMove(event.target.value as CompanyBoardColumn)}
                value={card.status}
              >
                {COMPANY_BOARD_COLUMNS.map(column => (
                  <option key={column} value={column}>
                    {statusCopy(column, copy)}
                  </option>
                ))}
              </select>
            </label>
            {extension && (
              <label className="grid gap-1 text-xs text-(--atum-ink-muted)">
                {copy.priority}
                <select
                  className="atum-input h-8 text-sm"
                  disabled={busy}
                  onChange={event => onPatch({ priority: event.target.value as CompanyBoardPriority })}
                  value={extension.priority}
                >
                  {COMPANY_BOARD_PRIORITIES.map(priority => (
                    <option key={priority} value={priority}>
                      {priorityCopy(priority, copy)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="grid gap-1 text-xs text-(--atum-ink-muted)">
              {copy.owner}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    aria-label={`${copy.owner}: ${ownerNames || copy.unassigned}`}
                    className="h-8 w-full justify-start px-2 font-normal"
                    data-company-card-owners={card.owners.length}
                    // Nothing this viewer may change (a member, on a task someone else owns): read only.
                    disabled={!ownerEditable}
                    variant="outline"
                  >
                    {owners.length > 0 ? (
                      <span aria-hidden className="flex shrink-0 -space-x-1.5">
                        {owners.slice(0, 3).map(member => (
                          <AtumAssistantAvatar
                            className="size-5 text-[0.5rem] leading-none shadow-[0_0_0_1.5px_var(--atum-main-bg)]"
                            id={member.memberRef}
                            key={member.memberRef}
                            name={member.displayName}
                          />
                        ))}
                      </span>
                    ) : (
                      <span aria-hidden className="size-5 rounded-full border border-dashed border-(--atum-line)" />
                    )}
                    <span className="truncate text-sm text-(--atum-ink)">{ownerNames || copy.unassigned}</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-52">
                  {ownerChoices.map(member => (
                    <DropdownMenuCheckboxItem
                      checked={card.owners.includes(member.memberRef)}
                      disabled={busy || !canChooseOwner(member.memberRef)}
                      key={member.memberRef}
                      onCheckedChange={() => toggleOwner(member.memberRef)}
                      // Several owners are picked in one visit: the menu stays open between them.
                      onSelect={event => event.preventDefault()}
                    >
                      <AtumAssistantAvatar
                        className="size-5 text-[0.5rem] leading-none"
                        id={member.memberRef}
                        name={member.displayName}
                      />
                      <span className="truncate text-sm text-(--atum-ink)">{member.displayName}</span>
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <div className="flex items-end gap-2">
              <label className="grid flex-1 gap-1 text-xs text-(--atum-ink-muted)">
                {copy.dueDate}
                <input
                  aria-label={copy.dueDate}
                  className="atum-input h-8 text-sm"
                  disabled={busy}
                  onChange={event => chooseDue(event.target.value)}
                  type="date"
                  value={dueValue}
                />
              </label>
              {card.due && (
                <Button disabled={busy} onClick={() => chooseDue('')} size="sm" variant="text">
                  {copy.clearDue}
                </Button>
              )}
            </div>
          </div>
        )}
        {extension && !card.canEdit && (
          <div className="mt-5 flex items-center gap-2 text-xs text-(--atum-ink-muted)">
            <span>{copy.priority}</span>
            <PriorityBadge copy={copy} priority={extension.priority} />
          </div>
        )}
        {extension && (
          <section aria-label={copy.checklist} className="mt-7 grid gap-2" data-company-card-checklist>
            <h3 className="text-xs font-semibold text-(--atum-ink-muted)">
              {copy.checklist}{' '}
              <span className="font-normal text-(--atum-ink-faint)">
                {extension.checklist.filter(item => item.done).length}/{extension.checklist.length}
              </span>
            </h3>
            <ul className="grid gap-1">
              {extension.checklist.map((item, index) => (
                <li className="flex min-w-0 items-center gap-2" data-checklist-item={item.itemId} key={item.itemId}>
                  <input
                    aria-label={item.text}
                    checked={item.done}
                    disabled={busy || !card.canEdit}
                    onChange={() => onChecklist({ action: 'update', itemId: item.itemId, patch: { done: !item.done } })}
                    type="checkbox"
                  />
                  <span className={item.done ? 'min-w-0 flex-1 text-sm text-(--atum-ink-muted) line-through' : 'min-w-0 flex-1 text-sm text-(--atum-ink)'}>
                    {item.text}
                  </span>
                  {card.canEdit && (
                    <span className="flex shrink-0 items-center gap-0.5">
                      <Button
                        aria-label={`${copy.moveUp}: ${item.text}`}
                        disabled={busy || index === 0}
                        onClick={() => onChecklist({ action: 'update', itemId: item.itemId, patch: { order: index - 1 } })}
                        size="icon-xs"
                        variant="ghost"
                      >
                        <ArrowUp aria-hidden />
                      </Button>
                      <Button
                        aria-label={`${copy.moveDown}: ${item.text}`}
                        disabled={busy || index === extension.checklist.length - 1}
                        onClick={() => onChecklist({ action: 'update', itemId: item.itemId, patch: { order: index + 1 } })}
                        size="icon-xs"
                        variant="ghost"
                      >
                        <ArrowDown aria-hidden />
                      </Button>
                      <Button
                        aria-label={`${copy.remove}: ${item.text}`}
                        disabled={busy}
                        onClick={() => onChecklist({ action: 'remove', itemId: item.itemId })}
                        size="icon-xs"
                        variant="ghost"
                      >
                        <Trash2 aria-hidden />
                      </Button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
            {card.canEdit && extension.checklist.length < 50 && (
              <form
                className="flex items-end gap-2"
                onSubmit={event => {
                  event.preventDefault()
                  addChecklistItem()
                }}
              >
                <Input
                  aria-label={copy.checklistItem}
                  maxLength={COMPANY_BOARD_CHECKLIST_TEXT_CHARACTERS}
                  onBlur={() => onEditingChange(false)}
                  onChange={event => setChecklistText(event.target.value)}
                  onFocus={() => onEditingChange(true)}
                  value={checklistText}
                />
                <Button disabled={busy || !checklistText.trim()} size="sm" type="submit" variant="secondary">
                  <Plus aria-hidden />
                  {copy.addChecklistItem}
                </Button>
              </form>
            )}
          </section>
        )}
        {extension && (
          <section aria-label={copy.attachments} className="mt-7 grid gap-2" data-company-card-attachments>
            <h3 className="text-xs font-semibold text-(--atum-ink-muted)">{copy.attachments}</h3>
            <ul className="grid gap-1">
              {extension.attachments.map(attachment => (
                <li className="flex min-w-0 items-center gap-2" key={attachment.attachmentId}>
                  <Button
                    className="min-w-0 flex-1 justify-start truncate underline decoration-current"
                    onClick={() => openAttachment(attachment.file)}
                    size="inline"
                    variant="link"
                  >
                    {attachment.file.name}
                  </Button>
                  {card.canEdit && (
                    <Button
                      aria-label={`${copy.remove}: ${attachment.file.name}`}
                      disabled={busy}
                      onClick={() => onAttachment({ action: 'remove', attachmentId: attachment.attachmentId })}
                      size="icon-xs"
                      variant="ghost"
                    >
                      <X aria-hidden />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
            {card.canEdit && extension.attachments.length < 20 && (
              attachmentChoices.length === 0 ? (
                <p className="text-xs text-(--atum-ink-muted)">{copy.noAttachmentChoices}</p>
              ) : (
                <select
                  aria-label={copy.addAttachment}
                  className="atum-input h-8 text-sm"
                  disabled={busy}
                  onChange={event => {
                    const citation = attachmentChoices[Number(event.target.value)]

                    if (citation) {
                      onAttachment({ action: 'add', file: citation.file })
                    }

                    event.target.value = ''
                  }}
                  value=""
                >
                  <option value="">{copy.addAttachment}</option>
                  {attachmentChoices.map((citation, index) => (
                    <option key={`${citation.file.v}:${citation.file.file_id}`} value={index}>
                      {citation.file.name}
                    </option>
                  ))}
                </select>
              )
            )}
            {attachmentFailed && (
              <p className="text-xs text-(--atum-danger)" role="alert">
                {copy.unavailable}
              </p>
            )}
          </section>
        )}
        <section aria-label={copy.sources} className="mt-7 grid justify-items-start gap-2">
          <h3 className="text-xs font-semibold text-(--atum-ink-muted)">{copy.sources}</h3>
          {card.citations.length === 0 ? (
            <p className="text-sm text-(--atum-ink-muted)">{copy.noSources}</p>
          ) : (
            <ul className="grid justify-items-start gap-1">
              {card.citations.map(citation => {
                const source = companyCitationSource(citation, locale, citationContext, copy.citedMessage)
                const timestamp = companyCitationTimestamp(citation, locale)

                return (
                  <li key={`${citation.sourceId}:${citation.kind === 'channel' ? citation.eventId : citation.file.name}`}>
                    <Tip label={timestamp ? `${copy.openSource} · ${timestamp}` : copy.openSource}>
                      <Button
                        className="justify-start text-start underline decoration-current"
                        onClick={() => openCitation(citation)}
                        size="inline"
                        variant="link"
                      >
                        {source.label}
                      </Button>
                    </Tip>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
        {card.conversation && onOpenDiscussion && (
          <section aria-label={copy.discussion} className="mt-7 grid justify-items-start gap-2">
            <h3 className="text-xs font-semibold text-(--atum-ink-muted)">{copy.discussion}</h3>
            <Button
              className="underline decoration-current"
              onClick={() => onOpenDiscussion(card.conversation!.channelId, card.conversation!.threadRootEventId)}
              size="inline"
              variant="link"
            >
              {copy.openDiscussion}
            </Button>
          </section>
        )}
        <section aria-label={copy.activity} className="mt-7 grid gap-2" data-company-card-activity>
          <h3 className="text-xs font-semibold text-(--atum-ink-muted)">{copy.activity}</h3>
          {extension ? (
            activity ? (
              activity.length === 0 ? (
                <p className="text-sm text-(--atum-ink-muted)">{copy.activityEmpty}</p>
              ) : (
                <ol className="grid divide-y divide-(--atum-panel-line)">
                  {activity.map(event => {
                    const eventMemberRef = event.actor.kind === 'human' ? event.actor.memberRef : undefined

                    const eventActor = eventMemberRef === undefined
                      ? copy.changedByChief
                      : (members.find(member => member.memberRef === eventMemberRef)?.displayName ?? copy.changedByMember)

                    const source = activitySource(event, citationContext ?? {}, copy.citedMessage)
                    const undo = event.undo.state === 'available' ? event.undo : undefined

                    const at = new Intl.DateTimeFormat(locale, {
                      dateStyle: 'medium',
                      timeStyle: 'short'
                    }).format(new Date(event.at))

                    return (
                      <li className="flex items-start justify-between gap-3 py-2" key={event.eventId}>
                        <p className="text-sm text-(--atum-ink-muted)">
                          <span className="font-medium text-(--atum-ink)">
                            {eventActor}
                            {source ? ` · ${copy.activityFrom} ${source}` : ''}
                          </span>{' '}
                          {event.operation === 'create' ? copy.activityAdded : copy.activityUpdated}
                          {' · '}
                          {at}
                        </p>
                        {undo && (
                          <Button onClick={() => onUndo(undo)} size="inline" variant="text">
                            {copy.undo}
                          </Button>
                        )}
                      </li>
                    )
                  })}
                </ol>
              )
            ) : (
              <p className={activityFailed ? 'text-sm text-(--atum-danger)' : 'text-sm text-(--atum-ink-muted)'}>
                {activityFailed ? copy.unavailable : copy.activityLoading}
              </p>
            )
          ) : (
            <div className="flex items-center justify-between gap-3 py-1">
              <p className="text-sm text-(--atum-ink-muted)">
                <span className="font-medium text-(--atum-ink)">{actorName}</span>{' '}
                {added ? copy.activityAdded : copy.activityUpdated}
                {latestActivitySource ? ` ${copy.activityFrom} ${latestActivitySource}` : ''}
                {' · '}
                {activityTime}
              </p>
            </div>
          )}
        </section>
      </div>
    </aside>
  )
}

function FilterMenu({
  copy,
  disabled,
  members,
  onDue,
  onOwner,
  onClear,
  ownerValue,
  dueValue,
  showOwner,
  active
}: {
  active: boolean
  copy: ReturnType<typeof matrixCompanyBoardCopy>
  disabled: boolean
  dueValue: string
  members: CompanyBoardMember[]
  onClear(): void
  onDue(value: string): void
  onOwner(value: string | null): void
  ownerValue: string | null
  showOwner: boolean
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button aria-label={copy.filter} className="relative" size="sm" variant="secondary">
          <SlidersHorizontal aria-hidden />
          {copy.filter}
          {active && (
            <span
              aria-hidden
              className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-(--atum-accent)"
              data-company-filter-active
            />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        {showOwner && (
          <>
            <DropdownMenuLabel>{copy.filterOwner}</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              onValueChange={value => onOwner(value === 'all' ? null : value)}
              value={ownerValue ?? 'all'}
            >
              <DropdownMenuRadioItem disabled={disabled} value="all">
                {copy.allOwners}
              </DropdownMenuRadioItem>
              {members.map(member => (
                <DropdownMenuRadioItem disabled={disabled} key={member.memberRef} value={member.memberRef}>
                  <AtumAssistantAvatar
                    className="size-5 text-[0.5rem] leading-none"
                    id={member.memberRef}
                    name={member.displayName}
                  />
                  <span className="truncate">{member.displayName}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuLabel>{copy.filterDue}</DropdownMenuLabel>
        <DropdownMenuRadioGroup onValueChange={onDue} value={dueValue}>
          <DropdownMenuRadioItem disabled={disabled} value="all">
            {copy.allDue}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem disabled={disabled} value="due_soon">
            {copy.dueSoon}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem disabled={disabled} value="overdue">
            {copy.overdue}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem disabled={disabled} value="no_due">
            {copy.noDue}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        {active && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onClear}>{copy.clearFilters}</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function CompanyBoard({
  citationChannels,
  citationContext,
  companyId,
  members,
  onOpenDiscussion,
  projects,
  scope,
  viewerManages,
  viewerMemberRef
}: CompanyBoardProps) {
  const { locale } = useI18n()
  const copy = matrixCompanyBoardCopy(locale)
  const allPreferences = useStore($companySpacePreferences)
  const preferences = allPreferences[scope] ?? companySpacePreferences(scope)
  const [page, setPage] = useState<CompanyBoardPage>()
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [creating, setCreating] = useState(false)
  const [title, setTitle] = useState('')
  const [busyCard, setBusyCard] = useState<string>()
  const [editingCard, setEditingCard] = useState<string>()
  const [dragging, setDragging] = useState(false)
  const [briefOpen, setBriefOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchPage, setSearchPage] = useState<CompanyBoardSearchPage>()
  const [searching, setSearching] = useState(false)
  const [searchFailed, setSearchFailed] = useState(false)
  const [conflictCard, setConflictCard] = useState<string>()
  const generation = useRef(0)

  const boardView: CompanyBoardViewMode =
    preferences.boardView === 'my_tasks' && !viewerMemberRef ? 'board' : preferences.boardView

  const listOwnerMemberRef = boardView === 'my_tasks' ? (viewerMemberRef ?? null) : preferences.ownerMemberRef

  const context = useMemo<CompanyCitationContext>(
    () => ({
      channelName: channelId => citationChannels?.[channelId] ?? citationContext?.channelName?.(channelId),
      senderName: citationContext?.senderName
    }),
    [citationChannels, citationContext]
  )

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor)
  )

  useEffect(() => {
    const adapter = companyDesktopAdapter()
    const request = ++generation.current
    setLoading(true)
    setFailed(false)

    if (!adapter) {
      setLoading(false)
      setFailed(true)

      return
    }

    setSearchPage(undefined)

    void listCompleteCompanyBoard(adapter, companyId, {
        projectId: preferences.projectId,
        ownerMemberRef: listOwnerMemberRef,
        due: preferences.due,
        includeArchived: false
      })
      .then(next => {
        if (generation.current === request && next.board.companyId === companyId) {
          setPage(next)
        }
      })
      .catch(() => generation.current === request && setFailed(true))
      .finally(() => generation.current === request && setLoading(false))

    return () => {
      generation.current += 1
    }
  }, [attempt, companyId, listOwnerMemberRef, preferences.due, preferences.projectId])

  const liveIdentity = [
    companyId,
    boardView,
    preferences.projectId ?? '',
    listOwnerMemberRef ?? '',
    preferences.due
  ].join('\u0000')

  const { freshness, retry: retryFreshness } = useCompanyBoardLiveRefresh({
    active: page !== undefined,
    apply: next => {
      if (next.board.companyId === companyId) {
        setPage(next)
      }
    },
    busy: creating || dragging || busyCard !== undefined || editingCard !== undefined,
    currentRevision: page?.board.revision,
    identity: liveIdentity,
    readRevision: async () => {
      const view = await companyDesktopAdapter()?.readBoardView(companyId)

      if (!view || view.companyId !== companyId) {
        throw new Error('company_board_unavailable')
      }

      return view.revision
    },
    refetch: async () => {
      const adapter = companyDesktopAdapter()

      if (!adapter) {
        throw new Error('company_board_unavailable')
      }

      const next = await listCompleteCompanyBoard(adapter, companyId, {
        projectId: preferences.projectId,
        ownerMemberRef: listOwnerMemberRef,
        due: preferences.due,
        includeArchived: false
      })

      return next
    },
    revisionOf: next => next.board.revision
  })

  // The platform refused this person the board while it was open: stop showing what they can no longer
  // read, and fall back to the board's own unavailable state.
  useEffect(() => {
    if (freshness === 'lost') {
      setPage(undefined)
      setFailed(true)
    }
  }, [freshness])

  const cards = useMemo(() => page?.cards ?? [], [page?.cards])
  const supportsV11 = page?.contractVersion === '1.1'
  const selectedCard = cards.find(card => card.cardId === preferences.selectedCardId)

  const myTasks = useMemo(
    () =>
      boardView === 'my_tasks' && viewerMemberRef
        ? cards.filter(card => card.status !== 'suggested' && card.owners.includes(viewerMemberRef))
        : [],
    [boardView, cards, viewerMemberRef]
  )

  const columns = useMemo(
    () =>
      Object.fromEntries(
        COMPANY_BOARD_COLUMNS.map(column => [column, cards.filter(card => card.status === column)])
      ) as Record<CompanyBoardColumn, CompanyBoardCard[]>,
    [cards]
  )

  const replaceCard = (card: CompanyBoardCard) => {
    setPage(
      current =>
        current && { ...current, cards: current.cards.map(each => (each.cardId === card.cardId ? card : each)) }
    )
  }

  const runCommand = async (command: CompanyBoardCommand, optimistic?: CompanyBoardCard) => {
    const adapter = companyDesktopAdapter()
    const previous = page?.cards.find(card => card.cardId === command.cardId)

    if (!adapter || busyCard) {
      return
    }

    setBusyCard(command.cardId)
    setFailed(false)
    setConflictCard(undefined)

    if (optimistic) {
      replaceCard(optimistic)
    }

    try {
      const response = page?.contractVersion === '1.1'
        ? await adapter.commandBoard(companyId, command, '1.1')
        : await adapter.commandBoard(companyId, command)

      if ('state' in response && response.state === 'conflict') {
        replaceCard(response.currentCard)
        setConflictCard(response.currentCard.cardId)
      } else {
        replaceCard(response.card)
      }
    } catch {
      if (previous) {
        replaceCard(previous)
      }

      setFailed(true)
    } finally {
      setBusyCard(undefined)
    }
  }

  const move = (card: CompanyBoardCard, status: CompanyBoardColumn) => {
    if (status === card.status || busyCard) {
      return
    }

    const base = {
      schemaVersion: 1 as const,
      requestId: globalThis.crypto.randomUUID(),
      cardId: card.cardId,
      expectedCardRevision: card.revision
    }

    const command: CompanyBoardCommand =
      card.status === 'suggested' && status !== 'suggested'
        ? { ...base, operation: 'accept', status: status === 'done' ? 'to_do' : status }
        : { ...base, operation: 'patch', patch: { status } }

    const nextStatus = command.operation === 'accept' ? command.status : status
    void runCommand(command, { ...card, status: nextStatus, accepted: nextStatus !== 'suggested' })
  }

  const patchCard = (card: CompanyBoardCard, patch: CardPatch) => {
    if (busyCard) {
      return
    }

    void runCommand(
      {
        schemaVersion: 1,
        operation: 'patch',
        requestId: globalThis.crypto.randomUUID(),
        cardId: card.cardId,
        expectedCardRevision: card.revision,
        patch
      },
      { ...card, ...patch, accepted: (patch.status ?? card.status) !== 'suggested' }
    )
  }

  const mutateChecklist = (
    card: CompanyBoardCard,
    mutation: Extract<CompanyBoardCommand, { operation: 'checklist' }>['mutation']
  ) => {
    if (!isCompanyBoardCardV11(card) || busyCard) {
      return
    }

    void runCommand({
      schemaVersion: 1,
      operation: 'checklist',
      requestId: globalThis.crypto.randomUUID(),
      cardId: card.cardId,
      expectedCardRevision: card.revision,
      mutation
    })
  }

  const mutateAttachment = (
    card: CompanyBoardCard,
    mutation: Extract<CompanyBoardCommand, { operation: 'attachment' }>['mutation']
  ) => {
    if (!isCompanyBoardCardV11(card) || busyCard) {
      return
    }

    void runCommand({
      schemaVersion: 1,
      operation: 'attachment',
      requestId: globalThis.crypto.randomUUID(),
      cardId: card.cardId,
      expectedCardRevision: card.revision,
      mutation
    })
  }

  const archiveCard = async (card: CompanyBoardCard) => {
    const adapter = companyDesktopAdapter()
    const previousIndex = page?.cards.findIndex(each => each.cardId === card.cardId) ?? -1

    if (!adapter || busyCard || previousIndex < 0) {
      return
    }

    // The card goes back where it was, unless a newer read already brought it back.
    const restore = (restored: CompanyBoardCard) =>
      setPage(current => {
        if (!current || current.cards.some(each => each.cardId === restored.cardId)) {
          return current
        }

        const cards = [...current.cards]
        cards.splice(Math.min(previousIndex, cards.length), 0, restored)

        return { ...current, cards }
      })

    setBusyCard(card.cardId)
    setFailed(false)
    setConflictCard(undefined)
    setPage(current => current && { ...current, cards: current.cards.filter(each => each.cardId !== card.cardId) })

    try {
      const command: CompanyBoardCommand = {
        schemaVersion: 1,
        operation: 'archive',
        requestId: globalThis.crypto.randomUUID(),
        cardId: card.cardId,
        expectedCardRevision: card.revision,
        archived: true
      }

      const response = page?.contractVersion === '1.1'
        ? await adapter.commandBoard(companyId, command, '1.1')
        : await adapter.commandBoard(companyId, command)

      // Someone changed it first: it was not archived. It comes back as it now stands, with the notice.
      if ('state' in response && response.state === 'conflict') {
        restore(response.currentCard)
        replaceCard(response.currentCard)
        setConflictCard(response.currentCard.cardId)
      }
    } catch {
      restore(card)
      setFailed(true)
    } finally {
      setBusyCard(undefined)
    }
  }

  const onDragStart = () => setDragging(true)
  const onDragCancel = () => setDragging(false)

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setDragging(false)
    const card = cards.find(item => item.cardId === active.id)

    const column =
      typeof over?.id === 'string' && over.id.startsWith('column:')
        ? (over.id.slice('column:'.length) as CompanyBoardColumn)
        : undefined

    if (card && column && COMPANY_BOARD_COLUMNS.includes(column)) {
      move(card, column)
    }
  }

  const create = async () => {
    const adapter = companyDesktopAdapter()
    const value = title.trim()

    if (!adapter || !value) {
      return
    }

    const cardId = globalThis.crypto.randomUUID()
    setBusyCard(cardId)
    setFailed(false)

    try {
      const command: CompanyBoardCommand = {
        schemaVersion: 1,
        operation: 'create',
        requestId: globalThis.crypto.randomUUID(),
        cardId,
        title: value,
        ...(preferences.projectId ? { projectId: preferences.projectId } : {})
      }

      const response = page?.contractVersion === '1.1'
        ? await adapter.commandBoard(companyId, command, '1.1')
        : await adapter.commandBoard(companyId, command)

      if ('state' in response && response.state === 'conflict') {
        setConflictCard(response.currentCard.cardId)
        setPage(current => current && { ...current, cards: [response.currentCard, ...current.cards] })
      } else {
        setPage(current => current && { ...current, cards: [response.card, ...current.cards] })
      }

      setTitle('')
      setCreating(false)
    } catch {
      setFailed(true)
    } finally {
      setBusyCard(undefined)
    }
  }

  const openTask = async (cardId: string) => {
    setBriefOpen(false)
    patchCompanySpacePreferences(scope, { selectedCardId: cardId })

    if (cards.some(card => card.cardId === cardId)) {
      return
    }

    try {
      const card = await companyDesktopAdapter()?.readBoardCard(companyId, cardId)

      if (card) {
        setPage(current => current && { ...current, cards: [...current.cards, card] })
      }
    } catch {
      setFailed(true)
    }
  }

  const search = async () => {
    const adapter = companyDesktopAdapter()
    const query = searchQuery.trim()

    if (!adapter || !supportsV11 || !query) {
      setSearchPage(undefined)

      return
    }

    setSearching(true)
    setSearchFailed(false)

    try {
      const result = await searchCompleteCompanyBoard(adapter, companyId, {
        query,
        projectId: preferences.projectId,
        ownerMemberRef: listOwnerMemberRef,
        due: preferences.due,
        includeArchived: false
      })

      setSearchPage(result)
    } catch {
      setSearchFailed(true)
    } finally {
      setSearching(false)
    }
  }

  const filtersActive = Boolean(
    preferences.projectId ||
      (boardView !== 'my_tasks' && preferences.ownerMemberRef) ||
      preferences.due !== 'all'
  )

  const menuFiltersActive = Boolean(
    (boardView !== 'my_tasks' && preferences.ownerMemberRef) || preferences.due !== 'all'
  )

  const visibleCards = boardView === 'my_tasks' ? myTasks : cards
  const lanesVisible = Boolean(page && !searchPage && boardView === 'board')
  const projectNames = new Map(projects.map(project => [project.id, project.displayName]))

  // New tasks land in To do (the platform's create), so that lane carries the composer.
  const laneComposer = creating ? (
    <form
      className="company-board-card grid gap-2 rounded-(--ak-r-md) p-2"
      data-board-lane-composer
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          setCreating(false)
        }
      }}
      onSubmit={event => {
        event.preventDefault()
        void create()
      }}
    >
      <Input
        aria-label={copy.taskTitle}
        autoFocus
        maxLength={160}
        onChange={event => setTitle(event.target.value)}
        placeholder={copy.taskTitle}
        value={title}
      />
      <div className="flex items-center gap-1">
        <Button disabled={!title.trim() || Boolean(busyCard)} size="sm" type="submit">
          {copy.createTask}
        </Button>
        <Button aria-label={copy.cancel} onClick={() => setCreating(false)} size="icon-sm" type="button" variant="ghost">
          <X aria-hidden />
        </Button>
      </div>
    </form>
  ) : (
    <Button
      aria-label={`${copy.addTask}: ${statusCopy(CREATED_CARD_COLUMN, copy)}`}
      className="w-full justify-start text-(--ak-ink-3)"
      onClick={() => setCreating(true)}
      size="sm"
      variant="ghost"
    >
      <Plus aria-hidden />
      {copy.addTask}
    </Button>
  )


  return (
    <section className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" data-company-board>
      <header className="flex flex-wrap items-center gap-2 border-b border-(--atum-panel-line) px-5 py-3">
        <div aria-label={copy.boardViews} className="flex items-center gap-1" role="group">
          {(['board', 'list', 'my_tasks'] as const).map(view => (
            <Button
              aria-pressed={boardView === view}
              disabled={view === 'my_tasks' && !viewerMemberRef}
              key={view}
              onClick={() => patchCompanySpacePreferences(scope, { boardView: view })}
              size="sm"
              variant={boardView === view ? 'secondary' : 'text'}
            >
              {view === 'board' ? copy.board : view === 'list' ? copy.list : copy.myTasks}
            </Button>
          ))}
        </div>
        <Button onClick={() => setCreating(value => !value)} size="sm">
          <Plus aria-hidden />
          {copy.addTask}
        </Button>
        <select
          aria-label={copy.projectFilter}
          className="desktop-input-chrome h-8 min-w-36 rounded-md px-2 text-sm"
          onChange={event => patchCompanySpacePreferences(scope, { projectId: event.target.value || null })}
          value={preferences.projectId ?? ''}
        >
          <option value="">{copy.allProjects}</option>
          {projects.map(project => (
            <option key={project.id} value={project.id}>
              {project.displayName}
            </option>
          ))}
        </select>
        <FilterMenu
          active={menuFiltersActive}
          copy={copy}
          disabled={Boolean(busyCard)}
          dueValue={preferences.due}
          members={members}
          onClear={() => clearCompanySpaceFilters(scope)}
          onDue={value =>
            patchCompanySpacePreferences(scope, { due: value as typeof preferences.due })
          }
          onOwner={value => patchCompanySpacePreferences(scope, { ownerMemberRef: value })}
          ownerValue={preferences.ownerMemberRef}
          showOwner={boardView !== 'my_tasks'}
        />
        {boardView === 'list' && viewerMemberRef && (
          <Button
            aria-pressed={preferences.ownerMemberRef === viewerMemberRef}
            onClick={() =>
              patchCompanySpacePreferences(scope, {
                ownerMemberRef: preferences.ownerMemberRef === viewerMemberRef ? null : viewerMemberRef
              })
            }
            size="sm"
            variant={preferences.ownerMemberRef === viewerMemberRef ? 'secondary' : 'text'}
          >
            {copy.mine}
          </Button>
        )}
        {supportsV11 && (
          <form
            className="flex min-w-48 flex-1 items-center gap-1 sm:max-w-72"
            onSubmit={event => {
              event.preventDefault()
              void search()
            }}
            role="search"
          >
            <Input
              aria-label={copy.searchTasks}
              maxLength={COMPANY_BOARD_SEARCH_CHARACTERS}
              onChange={event => {
                setSearchQuery(event.target.value)

                if (!event.target.value.trim()) {
                  setSearchPage(undefined)
                  setSearchFailed(false)
                }
              }}
              placeholder={copy.searchTasks}
              type="search"
              value={searchQuery}
            />
            <Button aria-label={copy.searchTasks} disabled={!searchQuery.trim() || searching} size="icon-sm" type="submit" variant="ghost">
              <Search aria-hidden />
            </Button>
            {searchPage && (
              <Button
                aria-label={copy.clearSearch}
                onClick={() => {
                  setSearchQuery('')
                  setSearchPage(undefined)
                  setSearchFailed(false)
                }}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <X aria-hidden />
              </Button>
            )}
          </form>
        )}
        <span className="ms-auto flex items-center gap-2">
          {page && freshness === 'stale' && (
            <span className="flex items-center gap-1 text-xs text-(--atum-ink-muted)" data-company-board-stale role="status">
              {copy.boardStale}
              <Button onClick={retryFreshness} size="sm" variant="text">
                {copy.retry}
              </Button>
            </span>
          )}
          {preferences.projectId && (
            <Button onClick={() => setBriefOpen(true)} size="sm" variant="text">
              {copy.openBrief}
            </Button>
          )}
        </span>
      </header>
      {creating && !lanesVisible && (
        <form
          className="flex items-end gap-2 border-b border-(--atum-panel-line) px-5 py-3"
          onSubmit={event => {
            event.preventDefault()
            void create()
          }}
        >
          <Input
            aria-label={copy.taskTitle}
            autoFocus
            maxLength={160}
            onChange={event => setTitle(event.target.value)}
            value={title}
          />
          <Button disabled={!title.trim() || Boolean(busyCard)} size="sm" type="submit">
            {copy.createTask}
          </Button>
        </form>
      )}
      {loading && !page && <Loader className="m-auto size-8" label={copy.checking} />}
      {failed && !page && (
        <div className="m-auto grid justify-items-center gap-2">
          <p className="text-sm text-(--atum-ink-muted)">{copy.unavailable}</p>
          <Button onClick={() => setAttempt(value => value + 1)} size="sm" variant="secondary">
            {copy.retry}
          </Button>
        </div>
      )}
      {page && !searchPage && !lanesVisible && visibleCards.length === 0 && (
        <div className="m-auto grid justify-items-center gap-2">
          <p className="text-sm text-(--atum-ink-muted)">
            {filtersActive ? copy.noMatches : boardView === 'my_tasks' ? copy.emptyMyTasks : copy.emptyBoard}
          </p>
          {filtersActive && (
            <Button onClick={() => clearCompanySpaceFilters(scope)} size="sm" variant="secondary">
              {copy.clearFilters}
            </Button>
          )}
        </div>
      )}
      {lanesVisible && (
        // The board's ground: a quiet tinted surface the lanes stand on, so the
        // board reads as one organised place rather than cards on an open page.
        <div className="company-board-canvas flex min-h-0 flex-1 flex-col" data-company-board-canvas>
          {cards.length === 0 && (
            <div className="flex shrink-0 items-center gap-3 px-5 pt-4" data-company-board-empty>
              <p className="text-[0.8125rem] text-(--ak-ink-3)">{filtersActive ? copy.noMatches : copy.emptyBoard}</p>
              {filtersActive && (
                <Button onClick={() => clearCompanySpaceFilters(scope)} size="sm" variant="secondary">
                  {copy.clearFilters}
                </Button>
              )}
            </div>
          )}
          <DndContext
            collisionDetection={closestCorners}
            onDragCancel={onDragCancel}
            onDragEnd={onDragEnd}
            onDragStart={onDragStart}
            sensors={sensors}
          >
            <div
              className="flex min-h-0 flex-1 items-start gap-3 overflow-x-auto overflow-y-hidden p-4"
              data-company-board-columns
            >
              {COMPANY_BOARD_COLUMNS.map(column => (
                <BoardLane
                  cards={columns[column]}
                  column={column}
                  copy={copy}
                  footer={column === CREATED_CARD_COLUMN ? laneComposer : undefined}
                  key={column}
                  renderCard={card => (
                    <BoardCard
                      archiveDisabled={Boolean(busyCard)}
                      card={card}
                      key={card.cardId}
                      locale={locale}
                      members={members}
                      onArchive={() => void archiveCard(card)}
                      onOpen={() => patchCompanySpacePreferences(scope, { selectedCardId: card.cardId })}
                      projectName={
                        card.projectId && !preferences.projectId ? projectNames.get(card.projectId) : undefined
                      }
                    />
                  )}
                  supportsV11={supportsV11}
                />
              ))}
            </div>
          </DndContext>
        </div>
      )}
      {page && !searchPage && boardView === 'my_tasks' && myTasks.length > 0 && (
        <MyTasksList
          cards={myTasks}
          locale={locale}
          onOpen={cardId => patchCompanySpacePreferences(scope, { selectedCardId: cardId })}
        />
      )}
      {page && !searchPage && boardView === 'list' && cards.length > 0 && (
        <CompanyBoardList
          cards={cards}
          locale={locale}
          members={members}
          onOpen={cardId => patchCompanySpacePreferences(scope, { selectedCardId: cardId })}
          supportsV11={supportsV11}
        />
      )}
      {searchPage && searchPage.results.length > 0 && (
        <SearchResults locale={locale} onOpen={cardId => void openTask(cardId)} page={searchPage} />
      )}
      {searchPage && searchPage.results.length === 0 && (
        <p className="m-auto text-sm text-(--atum-ink-muted)">{copy.noSearchResults}</p>
      )}
      {searching && <Loader className="m-auto size-8" label={copy.checking} />}
      {searchFailed && (
        <p className="px-5 py-2 text-sm text-(--atum-danger)" role="alert">
          {copy.unavailable}
        </p>
      )}
      {failed && page && (
        <p className="px-5 py-2 text-sm text-(--atum-danger)" role="alert">
          {copy.unavailable}
        </p>
      )}
      {conflictCard && (
        <p className="px-5 py-2 text-sm text-(--atum-danger)" data-company-board-conflict={conflictCard} role="alert">
          {copy.boardChanged}
        </p>
      )}
      {selectedCard && (
        <CardDetail
          busy={busyCard !== undefined}
          card={selectedCard}
          citationContext={context}
          companyId={companyId}
          members={members}
          onAttachment={mutation => mutateAttachment(selectedCard, mutation)}
          onChecklist={mutation => mutateChecklist(selectedCard, mutation)}
          onClose={() => {
            setEditingCard(undefined)
            patchCompanySpacePreferences(scope, { selectedCardId: null })
          }}
          onDismiss={() => void archiveCard(selectedCard)}
          onEditingChange={editing => setEditingCard(editing ? selectedCard.cardId : undefined)}
          onMove={status => move(selectedCard, status)}
          onOpenDiscussion={onOpenDiscussion}
          onOpenSource={target => {
            patchCompanySpacePreferences(scope, { tab: 'chat' })
            requestMatrixMessageLink(target)
          }}
          onPatch={patch => patchCard(selectedCard, patch)}
          onUndo={undo =>
            void runCommand({
              schemaVersion: 1,
              operation: 'undo',
              requestId: globalThis.crypto.randomUUID(),
              cardId: selectedCard.cardId,
              expectedCardRevision: undo.expectedCardRevision,
              targetEventId: undo.targetEventId
            })
          }
          viewerManages={viewerManages}
          viewerMemberRef={viewerMemberRef}
        />
      )}
      {briefOpen && preferences.projectId && (
        <CompanyProjectBrief
          citationChannels={citationChannels}
          citationContext={citationContext}
          companyId={companyId}
          onClose={() => setBriefOpen(false)}
          onOpenTask={cardId => void openTask(cardId)}
          projectId={preferences.projectId}
        />
      )}
    </section>
  )
}
