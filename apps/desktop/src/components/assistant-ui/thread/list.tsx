import { ThreadPrimitive, useAuiEvent, useAuiState } from '@assistant-ui/react'
import {
  type ComponentProps,
  type CSSProperties,
  type FC,
  memo,
  type ReactNode,
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { useStickToBottom } from 'use-stick-to-bottom'

import { useReducedMotion } from '@/hooks/use-reduced-motion'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import {
  onScrollToBottomRequest,
  onThreadEditClose,
  onThreadEditOpen,
  resetThreadScroll,
  setThreadAtBottom
} from '@/store/thread-scroll'
import { isSecondaryWindow } from '@/store/windows'

import { MessageRenderBoundary } from '../message-render-boundary'

type ThreadMessageComponents = ComponentProps<typeof ThreadPrimitive.MessageByIndex>['components']

export type MessageGroup = { id: string; weight: number } & (
  | { index: number; kind: 'standalone' }
  | { indices: number[]; kind: 'turn' }
)

export type MessageSignatureRow = readonly [index: number, id: string, role: string, weight: number]

/** Deterministic primitive tuples keep arbitrary message IDs separate from role and weight. */
export function serializeMessageSignature(rows: readonly MessageSignatureRow[]): string {
  return rows.length ? JSON.stringify(rows) : ''
}

/** The signature is internal state derived above; JSON preserves every string code point. */
export function parseMessageSignature(signature: string) {
  if (!signature) {
    return []
  }

  return (JSON.parse(signature) as MessageSignatureRow[]).map(([index, id, role, weight]) => ({
    id,
    index: Number(index),
    role,
    weight: Number(weight) || 1
  }))
}

// DOM is bounded by a rendered-PART budget, not a message/turn count: a single
// assistant message folds every tool call into a part, so heavy sessions are
// ~40 turns / ~100 messages but ~1000 parts — and parts are what drive node
// count. "Show earlier" prepends another page; whole turns stay intact so the
// sticky human bubble never loses its turn. This is the long-session perf lever
// WITHOUT a virtualizer — pure rendering, never touches scrollTop, so it can't
// fight use-stick-to-bottom (the single scroll owner).
const RENDER_BUDGET = 300
// On session switch, paint a small budget first (enough for the bottom turn(s)
// the user actually sees after scroll-to-bottom), then bump to the full budget
// in a requestAnimationFrame — defers the heavy markdown+syntax-highlight render
// past the initial commit, so the switch feels instant.
const FIRST_PAINT_BUDGET = 60

interface ThreadMessageListProps {
  clampToComposer: boolean
  /** The composer floats over the column's foot (it reports its height as `--atum-dock-height`):
   * the transcript runs to the bottom edge and keeps that much clear so the last message can
   * scroll fully above it. */
  dockClearance?: boolean
  components: ThreadMessageComponents
  emptyPlaceholder?: ReactNode
  /** The conversation's first item, above its first message: the first run's welcome, which stays
   * with the chat until the person has answered it. Shown only while nothing earlier is folded away. */
  leading?: ReactNode
  /** Fetch one older server page when the person reaches the start of loaded history. */
  loadEarlier?: () => Promise<boolean>
  loadingIndicator?: ReactNode
  /** Search may ask the bounded renderer to expose one already-loaded message. */
  revealMessageId?: string
  sessionKey?: string | null
}

// Group each user message with the assistant turn(s) that follow it so the
// human bubble can `position: sticky` against the scroller across its whole
// turn (see StickyHumanMessageContainer in thread.tsx).
export function buildGroups(signature: string): MessageGroup[] {
  if (!signature) {
    return []
  }

  const messages = parseMessageSignature(signature)

  const groups: MessageGroup[] = []

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]

    if (message.role !== 'user') {
      groups.push({ id: message.id, index: message.index, kind: 'standalone', weight: message.weight })

      continue
    }

    const indices = [message.index]
    let weight = message.weight

    while (i + 1 < messages.length && messages[i + 1].role !== 'user') {
      weight += messages[++i].weight
      indices.push(messages[i].index)
    }

    groups.push({ id: message.id, indices, kind: 'turn', weight })
  }

  return groups
}

// Walk turns newest-first, summing their part weights until the budget is met;
// everything before the first kept turn is hidden. Returns the index of that
// first visible group.
export function firstVisibleGroupIndex(groups: readonly MessageGroup[], budget: number): number {
  let firstVisible = groups.length

  for (let i = groups.length - 1, weight = 0; i >= 0; i--) {
    weight += groups[i].weight
    firstVisible = i

    if (weight >= budget) {
      break
    }
  }

  return firstVisible
}

/** Parts that must be rendered to expose one message while keeping the newer tail present. */
export function messageRevealBudget(groups: readonly MessageGroup[], messageIndex: number): number {
  const groupIndex = groups.findIndex(group =>
    group.kind === 'turn' ? group.indices.includes(messageIndex) : group.index === messageIndex
  )

  return groupIndex < 0 ? 0 : groups.slice(groupIndex).reduce((total, group) => total + group.weight, 0)
}

/** Distance from the viewport's top position to the transcript's bottom before a prepend. */
export function transcriptPrependAnchor(scrollHeight: number, scrollTop: number): number {
  return scrollHeight - scrollTop
}

/** The scrollTop that keeps the same content in view after older rows were prepended. */
export function transcriptScrollTop(scrollHeight: number, anchor: number): number {
  return Math.max(0, scrollHeight - anchor)
}

/** A history page introduces a new oldest ID while retaining part of the prior window. */
export function transcriptPagePrepended(
  previousMessageIds: ReadonlySet<string>,
  messageIds: readonly string[]
): boolean {
  const oldest = messageIds[0]

  return Boolean(oldest) && !previousMessageIds.has(oldest) && messageIds.some(id => previousMessageIds.has(id))
}

// content-visibility:auto skips off-screen turns for perf, but with
// contain-intrinsic-size:auto the browser only remembers a turn's size AFTER
// it has rendered. A turn that finishes streaming near the bottom may have had
// its (smaller) mid-stream size remembered; when it scrolls just off the top
// edge and gets skipped, it snaps back to that stale height, shifting content
// down. With overflow-anchor:none (the viewport can't self-correct) the
// stick-to-bottom lock drifts and the view creeps up over older turns — the
// "long session eventually shows old responses" glitch.
//
// Keep the newest N turns always-rendered so a turn is only ever virtualized
// once its layout has settled at its final size (remembered == real → skipping
// it changes no height). Off-screen OLDER turns still skip, so the dialog/popover
// recalc win on long transcripts is preserved (that scales with the hundreds of
// old turns, not this small live tail).
export const LIVE_TAIL_GROUPS = 6

/** True when a visible group is old enough to virtualize (outside the live tail). */
export function isVirtualizedGroup(indexInVisible: number, visibleCount: number, liveTail = LIVE_TAIL_GROUPS): boolean {
  return indexInVisible < visibleCount - liveTail
}

const ThreadMessageListInner: FC<ThreadMessageListProps> = ({
  clampToComposer,
  components,
  dockClearance = false,
  emptyPlaceholder,
  leading,
  loadEarlier,
  loadingIndicator,
  revealMessageId,
  sessionKey
}) => {
  const messageSignature = useAuiState(s =>
    serializeMessageSignature(
      s.thread.messages.map(
        (message, index) => [index, message.id, message.role, message.content?.length ?? 1] as const
      )
    )
  )

  const groups = useMemo(() => buildGroups(messageSignature), [messageSignature])

  const messageIds = useMemo(
    () => parseMessageSignature(messageSignature).map(message => message.id),
    [messageSignature]
  )

  const { t } = useI18n()
  const reduceMotion = useReducedMotion()

  const revealMessageIndex = useAuiState(state =>
    revealMessageId ? state.thread.messages.findIndex(message => message.id === revealMessageId) : -1
  )

  const revealBudget = messageRevealBudget(groups, revealMessageIndex)
  // A live turn belongs to the observed content even if history has not
  // arrived yet. The empty greeting must not replace (or sit over) that turn.
  const renderEmpty = groups.length === 0 && Boolean(emptyPlaceholder) && !loadingIndicator

  // use-stick-to-bottom owns scrollTop (single writer): follow while locked,
  // escape on user scroll-up, re-lock at bottom. Snap instantly, not spring — a
  // spring can't tell live-token growth from a session-switch bulk relayout, and
  // chasing the latter reads as the view scrolling to random spots before
  // settling. Its refs hang off our own DOM so the sticky human bubbles survive.
  const { scrollRef, contentRef, isAtBottom, scrollToBottom, stopScroll } = useStickToBottom({
    initial: 'instant',
    resize: 'instant'
  })

  const [renderBudget, setRenderBudget] = useState(FIRST_PAINT_BUDGET)

  // Cut the budget during RENDER, not in the post-commit layout effect. An
  // effect-time cut is too late: React would first build the whole tree with
  // the full budget (up to 300 parts of markdown + syntax highlighting),
  // commit it, and only then re-render at the small budget. The render-phase
  // state adjustment restarts this component immediately — before any child
  // renders — so the heavy commit never happens.
  //
  // Two triggers, because the transcript swap arrives differently per path:
  // a WARM switch publishes sessionKey + messages in one commit (the key
  // branch), while a COLD switch changes sessionKey with an empty transcript
  // and the prefetched messages land hundreds of ms later under the SAME key
  // (the empty→non-empty branch).
  const hasGroups = groups.length > 0
  const [budgetSessionKey, setBudgetSessionKey] = useState(sessionKey)
  const [hadGroups, setHadGroups] = useState(hasGroups)

  if (budgetSessionKey !== sessionKey) {
    setBudgetSessionKey(sessionKey)
    setHadGroups(hasGroups)
    setRenderBudget(FIRST_PAINT_BUDGET)
  } else if (hadGroups !== hasGroups) {
    setHadGroups(hasGroups)

    if (hasGroups) {
      setRenderBudget(FIRST_PAINT_BUDGET)
    }
  }

  // Backfill from FIRST_PAINT_BUDGET to the full budget after the small
  // commit painted — as a TRANSITION, so the heavy markdown + syntax
  // highlight render of the older turns is interruptible instead of one long
  // synchronous commit that freezes input right after the switch. Route
  // changes stay urgent (main.tsx disables router transitions); it's exactly
  // this backfill that belongs at background priority. "Show earlier" pages
  // (budget > RENDER_BUDGET) never re-enter here.
  useEffect(() => {
    if (renderBudget >= RENDER_BUDGET) {
      return
    }

    const rafId = requestAnimationFrame(() => {
      // Functional max, not a plain set: an urgent "Show earlier" click can
      // land between scheduling and committing this transition, and a plain
      // set would rebase over it and shrink the budget back down.
      startTransition(() => setRenderBudget(budget => Math.max(budget, RENDER_BUDGET)))
    })

    return () => cancelAnimationFrame(rafId)
  }, [renderBudget])

  // A deep search result may expose hundreds of already-loaded parts. Keep that work
  // interruptible instead of putting the whole Markdown rebuild in the urgent input render.
  useEffect(() => {
    if (revealBudget <= renderBudget) {
      return
    }

    startTransition(() => setRenderBudget(budget => Math.max(budget, revealBudget)))
  }, [renderBudget, revealBudget])

  const hiddenCount = firstVisibleGroupIndex(groups, renderBudget)
  const visibleGroups = hiddenCount > 0 ? groups.slice(hiddenCount) : groups
  const restoreFromBottomRef = useRef<number | null>(null)
  const historyBusyRef = useRef(false)
  const historyHasMoreRef = useRef(true)
  const historyGenerationRef = useRef(0)
  const historyPageRef = useRef<{ messageIds: ReadonlySet<string>; received: boolean } | null>(null)
  // Secondary windows (new-session scratch, subagent watch, cmd-click pop-out)
  // hide the titlebar tool cluster + session header, but the OS traffic lights
  // still sit in the top-left, so reserve the titlebar gap above the transcript.
  const secondaryWindow = isSecondaryWindow()
  // NB: CSS calc() requires whitespace around the +/- operator. This string is
  // assigned verbatim to the --sticky-human-top inline style below (it does not
  // go through Tailwind, which would auto-space it), so the spaces are load-
  // bearing — without them the declaration is invalid, gets dropped, and the
  // sticky user bubble falls back to its ~4px default and slides under the OS
  // traffic lights.
  const secondaryTitlebarGap = 'calc(var(--titlebar-height) + 0.75rem)'

  const threadContentTopPad = secondaryWindow
    ? 'pt-[calc(var(--titlebar-height)+0.75rem)]'
    : 'pt-[calc(var(--titlebar-height)-0.5rem)]'

  useEffect(() => setThreadAtBottom(isAtBottom), [isAtBottom])
  useEffect(() => () => resetThreadScroll(), [])

  // Floating jump button (outside this subtree) → return to the bottom.
  useEffect(() => onScrollToBottomRequest(() => void scrollToBottom()), [scrollToBottom])

  const endEditHold = useCallback(() => {
    scrollRef.current?.removeAttribute('data-editing')
  }, [scrollRef])

  // Inline edit grows a sticky bubble. Escape before focus/layout so the
  // resize-follow can't snap scrollTop; native anchoring holds the viewport.
  const beginEditHold = useCallback(() => {
    const el = scrollRef.current

    if (!el) {
      return
    }

    endEditHold()
    stopScroll()
    el.setAttribute('data-editing', 'true')
  }, [endEditHold, scrollRef, stopScroll])

  useEffect(() => onThreadEditOpen(beginEditHold), [beginEditHold])
  useEffect(() => onThreadEditClose(endEditHold), [endEditHold])
  useEffect(() => () => endEditHold(), [endEditHold])
  // New run → snap to the latest turn.
  useAuiEvent('thread.runStart', () => void scrollToBottom())

  // Reset the cap and pin to bottom on mount + every session switch (messages
  // swap in place on a long-lived runtime, so sessionKey is the only signal).
  // The swap is multi-step and lays out over many frames; letting the library
  // follow re-pins every frame to a moving target — visible as ~10 scroll jumps.
  // Instead: quiet it, glue to the true bottom until the height holds steady,
  // then hand back locked. Live streaming afterward uses the normal resize follow.
  useLayoutEffect(() => {
    const el = scrollRef.current

    if (!el) {
      return
    }

    stopScroll()
    el.scrollTop = el.scrollHeight

    if (reduceMotion) {
      void scrollToBottom('instant')

      return
    }

    let frame = 0
    let stableFrames = 0
    let lastHeight = el.scrollHeight

    const settle = () => {
      const node = scrollRef.current

      if (!node) {
        return
      }

      const height = node.scrollHeight

      stableFrames = height === lastHeight ? stableFrames + 1 : 0
      lastHeight = height
      node.scrollTop = height

      // Most session switches are synchronous and stabilize within 2 frames;
      // the old 90-frame ceiling was for slow async image loads. Cap at 15
      // frames to minimize the settle-loop racing markdown paint on every switch.
      if (stableFrames >= 2 || ++frame > 15) {
        void scrollToBottom('instant')

        return
      }

      rafId = requestAnimationFrame(settle)
    }

    let rafId = requestAnimationFrame(settle)

    return () => cancelAnimationFrame(rafId)
  }, [reduceMotion, scrollRef, scrollToBottom, sessionKey, stopScroll])

  // Prepend an older page while preserving the on-screen position. The user is
  // scrolled up (reading history) so the stick-to-bottom lock is escaped and
  // won't fight this manual restore.
  const showEarlier = useCallback(() => {
    const el = scrollRef.current

    restoreFromBottomRef.current = el ? transcriptPrependAnchor(el.scrollHeight, el.scrollTop) : null
    setRenderBudget(budget => budget + RENDER_BUDGET)
  }, [scrollRef])

  // Room changes must retire the old page before the prepend layout effect sees the new
  // transcript. A passive effect runs too late and can apply the old room's anchor once.
  useLayoutEffect(() => {
    historyGenerationRef.current++
    historyBusyRef.current = false
    historyHasMoreRef.current = true
    historyPageRef.current = null
    restoreFromBottomRef.current = null
  }, [loadEarlier, sessionKey])

  useLayoutEffect(() => {
    const el = scrollRef.current
    const page = historyPageRef.current

    if (page && !page.received && transcriptPagePrepended(page.messageIds, messageIds)) {
      page.received = true

      // A server page can cross the in-memory render budget. Expose one render page in the
      // same pre-paint cycle, then restore the reader's anchor after that layout settles.
      if (hiddenCount > 0) {
        setRenderBudget(budget => budget + RENDER_BUDGET)

        return
      }
    }

    if (el && restoreFromBottomRef.current != null) {
      el.scrollTop = transcriptScrollTop(el.scrollHeight, restoreFromBottomRef.current)
      restoreFromBottomRef.current = null
    }

    if (page?.received) {
      historyPageRef.current = null
    }
  }, [hiddenCount, messageIds, scrollRef, renderBudget])

  useEffect(() => {
    const el = scrollRef.current

    if (!el || !loadEarlier || groups.length === 0) {
      return
    }

    let frame = 0

    const atStart = () => {
      frame = 0

      if (
        el.scrollTop > 48 ||
        el.scrollHeight <= el.clientHeight ||
        historyBusyRef.current ||
        !historyHasMoreRef.current
      ) {
        return
      }

      if (hiddenCount > 0) {
        showEarlier()

        return
      }

      historyBusyRef.current = true
      restoreFromBottomRef.current = transcriptPrependAnchor(el.scrollHeight, el.scrollTop)
      const generation = historyGenerationRef.current
      const pending = { messageIds: new Set(messageIds), received: false }
      historyPageRef.current = pending

      void loadEarlier()
        .then(hasMore => {
          if (historyGenerationRef.current === generation) {
            historyHasMoreRef.current = hasMore
          }
        })
        // Offline and homeserver failures are retryable; only an explicit page result can
        // prove that this room has no earlier history.
        .catch(() => {})
        .finally(() => {
          if (historyGenerationRef.current === generation) {
            historyBusyRef.current = false
          }

          // A page containing only filtered relation/state events changes no transcript DOM.
          // Retire its anchor after React has had a bounded chance to receive the snapshot.
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              if (
                historyGenerationRef.current === generation &&
                historyPageRef.current === pending &&
                !pending.received
              ) {
                historyPageRef.current = null
                restoreFromBottomRef.current = null
              }
            })
          )
        })
    }

    const onScroll = () => {
      if (!frame) {
        frame = requestAnimationFrame(atStart)
      }
    }

    el.addEventListener('scroll', onScroll, { passive: true })

    return () => {
      el.removeEventListener('scroll', onScroll)
      cancelAnimationFrame(frame)
    }
  }, [groups.length, hiddenCount, loadEarlier, messageIds, scrollRef, showEarlier])

  return (
    <div
      className="relative min-h-0 max-w-full overflow-hidden contain-[layout_paint]"
      style={
        {
          height: clampToComposer ? 'var(--thread-viewport-height)' : '100%',
          ...(secondaryWindow ? { '--sticky-human-top': secondaryTitlebarGap } : {})
        } as CSSProperties
      }
    >
      {secondaryWindow && (
        // Secondary windows hide the titlebar chrome, so the scroller runs to
        // the window's top edge and streamed text slides up under the OS
        // traffic lights. Content padding alone scrolls away with the text — a
        // fixed opaque strip (the titlebar's drag region) masks anything behind
        // it and keeps the window draggable, matching the main window's header.
        <div
          aria-hidden="true"
          className="absolute inset-x-0 top-0 z-10 h-(--titlebar-height) bg-background [-webkit-app-region:drag]"
        />
      )}
      <div
        aria-live="polite"
        aria-relevant="additions"
        className="size-full overflow-x-hidden overflow-y-auto overscroll-contain"
        data-following={isAtBottom ? 'true' : 'false'}
        data-slot="aui_thread-viewport"
        ref={scrollRef as React.RefCallback<HTMLDivElement>}
        role="log"
      >
        {renderEmpty ? (
          <div
            className="mx-auto grid h-full w-full max-w-(--composer-width) grid-rows-[minmax(0,1fr)_auto] min-w-0 gap-(--conversation-turn-gap) px-6 py-8"
            data-slot="aui_thread-content"
            style={dockClearance ? { paddingBottom: 'calc(2rem + var(--atum-dock-height, 0px))' } : undefined}
          >
            {emptyPlaceholder}
          </div>
        ) : (
          <div
            className={cn('mx-auto flex w-full max-w-(--composer-width) min-w-0 flex-col px-6', threadContentTopPad)}
            data-slot="aui_thread-content"
            ref={contentRef as React.RefCallback<HTMLDivElement>}
          >
            {leading && hiddenCount === 0 && (
              <div className="pb-(--conversation-turn-gap)" data-slot="aui_thread-leading">
                {leading}
              </div>
            )}
            {hiddenCount > 0 && (
              <button
                className="mx-auto mb-(--conversation-turn-gap) rounded-full border border-border/65 bg-(--composer-fill) px-3 py-1 text-xs text-muted-foreground hover:text-foreground"
                onClick={showEarlier}
                type="button"
              >
                {t.assistant.thread.showEarlier}
              </button>
            )}
            {visibleGroups.map((group, indexInVisible) => (
              // content-visibility:auto — off-screen turns skip style recalc,
              // layout, and paint. On a long transcript this is what keeps
              // UNRELATED UI fast: any dialog/popover mount (Radix Presence
              // reads getComputedStyle) forces a whole-document style recalc,
              // measured ~650-730ms per open on a 1300-message session and
              // ~100-200ms with this on. contain-intrinsic-size keeps a
              // placeholder height for never-rendered turns (auto: remembered
              // real size once rendered), so scrollbar/anchoring stay stable.
              // Sticky human bubbles are unaffected — their turn is rendered
              // whenever any part of it intersects the viewport.
              //
              // The live tail (newest turns) is exempt: virtualizing a turn
              // whose final size hasn't been remembered yet snaps it to a stale
              // height when it scrolls off, drifting stick-to-bottom up over old
              // turns. See isVirtualizedGroup.
              <div
                className={cn(
                  'flex min-w-0 flex-col gap-(--conversation-turn-gap) pb-(--conversation-turn-gap)',
                  isVirtualizedGroup(indexInVisible, visibleGroups.length) &&
                    '[contain-intrinsic-size:auto_37.5rem] [content-visibility:auto]'
                )}
                key={group.id}
              >
                <MessageRenderBoundary resetKey={messageSignature}>
                  {group.kind === 'turn' ? (
                    <div
                      className="composer-human-ai-pair-container relative flex min-w-0 flex-col gap-(--conversation-turn-gap)"
                      data-slot="aui_turn-pair"
                    >
                      {group.indices.map(index => (
                        <ThreadPrimitive.MessageByIndex components={components} index={index} key={index} />
                      ))}
                    </div>
                  ) : (
                    <ThreadPrimitive.MessageByIndex components={components} index={group.index} />
                  )}
                </MessageRenderBoundary>
              </div>
            ))}
            {loadingIndicator}
            {clampToComposer && (
              <div
                aria-hidden="true"
                className="shrink-0"
                data-slot="aui_composer-clearance"
                style={{ height: 'var(--thread-last-message-clearance)' }}
              />
            )}
            {dockClearance && (
              <div
                aria-hidden="true"
                className="shrink-0"
                data-slot="aui_dock-clearance"
                style={{ height: 'calc(0.5rem + var(--atum-dock-height, 0px))' }}
              />
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export const ThreadMessageList = memo(ThreadMessageListInner)
