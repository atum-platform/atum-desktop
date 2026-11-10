import { useEffect, useState } from 'react'

import { Checkbox } from '@/components/ui/checkbox'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { Check, ChevronRight, CircleIcon, Cloud, DeviceDesktop, Refresh } from '@/lib/icons'
import { cn } from '@/lib/utils'

import { AGENT_HOMES_CLOUD_ONLY, offeredHomeKinds } from '../../shared/agent-home-cloud-only'
import type {
  MatrixAgentHomeBridge,
  MatrixAgentHomeDestinationView,
  MatrixAgentHomeModelOption,
  MatrixAgentHomePreflightView,
  MatrixAgentHomeView,
  MatrixAgentView
} from '../../shared/matrix'
import { matrixAgentAnswersInCloud } from '../../shared/matrix-agent-actions'
import type { MatrixAgentSourcesBridge } from '../../shared/matrix-agent-sources'

import { agentHomeCopy, agentHomeIssue, agentHomePlace, agentHomeStatus } from './agent-home-copy'
import { openMatrixConnections } from './connections-request'
import { MatrixCanUseList, useMatrixReachMacs } from './mac-reach-rows'
import { matrixHomeModelProvider, ModelPickerPopover, pickerRouteOf } from './model-picker-popover'
import { SettingsTip } from './settings-row'
import { SubscriptionConnectFlow } from './subscriptions'

export interface MatrixAgentHomeRowProps {
  agentPrincipal: string
  agentName?: string
  bridge: MatrixAgentHomeBridge
  /** The platform's answer, when it has one; absent while it is still being read. */
  view?: MatrixAgentHomeView
  /** The assistant card's place row, or the title bar's icon opening the same D1 surface. */
  display?: 'icon' | 'row'
  /**
   * Cloud-only S0: only the cloud is ever offered, and a Mac home shows one quiet line with Move to
   * the cloud. Defaults to the desktop's one switch; only tests pass `false` (the dormant Mac moves).
   */
  cloudOnly?: boolean
  /** The account's Mac list behind "Can use" (U1); the same for every assistant. */
  sources?: MatrixAgentSourcesBridge
}

/** The platform's moment in the owner's own language and time zone ("Oct 25, 2026, 8:14 PM"). */
function checkpointTime(ms: number, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale === 'zh-hant' ? 'zh-Hant' : locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms))
  } catch {
    return new Date(ms).toISOString()
  }
}

const modelKey = (model: Pick<MatrixAgentHomeModelOption, 'connectionRef' | 'model' | 'effort'>) =>
  `${model.connectionRef}|${model.model}|${model.effort}`

/** The model a move to this destination starts with: the first available offer, else the first. */
function modelFor(destination: MatrixAgentHomeDestinationView): MatrixAgentHomeModelOption | undefined {
  return destination.models.find(each => each.available) ?? destination.models[0]
}

function choiceOf(destination: MatrixAgentHomeDestinationView | undefined, key: string | undefined) {
  return destination?.models.find(model => modelKey(model) === key)
}

function placeName(copy: ReturnType<typeof agentHomeCopy>, destination: MatrixAgentHomeDestinationView): string {
  return destination.kind === 'cloud'
    ? copy.cloudPlace
    : destination.thisMac
      ? copy.placeHere(destination.name)
      : copy.place(destination.name)
}

type PlaceKind = 'cloud' | 'mac'

/** The cloud or a Mac, drawn the way every placement surface draws it (execution-machines.tsx). */
function PlaceIcon({ className, kind }: { className?: string; kind?: PlaceKind }) {
  // Never a cloud while the place is unknown: a cloud that turns into a Mac reads as a move.
  const Icon = kind === 'cloud' ? Cloud : kind === 'mac' ? DeviceDesktop : CircleIcon

  return <Icon aria-hidden className={className} strokeWidth={1.7} />
}

type Readiness = 'ready' | 'checking' | 'asleep' | 'unavailable' | 'moving'

/** The state dot: green only when it is ready, the warning glyph colour when it can't be reached. */
const READINESS_DOT: Record<Readiness, string> = {
  ready: 'bg-(--ak-ok)',
  checking: 'bg-(--ak-ink-3)',
  asleep: 'bg-(--ak-ink-3)',
  unavailable: 'bg-(--ak-warn)',
  moving: 'bg-(--ak-ink) motion-safe:animate-pulse'
}

/** A Kit menu row's trailing word ("This Mac", "Offline"). */
const ROW_TAG = 'ms-auto shrink-0 ps-2 [font:var(--ak-t-callout)] text-(--ak-ink-3)'

/**
 * "Lives on": the one place concept on the assistant card (atum.agent-home/2.1 + 2.5). The row
 * stays put while the platform's answer is still on its way — a row that quietly says it is
 * finding out is honest; a row that vanishes is not. It opens a popover, not a side sheet: where
 * it lives now, one row per place the owner can move it to, and at most one short line saying why
 * a move can't run. Choosing a Mac shows that Mac's own models before the move is confirmed; a Mac
 * that is not set up yet is set up as soon as it is chosen, with no separate setup button.
 */
export function MatrixAgentHomeRow({
  agentPrincipal,
  agentName,
  bridge,
  cloudOnly = AGENT_HOMES_CLOUD_ONLY,
  display = 'row',
  sources = window.atumMatrix?.agentSources,
  view
}: MatrixAgentHomeRowProps) {
  const { locale } = useI18n()
  const copy = agentHomeCopy(locale)
  const [open, setOpen] = useState(false)
  const macs = useMatrixReachMacs(open, sources)
  const [shown, setShown] = useState(view)
  const [working, setWorking] = useState<'read' | 'preflight' | 'move' | 'cancel' | 'setup'>()
  const [failure, setFailure] = useState<string>()
  const [asked, setAsked] = useState(false)
  /** The Mac the owner chose for the next move; its models are picked below before moving. */
  const [chosenId, setChosenId] = useState<string>()
  const [selectedModel, setSelectedModel] = useState<string>()
  // The model card's Connect: the same in-place service chooser as the composer.
  const [connecting, setConnecting] = useState(false)
  /** A move that was reviewed and now needs the owner's tick before it may run. */
  const [pending, setPending] = useState<
    { destination: MatrixAgentHomeDestinationView; preflight: MatrixAgentHomePreflightView } | undefined
  >()
  const [acceptedLoss, setAcceptedLoss] = useState(false)

  useEffect(() => setShown(view), [view])
  useEffect(() => setAcceptedLoss(false), [pending?.preflight.preflightId])

  const placement = shown?.placement
  const destinations = placement?.destinations ?? []
  const currentDestination = destinations.find(each => each.id === placement?.current)
  const chosenDestination = destinations.find(each => each.id === chosenId && each.kind === 'mac')
  const chosenModel = choiceOf(chosenDestination, selectedModel)
  const waitingForHome = placement?.waitingForHome === true
  const moving = Boolean(shown?.move || (placement?.progress && !['ready', 'failed'].includes(placement.progress.state)))

  const rowValue = (() => {
    if (placement?.progress) {
      return copy.progress[placement.progress.state](currentDestination?.name || copy.anotherMac)
    }

    if (waitingForHome) {
      return copy.waitingForMac(currentDestination?.name ?? '')
    }

    if (
      placement?.current !== 'cloud' &&
      placement?.reachability !== 'reachable' &&
      (placement?.modelStatus === 'pending' || placement?.modelStatus === 'unavailable')
    ) {
      return copy.waitingForMac(currentDestination?.name ?? '')
    }

    if (shown?.move) {
      return agentHomeStatus(copy, shown.move)
    }

    return shown ? agentHomePlace(copy, shown.lives) : copy.finding
  })()

  const currentPlace = currentDestination
    ? placeName(copy, currentDestination)
    : shown
      ? shown.lives.kind === 'cloud'
        ? copy.cloudPlace
        : copy.place(shown.lives.name)
      : undefined

  // The D1 owner projection is authoritative here. Placement may intentionally refuse a standby
  // lease, so this surface never falls back to the legacy status that called a present Mac offline.
  const readiness: Readiness | undefined = placement
    ? placement.reachability === 'asleep'
      ? 'asleep'
      : placement.reachability === 'offline'
        ? 'unavailable'
        : placement.modelStatus === 'pending'
          ? 'checking'
          : placement.modelStatus === 'unavailable'
            ? 'unavailable'
            : 'ready'
    : undefined
  const pill: Readiness | undefined = moving ? 'moving' : readiness
  const pillLabel = pill
    ? {
        ready: copy.ready,
        checking: copy.readinessChecking,
        asleep: copy.readinessAsleep,
        unavailable: copy.readinessUnavailable,
        moving: copy.moving
      }[pill]
    : undefined
  // Where it answers from right now: the cloud or a Mac. A move in flight still answers from here.
  const currentKind: PlaceKind | undefined = currentDestination?.kind ?? shown?.lives.kind
  const triggerLabel = currentPlace
    ? `${copy.livesOn}: ${currentPlace}${pillLabel ? ` · ${pillLabel}` : ''}`
    : copy.finding

  const refresh = async (keepChosen?: string): Promise<MatrixAgentHomeView | undefined> => {
    setWorking('read')
    setFailure(undefined)

    try {
      const next = await bridge.read(agentPrincipal)

      if (next) {
        setShown(next)

        // A Mac the owner chose stays chosen across the post-set-up refresh, so its models and the
        // button below follow the fresh catalog rather than falling back to the current place.
        if (keepChosen && next.placement?.destinations.some(each => each.id === keepChosen)) {setChosenId(keepChosen)}
      }

      return next
    } catch {
      setFailure(copy.refusals.unavailable)

      return undefined
    } finally {
      setAsked(true)
      setWorking(undefined)
    }
  }

  const onOpen = (next: boolean) => {
    setOpen(next)

    if (next) {
      setPending(undefined)
      setFailure(undefined)
      setChosenId(undefined)
      setSelectedModel(undefined)
      void refresh()
    }
  }

  const refused = (reason?: string) => {
    setFailure((reason ? copy.refusals[reason as keyof typeof copy.refusals] : undefined) ?? copy.issueFallback)
  }

  const move = async (preflight: MatrixAgentHomePreflightView, accept = acceptedLoss) => {
    setWorking('move')
    setFailure(undefined)

    try {
      const result = await bridge.move(agentPrincipal, preflight.preflightId, preflight.checkpointLossRequired && accept)

      if (result.ok) {
        setPending(undefined)
        setChosenId(undefined)
        setSelectedModel(undefined)
        await refresh()
      } else {
        refused(result.reason)
        // A refused one-tap move goes back to the place rows so it can be tried again; the
        // forced-loss review stays up with its tick, because that is the move it belongs to.
        setPending(current => (preflight.checkpointLossRequired ? current : undefined))
        setWorking(undefined)
      }
    } catch {
      setFailure(copy.refusals.unavailable)
      setPending(undefined)
      setWorking(undefined)
    }
  }

  useEffect(() => {
    if (!open || working || pending || (placement && !failure && !shown?.issue)) {return}
    const retry = () => { void refresh(chosenId) }
    const timer = setInterval(retry, 15_000)
    window.addEventListener('online', retry)
    window.addEventListener('focus', retry)
    return () => {
      clearInterval(timer)
      window.removeEventListener('online', retry)
      window.removeEventListener('focus', retry)
    }
  }, [open, working, pending, chosenId, bridge, agentPrincipal, placement, failure, shown?.issue])

  /** The chosen Mac's models change (it was just set up): keep the owner's pick while it exists. */
  const offeredModels = chosenDestination?.models.map(each => `${modelKey(each)}|${each.available}`).join(',')

  useEffect(() => {
    if (!chosenDestination) {
      setSelectedModel(undefined)
      return
    }

    setSelectedModel(previous => {
      if (previous && chosenDestination.models.some(each => modelKey(each) === previous && each.available)) {return previous}

      const next = modelFor(chosenDestination)

      return next ? modelKey(next) : undefined
    })
    setPending(undefined)
  }, [chosenId, offeredModels])

  // No other Mac is offered while the home Mac waits, so a pick made before that could only act on
  // a place the popover no longer lists: it goes back to the place the assistant lives now.
  useEffect(() => {
    if (!waitingForHome) {
      return
    }

    setChosenId(undefined)
    setSelectedModel(undefined)
    setPending(undefined)
  }, [waitingForHome])

  useEffect(() => {
    if (chosenId && placement && !placement.destinations.some(each => each.id === chosenId)) {
      setChosenId(undefined)
      setSelectedModel(undefined)
      setPending(undefined)
    }
  }, [chosenId, placement])

  /**
   * This Mac enrolls for the assistant and publishes the models it can answer with; nothing moves.
   * It runs when the owner chooses this Mac as the destination, so the model list is ready before
   * the move, and again from Review if that first try did not finish.
   */
  const setUpHere = async (target: MatrixAgentHomeDestinationView): Promise<MatrixAgentHomeView | undefined> => {
    if (working) {
      return undefined
    }

    setWorking('setup')
    setFailure(undefined)

    let refused: string | undefined

    try {
      const result = await bridge.prepare(agentPrincipal)

      if (!result.ok) {
        refused = copy.refusals[result.reason ?? 'unavailable'] ?? copy.issueFallback
      }
    } catch {
      refused = copy.refusals.unavailable
    }

    // Read again even after a refusal: the model row and the button must show what the platform
    // holds now, and the same press can be tried again.
    const next = await refresh(target.id)
    const prepared = next?.placement?.destinations.find(each => each.id === target.id)

    if (refused) {
      setFailure(refused)

      return undefined
    }

    // A failed read cannot establish whether the Mac has models. Keep refresh's failure.
    if (!next) {
      return undefined
    }

    if (!prepared?.models.length) {
      setFailure(copy.noModels(target.name || copy.thisMac))
    }

    return next
  }

  /** One tap on a place: review, then move. Only losing work since the checkpoint asks first. */
  const goTo = async (destination: MatrixAgentHomeDestinationView, model = modelFor(destination)) => {
    if (!destination || !model || working || moving) {
      return
    }

    setWorking('preflight')
    setFailure(undefined)
    setPending(undefined)

    try {
      const result = await bridge.preflight(agentPrincipal, destination.id, model)

      if (!result.ok) {
        refused(result.reason)
        setWorking(undefined)

        return
      }

      if (result.checkpointLossRequired) {
        setPending({ destination, preflight: result })
        setWorking(undefined)

        return
      }

      setPending({ destination, preflight: result })
      await move(result, false)
    } catch {
      setFailure(copy.refusals.unavailable)
      setWorking(undefined)
    }
  }

  /** The move the owner confirmed after choosing a Mac and its model. */
  const review = async (destination: MatrixAgentHomeDestinationView) => {
    if (working || moving) {
      return
    }

    setFailure(undefined)

    let target = destination
    let choice = choiceOf(target, selectedModel)

    // The owner never presses "set up": choosing the Mac starts it, and Review finishes it if it
    // did not (a refusal, or the app was busy). A move is never reviewed against a target that is
    // not set up.
    if (target.setUp === 'needed') {
      const next = await setUpHere(target)
      const refreshed = next?.placement?.destinations.find(each => each.id === target.id)

      if (!refreshed) {
        return
      }

      target = refreshed
      const selected = choiceOf(target, selectedModel)
      choice = selected?.available ? selected : modelFor(target)

      if (!choice?.available) {
        setFailure(target.models.length ? copy.refusals.not_ready : copy.noModels(target.name || copy.thisMac))

        return
      }
    }

    if (!choice?.available) {
      return
    }

    await goTo(target, choice)
  }

  /** Choosing a Mac is the choice that starts its set-up: its models are known before the move. */
  const choose = (destination: MatrixAgentHomeDestinationView) => {
    if (working || moving) {
      return
    }

    setChosenId(destination.id)
    setSelectedModel(undefined)
    setPending(undefined)
    setFailure(undefined)

    if (destination.setUp === 'needed') {
      void setUpHere(destination)
    }
  }

  const cancel = async () => {
    if (working) {
      return
    }

    setWorking('cancel')
    setFailure(undefined)

    try {
      const result = await bridge.cancel(agentPrincipal)

      if (result.ok) {
        await refresh()
      } else {
        setFailure((result.reason ? copy.refusals[result.reason as keyof typeof copy.refusals] : undefined) ?? copy.cancelFailed)
      }
    } catch {
      setFailure(copy.cancelFailed)
    } finally {
      setWorking(undefined)
    }
  }

  const offered = offeredHomeKinds(cloudOnly)
  const visible = destinations.filter(
    each =>
      each.id !== placement?.current &&
      // Cloud-only S0: a Mac is never a place to move to.
      offered.has(each.kind) &&
      // While the assistant's Mac is not answering the owner waits for it, or moves to the cloud:
      // no other Mac is offered.
      !(waitingForHome && each.kind === 'mac')
  )
  const status = failure ?? (shown?.issue ? agentHomeIssue(copy, shown.issue, moving) : undefined)
  const livesOnMac = currentKind === 'mac'
  // One short line under the place, never more: the Mac it waits for, else (cloud-only) the quiet
  // note on a Mac home, else the D1 promise. A cloud home under cloud-only needs no line at all.
  const line = waitingForHome
    ? copy.waitingForCurrentMac(currentDestination?.name || copy.anotherMac)
    : shown && !moving
      ? cloudOnly
        ? livesOnMac
          ? copy.macHomeNote
          : undefined
        : copy.homeLine
      : undefined
  const progressLine = placement?.progress
    ? copy.progress[placement.progress.state](currentDestination?.name ?? copy.anotherMac)
    : shown?.move
      ? agentHomeStatus(copy, shown.move)
      : undefined

  return (
    <Popover onOpenChange={onOpen} open={open}>
      {display === 'row' ? (
        <PopoverTrigger asChild>
          <button
            className="atum-settings-row atum-settings-link"
            data-agent-home-row={moving ? 'moving' : shown ? 'settled' : 'pending'}
            data-assistant-card-home
            type="button"
          >
            <span className="atum-settings-row-title shrink-0">{copy.rowTitle}</span>
            <span aria-live="polite" className="atum-card-row-value ms-auto" data-agent-home-value role="status" title={rowValue}>
              {rowValue}
            </span>
            <ChevronRight aria-hidden className="atum-settings-chevron" />
          </button>
        </PopoverTrigger>
      ) : (
        <Tip label={triggerLabel}>
          <PopoverTrigger asChild>
            {/* The title bar says where the assistant answers from right now: a cloud or a Mac. */}
            <button
              aria-label={triggerLabel}
              className={cn(
                'atum-icon-btn relative size-7',
                (readiness === 'asleep' || readiness === 'unavailable') && 'text-(--atum-ink-ghost)'
              )}
              data-agent-home-place={currentKind ?? 'unknown'}
              data-agent-home-readiness-state={pill}
              data-matrix-agent-home
              type="button"
            >
              <PlaceIcon className="size-4" kind={currentKind} />
              {moving ? (
                <span
                  aria-hidden
                  className="absolute top-1 right-1 size-1.5 rounded-full bg-current motion-safe:animate-pulse"
                  data-agent-home-moving
                />
              ) : null}
            </button>
          </PopoverTrigger>
        </Tip>
      )}
      <PopoverContent
        align="end"
        aria-label={copy.title}
        className="ak-glass ak-menu z-[140] w-80 max-w-[calc(100vw-1rem)] border-0 bg-transparent p-1.5"
        data-agent-home-popover
        sideOffset={8}
      >
        <div className="ak-menu-label">{copy.livesWhere}</div>
        <div className="flex items-start gap-2.5 px-2.5 pt-1 pb-2" data-agent-home-here>
          <span
            aria-hidden
            className="mt-px grid size-8 shrink-0 place-items-center rounded-full bg-(--ak-fill-quiet) text-(--ak-ink)"
          >
            <PlaceIcon className="size-[18px]" kind={currentKind} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <p className="min-w-0 flex-1 truncate [font:var(--ak-t-body-strong)] text-(--ak-ink)" data-agent-home-current>
                {currentPlace ?? (asked ? copy.unknownPlace : copy.finding)}
              </p>
              {pill && pillLabel ? (
                <span
                  className="ak-badge ak-badge--quiet inline-flex shrink-0 items-center gap-1.5 ps-2 pe-2"
                  data-agent-home-pill={pill}
                >
                  <span aria-hidden className={cn('size-1.5 rounded-full', READINESS_DOT[pill])} />
                  <span data-agent-home-readiness role="status">
                    {pillLabel}
                  </span>
                </span>
              ) : null}
            </div>
            {line ? (
              <p
                className="mt-0.5 [font:var(--ak-t-callout)] text-(--ak-ink-3)"
                data-agent-home-line
                data-agent-home-mac-note={line === copy.macHomeNote || undefined}
                data-agent-home-waiting={waitingForHome || undefined}
                role={waitingForHome ? 'status' : undefined}
              >
                {line}
              </p>
            ) : null}
          </div>
        </div>

        {macs ? (
          <MatrixCanUseList
            emptyLabel={copy.noMac}
            label={copy.canUse}
            macs={macs}
            onFix={() => {
              setOpen(false)
              openMatrixConnections()
            }}
          />
        ) : null}

        {moving ? (
          <>
            <div className="ak-menu-sep" />
            <p
              className="flex items-center gap-2 px-2.5 py-1.5 [font:var(--ak-t-callout)] text-(--ak-ink-2)"
              data-agent-home-progress
              role="status"
            >
              <span aria-hidden className="ak-spinner" />
              {progressLine}
            </p>
            {placement?.progress?.state !== 'waiting_for_destination' && placement?.progress?.state !== 'ready' ? (
              <button
                className="ak-menu-item w-full text-left disabled:opacity-45"
                disabled={Boolean(working)}
                onClick={() => void cancel()}
                type="button"
              >
                {working === 'cancel' ? copy.cancelling : copy.cancel}
              </button>
            ) : null}
          </>
        ) : placement ? (
          // Cloud-only S0: a cloud home has nowhere to go, so the popover is just where it lives.
          !cloudOnly || visible.length > 0 || pending ? (
          <div data-agent-home-move-options>
            <div className="ak-menu-sep" />
            {(visible.length > 0 || pending) && !cloudOnly ? <div className="ak-menu-label">{copy.moveSection}</div> : null}
            {visible.length === 0 && !pending && !cloudOnly ? (
              <p className="px-2.5 py-1.5 [font:var(--ak-t-callout)] text-(--ak-ink-3)" data-agent-home-no-place>
                {copy.noOtherMac}
              </p>
            ) : null}
            {visible.map(destination => {
              const mac = destination.kind === 'mac'
              const chosen = mac && destination.id === chosenId
              const label =
                destination.kind === 'cloud'
                  ? copy.moveToCloud
                  : destination.thisMac
                    ? copy.moveHere(destination.name)
                    : copy.moveTo(destination.name)
              // A Mac that is not set up is still a real choice: choosing it starts the set-up.
              const unavailable = destination.eligibility !== 'ready' && destination.setUp === undefined
              const tag = unavailable
                ? (destination.reason ? copy.unavailableReasons[destination.reason] : undefined) ?? copy.unavailableFallback
                : destination.thisMac
                  ? copy.thisMac
                  : undefined

              return (
                <button
                  aria-label={label}
                  aria-pressed={mac ? chosen : undefined}
                  className={cn(
                    'ak-menu-item w-full text-left disabled:opacity-45 disabled:hover:bg-transparent',
                    chosen && 'bg-(--ak-fill-selected)'
                  )}
                  data-agent-home-chosen={chosen ? true : undefined}
                  data-agent-home-destination={destination.id}
                  data-agent-home-unavailable={unavailable ? (destination.reason ?? true) : undefined}
                  data-current={chosen ? 'true' : undefined}
                  disabled={Boolean(working) || moving || unavailable}
                  key={destination.id}
                  onClick={() => (mac ? choose(destination) : void goTo(destination))}
                  type="button"
                >
                  <PlaceIcon className="size-4 shrink-0 text-(--ak-ink-2)" kind={destination.kind} />
                  <span className="min-w-0 flex-1 truncate">
                    {/* Cloud-only S0: the one action reads as itself, "Move to the cloud". */}
                    {destination.kind === 'cloud' ? (cloudOnly ? copy.moveToCloud : copy.cloudPlace) : copy.place(destination.name)}
                  </span>
                  {chosen ? (
                    <Check aria-hidden className="size-4 shrink-0 text-(--ak-ink)" />
                  ) : tag ? (
                    <span className={ROW_TAG} data-agent-home-tag>
                      {tag}
                    </span>
                  ) : null}
                </button>
              )
            })}

            {chosenDestination ? (
              <section className="grid gap-2 px-2.5 pt-2 pb-1.5" data-agent-home-model-choice>
                <div className="grid gap-1 [font:var(--ak-t-caption)] font-semibold text-(--ak-ink-3)" data-agent-home-model>
                  {copy.model}
                  <ModelPickerPopover
                    contentClassName="z-[160]"
                    currentId={selectedModel}
                    disabled={Boolean(working) || moving || chosenDestination.models.length === 0}
                    label={copy.model}
                    onChoose={route => {
                      setSelectedModel(route.id)
                      setPending(undefined)
                      setFailure(undefined)
                    }}
                    onConnect={window.atumMatrix?.subscriptions?.startChatGpt ? () => setConnecting(true) : undefined}
                    placeholder={copy.model}
                    routes={chosenDestination.models.map(each => {
                      const provider = matrixHomeModelProvider(each)

                      return pickerRouteOf({
                        id: modelKey(each),
                        provider: provider.id,
                        providerLabel: provider.label,
                        model: each.model,
                        name: each.modelLabel,
                        ready: each.available
                      })
                    })}
                    scope="agent-home-move"
                    triggerClassName="w-full"
                  />
                </div>

                {working === 'setup' ? (
                  <p className="[font:var(--ak-t-callout)] text-(--ak-ink-3)" data-agent-home-setting-up role="status">
                    {copy.preparing(chosenDestination.name || copy.thisMac)}
                  </p>
                ) : null}

                {!failure && working !== 'setup' && chosenDestination.models.length === 0 ? (
                  <p className="[font:var(--ak-t-callout)] text-(--ak-ink-3)" data-agent-home-no-models>
                    {copy.noModels(chosenDestination.name || copy.thisMac)}
                  </p>
                ) : null}

                <button
                  className="ak-btn ak-btn--primary ak-btn--sm w-full"
                  disabled={
                    Boolean(working) ||
                    moving ||
                    (!chosenModel?.available && chosenDestination.setUp !== 'needed')
                  }
                  onClick={() => void review(chosenDestination)}
                  type="button"
                >
                  {working === 'preflight' ? copy.moving : copy.reviewMove}
                </button>
              </section>
            ) : null}

            {pending ? (
              <section
                className="grid gap-2 px-2.5 pt-2 pb-1.5 [font:var(--ak-t-callout)] text-(--ak-ink-2)"
                data-agent-home-losses
              >
                <p>
                  {pending.preflight.featureLosses.length ? copy.actualLosses : copy.noLosses}
                  {pending.preflight.featureLosses.length > 0 && (
                    <SettingsTip
                      label={pending.preflight.featureLosses.map(loss => copy.losses[loss] ?? loss).join(' · ')}
                    />
                  )}
                </p>
                {pending.preflight.checkpointLossRequired ? (
                  <div data-agent-home-checkpoint-loss>
                    <label className="flex items-start gap-2 [font:var(--ak-t-body)] text-(--ak-ink)">
                      <Checkbox
                        aria-label={copy.acceptCheckpointLoss}
                        checked={acceptedLoss}
                        className="mt-0.5 border-(--atum-line-strong)"
                        data-agent-home-accept-checkpoint-loss
                        disabled={Boolean(working)}
                        onCheckedChange={value => setAcceptedLoss(value === true)}
                      />
                      <span>
                        {copy.acceptCheckpointLoss}
                        {pending.preflight.lastCheckpointAtPlatform !== null && (
                          <SettingsTip
                            label={copy.lastCheckpoint(
                              checkpointTime(pending.preflight.lastCheckpointAtPlatform, locale)
                            )}
                          />
                        )}
                      </span>
                    </label>
                    <button
                      className="ak-btn ak-btn--primary ak-btn--sm mt-2 w-full"
                      disabled={Boolean(working) || !acceptedLoss}
                      onClick={() => void move(pending.preflight)}
                      type="button"
                    >
                      {working === 'move' ? copy.moving : `${copy.move}${agentName ? ` ${agentName}` : ''}`}
                    </button>
                  </div>
                ) : null}
              </section>
            ) : null}
          </div>
          ) : null
        ) : shown?.targets.length ? (
          <div data-agent-home-legacy-targets>
            <div className="ak-menu-sep" />
            <div className="ak-menu-label">{copy.moveSection}</div>
            <p className="px-2.5 pt-1 pb-1.5 [font:var(--ak-t-callout)] text-(--ak-ink-3)" data-agent-home-owner-route-off role="status">
              {shown.issue === 'platform_unsupported' ? copy.refusals.unsupported : copy.refusals.unavailable}
            </p>
            <button className="ak-menu-item w-full text-left" disabled={Boolean(working)}
              onClick={() => void refresh()} type="button">{copy.retryRead}</button>
          </div>
        ) : (
          <>
            <div className="ak-menu-sep" />
            <p className="px-2.5 py-1.5 [font:var(--ak-t-callout)] text-(--ak-ink-3)" data-agent-home-legacy>
              {asked ? copy.unknownPlace : copy.finding}
            </p>
            <button
              className="ak-menu-item w-full text-left disabled:opacity-45"
              disabled={Boolean(working)}
              onClick={() => void refresh()}
              type="button"
            >
              <Refresh aria-hidden className="size-4 shrink-0 text-(--ak-ink-2)" />
              <span className="min-w-0 flex-1 truncate">{working === 'read' ? copy.finding : copy.retryRead}</span>
            </button>
          </>
        )}

        {status && (placement || !shown?.targets.length) ? (
          <>
            <div className="ak-menu-sep" />
            <p
              className={cn(
                'px-2.5 py-1.5 [font:var(--ak-t-callout)]',
                failure ? 'text-(--ak-danger)' : 'text-(--ak-ink-3)'
              )}
              data-agent-home-failure={failure ? true : undefined}
              role={failure ? 'alert' : 'status'}
            >
              {status}
            </p>
          </>
        ) : null}
      </PopoverContent>
      {connecting && (
        <SubscriptionConnectFlow
          bridge={window.atumMatrix?.subscriptions}
          onClose={() => setConnecting(false)}
          onConnected={() => undefined}
        />
      )}
    </Popover>
  )
}

/**
 * The same "Lives on" row for an assistant without an authoritative home (U1 §2): where it
 * answers, read-only, and the Macs it can use. Every card shows the same row; nothing here moves it.
 */
export function MatrixAgentPlaceRow({
  agent,
  sources = window.atumMatrix?.agentSources
}: {
  agent: Pick<MatrixAgentView, 'answering' | 'macRole'>
  sources?: MatrixAgentSourcesBridge
}) {
  const { locale } = useI18n()
  const copy = agentHomeCopy(locale)
  const [open, setOpen] = useState(false)
  const macs = useMatrixReachMacs(open, sources)
  const cloud = matrixAgentAnswersInCloud(agent)
  const place = cloud ? copy.cloudPlace : copy.thisMac

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <button className="atum-settings-row atum-settings-link" data-agent-home-row="read-only" data-assistant-card-place type="button">
          <span className="atum-settings-row-title shrink-0">{copy.rowTitle}</span>
          <span className="atum-card-row-value ms-auto" data-agent-home-value title={place}>
            {place}
          </span>
          <ChevronRight aria-hidden className="atum-settings-chevron" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label={copy.title}
        className="ak-glass ak-menu z-[140] w-80 max-w-[calc(100vw-1rem)] border-0 bg-transparent p-1.5"
        data-agent-home-popover
        sideOffset={8}
      >
        <div className="ak-menu-label">{copy.livesWhere}</div>
        <div className="flex items-center gap-2.5 px-2.5 pt-1 pb-2" data-agent-home-here>
          <span
            aria-hidden
            className="grid size-8 shrink-0 place-items-center rounded-full bg-(--ak-fill-quiet) text-(--ak-ink)"
          >
            <PlaceIcon className="size-[18px]" kind={cloud ? 'cloud' : 'mac'} />
          </span>
          <p className="min-w-0 flex-1 truncate [font:var(--ak-t-body-strong)] text-(--ak-ink)" data-agent-home-current>
            {place}
          </p>
        </div>
        {macs ? (
          <MatrixCanUseList
            emptyLabel={copy.noMac}
            label={copy.canUse}
            macs={macs}
            onFix={() => {
              setOpen(false)
              openMatrixConnections()
            }}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
