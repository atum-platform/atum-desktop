import { type ReactNode, useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { ChevronDown, Refresh, Spinner } from '@/lib/icons'
import { cn } from '@/lib/utils'

import { AGENT_HOMES_CLOUD_ONLY } from '../../shared/agent-home-cloud-only'
import type {
  MatrixAgentHomeBridge,
  MatrixAgentHomeModelOption,
  MatrixAgentHomeView,
  MatrixRoom,
  MatrixSubscriptionsBridge
} from '../../shared/matrix'
import { parseMatrixModelCapabilities } from '../../shared/matrix-model-choice'
import { matrixModelDisplayName } from '../../shared/matrix-model-display-name'
import {
  MATRIX_DEFAULT_EFFORT,
  MATRIX_DEFAULT_MODEL,
  MATRIX_MODEL_LINEUP,
  matrixCloudModelAlias,
  type MatrixCloudModelChoiceView,
  type MatrixConnectedModel,
  matrixConnectedModelEfforts,
  matrixConnectedModelLabel,
  type MatrixConnectedModelProblem,
  matrixConnectedModelProblem,
  type MatrixEffort,
  type MatrixModelAccount,
  type MatrixModelCatalog,
  type MatrixModelId,
  matrixModelName,
  type MatrixModelRoute,
  matrixModelRouteId,
  matrixRouteIdOfChoice,
  parseMatrixEffort
} from '../../shared/matrix-models'
import {
  MATRIX_SHELF_PROVIDER,
  type MatrixShelfModelId,
  type MatrixShelfModelView,
  parseMatrixShelfModel
} from '../../shared/matrix-shelf-models'
import {
  type MatrixSubscriptionCatalog,
  matrixSubscriptionProviderLabel,
  type MatrixSubscriptionProviderStatus,
  type MatrixSubscriptionsStatus,
  parseMatrixSubscriptionProvider
} from '../../shared/matrix-subscriptions'

import { MatrixModelEffortSlider } from './model-effort-slider'
import { useModelPickerCopy } from './model-picker-copy'
import { type PickerFilterSource } from './model-picker-filter'
import { ModelPickerList, shelfPrice } from './model-picker-list'
import { MODEL_PICKER_CARD, ModelPickerPanel, useModelPickerKeys } from './model-picker-panel'
import { matrixHomeModelProvider as homeProvider } from './model-picker-popover'
import {
  matrixModelEffortReconciliation,
  matrixModelFavoriteToggle,
  type MatrixModelPickerPreferences,
  matrixModelRecentAdd,
  readMatrixModelPickerPreferences,
  writeMatrixModelPickerPreferences
} from './model-picker-preferences'
import {
  type PickerFilter,
  type PickerProvider,
  type PickerRoute,
  pickerSections
} from './model-picker-sections'
import { PICKER_NOTE, PICKER_ROW } from './model-picker-style'
import { SubscriptionConnectFlow } from './subscriptions'

type ConnectedCatalog =
  | { status: 'idle' | 'loading' | 'failed' | 'unavailable' }
  | { status: 'ready'; value: MatrixModelCatalog }

type SubscriptionCatalog =
  | { status: 'idle' | 'loading' | 'failed' }
  | { status: 'ready'; value: MatrixSubscriptionCatalog }

type EffortNotice = { kind: 'reconciled' | 'failed'; level?: MatrixEffort }

/** What a managed pick can name: Atum's line-up anywhere, an OpenRouter shelf model in the cloud. */
type ManagedPick = MatrixModelId | MatrixShelfModelId

/** A pick saved but not yet back from sync: held so the menu doesn't flick back. */
function usePendingPick<T>(saved: T | undefined) {
  const [pending, setPending] = useState<{ value: T; saved: boolean } | null>(null)

  useEffect(() => {
    if (!pending?.saved) {
      return
    }

    if (saved === pending.value) {
      setPending(null)

      return
    }

    // Hold the pick through ordinary sync; if sync stalls, show what the SDK knows.
    const timer = setTimeout(() => setPending(null), 5000)

    return () => clearTimeout(timer)
  }, [pending, saved])

  return [pending, setPending] as const
}

function localStorageOrUndefined(): Storage | undefined {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

function readPreferences(scope: string): MatrixModelPickerPreferences {
  return readMatrixModelPickerPreferences(localStorageOrUndefined(), scope)
}

function savePreferences(scope: string, preferences: MatrixModelPickerPreferences): void {
  writeMatrixModelPickerPreferences(localStorageOrUndefined(), scope, preferences)
}

/** "ChatGPT · GPT-6", or the model alone when the provider's name is the model's own. */
function routeName(route: MatrixModelRoute): string {
  const name = matrixModelDisplayName(route.model, route.name !== route.model ? route.name : undefined)

  return route.providerLabel && route.providerLabel !== name ? `${route.providerLabel} · ${name}` : name
}

/**
 * A shelf row's tooltip: the price in full, a "costs more" note, what the provider keeps (when the
 * offer says), and what the pick changes.
 */
export function shelfTooltip(
  shelf: MatrixShelfModelView,
  words: ReturnType<typeof useModelPickerCopy>,
  locale: string,
  changes: string
): string {
  return [
    shelfPrice(shelf, locale, words.shelfPriceDetail),
    shelf.costly ? words.shelfCostlyDetail : undefined,
    shelf.retention ? words.shelfRetention[shelf.retention] : undefined,
    changes
  ]
    .filter(Boolean)
    .join(' ')
}

function cloudSubscriptionOption(input: {
  model: { id: string; displayName: string; efforts: readonly MatrixEffort[]; defaultEffort: MatrixEffort }
  available: boolean
  source: 'opencode_go' | 'chatgpt_plan'
}): MatrixAgentHomeModelOption {
  const chatgpt = input.source === 'chatgpt_plan'
  return {
    connectionRef: `${input.source}:${input.model.id}`,
    source: input.source,
    providerLabel: chatgpt ? 'ChatGPT' : 'OpenCode Go',
    model: input.model.id,
    modelLabel: input.model.displayName,
    effort: input.model.defaultEffort,
    efforts: [...input.model.efforts],
    available: input.available
  }
}

function homeRouteId(option: MatrixAgentHomeModelOption): string {
  return matrixModelRouteId(homeProvider(option).id, option.model)
}

function sameHomeModel(left: MatrixAgentHomeModelOption | undefined, right: MatrixAgentHomeModelOption | undefined) {
  return Boolean(
    left &&
    right &&
    left.connectionRef === right.connectionRef &&
    left.model === right.model &&
    left.effort === right.effort
  )
}

function defaultPickerSource(input: {
  managed: boolean
  cloud: boolean
  here?: 'cloud' | 'this_mac'
  connected?: MatrixConnectedModel
  home?: MatrixAgentHomeView
  subscription?: 'opencode_go' | 'chatgpt_plan'
  /** The cloud's saved choice is an OpenRouter shelf model. */
  shelf?: boolean
}): string | undefined {
  const current = input.home?.placement?.currentModel

  if (current) {
    return homeProvider(current).id
  }

  if (input.subscription) {
    return input.subscription === 'chatgpt_plan' ? 'openai-codex' : 'opencode-go'
  }

  if (input.shelf && input.managed && input.cloud && input.here !== 'this_mac') {
    return MATRIX_SHELF_PROVIDER.id
  }

  if (input.managed && (!input.cloud || input.here === 'cloud')) {
    return 'atum'
  }

  return input.connected?.provider
}

interface PendingHomePick {
  option: MatrixAgentHomeModelOption
  route: MatrixModelRoute
  saved: boolean
}

/**
 * The model the agent actually uses at its current answering home, as one Atum card. The 2.5
 * placement projection is authoritative when present: only that home's models are listed, exactly
 * one is current, and `agentHome.model` writes the same current home. Older projections keep their
 * existing cloud-choice or native local-route write, but never mix both destinations in one list.
 * Connections still owns sign-in, keys and endpoints; the picker only deep-links there.
 *
 * The card's layout is the owner's 2026-10-26 T3 Code desktop reference: one popover, a narrow
 * Favorites/provider/Connect icon rail, an underline search at the top, and one flat scrolling
 * list with model/provider lines, ⌘1…⌘9 hints and star toggles. There are no group headers or
 * explanatory/settings footers.
 */
export function MatrixModelPicker({
  room,
  disabled,
  fail,
  managed = true,
  cloud = false,
  cloudChoice,
  destinationDefault,
  connected,
  capability,
  preferenceScope,
  local = true,
  here,
  onAdvanced,
  onSubscriptions,
  onBackToAtum,
  agentPrincipal,
  home,
  agentHome,
  subscriptionBridge,
  trigger,
  open: controlledOpen,
  onOpenChange,
  contentClassName,
  side = 'top',
  assistantName,
  cloudOnly = AGENT_HOMES_CLOUD_ONLY
}: {
  room: MatrixRoom
  disabled: boolean
  fail: () => void
  /** Managed room picks do not change an agent's own provider or subscription. */
  managed?: boolean
  /** This agent answers in the cloud: its model is the platform's choice. */
  cloud?: boolean
  /** The platform's offer for this cloud agent; absent falls back to Nguyệt Thực only. */
  cloudChoice?: MatrixCloudModelChoiceView
  /** The default for the destination that answers here (`atum.model-choice/1.3`); a room pick wins. */
  destinationDefault?: MatrixModelId
  /** The model the person connected for this agent, when it answers with one. */
  connected?: MatrixConnectedModel
  /** Descriptor from main’s offer; unknown capabilities offer no levels. */
  capability?: unknown
  /** Local presentation scope: the human account and this device. */
  preferenceScope?: string
  /** The saved policy keeps this Mac a destination, so its connections are selectable too. */
  local?: boolean
  /** Which destination answers here now; a cloud agent standing by answers in the cloud. */
  here?: 'cloud' | 'this_mac'
  /** Opens the room's agent's Connections page. */
  onAdvanced?: () => void
  /** Opens Settings › Advanced › Subscriptions, where account-wide plans are connected. */
  onSubscriptions?: () => void
  /** Switches this agent back to Atum's AI (Settings › Advanced › Use your own model does the same). */
  onBackToAtum?: () => void
  /** Current-home model changes use main's owner-authoritative placement path. */
  agentPrincipal?: string
  /** The current home and its model catalog, when the platform supports atum.agent-home/2.5. */
  home?: MatrixAgentHomeView
  /** A surface that brings its own scoped home bridge (the assistant card's destination rows). */
  agentHome?: MatrixAgentHomeBridge
  /** A surface that reads subscriptions for one host instead of a live room. */
  subscriptionBridge?: MatrixSubscriptionsBridge
  /** A row that opens this picker, replacing the composer's model pill. */
  trigger?: ReactNode
  /** Controlled open state, for a surface whose row owns it. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** Extra classes on the popover card (z-index above a dialog, for the assistant card). */
  contentClassName?: string
  side?: 'top' | 'bottom' | 'left' | 'right'
  /** The assistant's display name, for the plain menu's heading. */
  assistantName?: string
  /** Keeps the retired Mac-answer picker paths testable until their contracts can be removed. */
  cloudOnly?: boolean
}) {
  const { locale, t } = useI18n()
  const copy = t.matrixShell
  const words = useModelPickerCopy()
  const scope = preferenceScope ?? room.id
  const [openState, setOpenState] = useState(false)
  const open = controlledOpen ?? openState
  // What a late result sees: the card is still open (its own line says why), or it is not.
  const shown = useRef(false)
  const content = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const catalogRead = useRef(0)
  const subscriptionRead = useRef(0)
  // A selection continuation belongs to one room/scope/open lifetime. Any lifecycle change
  // retires it; the native write may already have happened, so this only stops stale UI,
  // recents and follow-on effort writes.
  const selection = useRef(0)
  const currentRoom = useRef(room.id)
  const currentScope = useRef(scope)
  const currentEffort = useRef(room.effort)
  currentRoom.current = room.id
  currentScope.current = scope
  currentEffort.current = room.effort

  // The server's current choice for a cloud agent; the room's own record never decides it.
  // A saved OpenRouter shelf model is the cloud's current model as itself.
  const cloudCurrent: ManagedPick | undefined = cloud
    ? (parseMatrixShelfModel(cloudChoice?.current) ?? matrixCloudModelAlias(cloudChoice?.current) ?? destinationDefault)
    : undefined
  // The account-wide OpenCode Go source: the model the cloud runs, its connection state, and
  // the models the connected account serves. A revoked choice never reads as Atum.
  const cloudSubscription = cloud ? cloudChoice?.subscription : undefined
  const cloudSubscriptionState = cloud ? cloudChoice?.subscriptionState : undefined

  const cloudSubscriptionRevoked =
    Boolean(cloudSubscription) && (cloudSubscriptionState === 'revoked' || cloudSubscriptionState === 'disconnected')

  const cloudSubscriptionName = cloudSubscription
    ? cloudSubscriptionRevoked
      ? cloudSubscription.source === 'opencode_go'
        ? words.reconnectOpencode
        : 'ChatGPT'
      : cloudSubscription.displayName
    : undefined

  // Only aliases the server lists as eligible now; with no offer, Nguyệt Thực alone.
  const cloudOffered = cloud
    ? new Set<MatrixModelId>([
        MATRIX_DEFAULT_MODEL,
        ...(cloudChoice?.offered ?? []).flatMap(alias => {
          const model = matrixCloudModelAlias(alias)

          return model ? [model] : []
        })
      ])
    : undefined

  // A cloud Atum pick is held until the snapshot shows it SAVED: the alias the 1.1 row carries
  // under a plan choice is not a saved Atum choice, so it never settles the pick early.
  const [pendingModel, setPendingModel] = usePendingPick<ManagedPick>(
    cloud ? (cloudSubscription ? undefined : cloudCurrent) : (room.model ?? destinationDefault ?? MATRIX_DEFAULT_MODEL)
  )

  const [pendingEffort, setPendingEffort] = usePendingPick<MatrixEffort>(room.effort)
  const [pendingConnected, setPendingConnected] = useState<{ route: MatrixModelRoute; saved: boolean } | null>(null)
  const [pendingCloudSubscription, setPendingCloudSubscription] = useState<{
    route: MatrixModelRoute
    saved: boolean
  } | null>(null)
  const [pendingHome, setPendingHome] = useState<PendingHomePick | null>(null)
  const [retryPick, setRetryPick] = useState<PickerRoute | null>(null)
  const [catalog, setCatalog] = useState<ConnectedCatalog>({ status: 'idle' })
  const [subscriptions, setSubscriptions] = useState<SubscriptionCatalog>({ status: 'idle' })
  const [accountSubscriptions, setAccountSubscriptions] = useState<MatrixSubscriptionsStatus | null>(null)
  const [filterTouched, setFilterTouched] = useState(false)
  // The chooser opened from the rail, with the account state as the card last read it (the card
  // closes first, and a closed card drops its reads).
  const [connecting, setConnecting] = useState<{ providers?: readonly MatrixSubscriptionProviderStatus[] } | null>(
    null
  )
  const [problem, setProblem] = useState<MatrixConnectedModelProblem>()
  const [effortNotice, setEffortNotice] = useState<EffortNotice>()

  const initialSource = defaultPickerSource({
    managed,
    cloud,
    here,
    connected,
    home,
    subscription: cloudSubscriptionState === 'connected' ? cloudSubscription?.source : undefined,
    shelf: Boolean(cloud && parseMatrixShelfModel(cloudChoice?.current))
  })

  const initialSourceRef = useRef(initialSource)
  initialSourceRef.current = initialSource

  const [filter, setFilter] = useState<PickerFilter>({ favoritesOnly: false, source: initialSource })
  const [query, setQuery] = useState('')
  const [preferences, setPreferences] = useState<MatrixModelPickerPreferences>(() => readPreferences(scope))

  // Cloud runs the server's choice, whatever this Mac stored; a pick in flight shows first.
  const managedCurrent: ManagedPick = cloud
    ? (pendingModel?.value ?? cloudCurrent ?? destinationDefault ?? MATRIX_DEFAULT_MODEL)
    : (pendingModel?.value ?? room.model ?? destinationDefault ?? MATRIX_DEFAULT_MODEL)

  const chosenEffort = pendingEffort?.value ?? room.effort
  const placement = home?.placement
  const currentDestination = placement?.destinations.find(destination => destination.id === placement.current)
  const homeBridge = agentHome ?? window.atumMatrix.agentHome
  const subscriptionsService = subscriptionBridge ?? window.atumMatrix.subscriptions
  const homeMode = Boolean(agentPrincipal && placement && currentDestination && homeBridge)
  const currentHomeOption = pendingHome?.option ?? placement?.currentModel
  // A model change in flight (or not yet back from sync) holds every other pick.
  const switching = Boolean(pendingModel || pendingConnected || pendingHome || pendingCloudSubscription)
  const effortSaving = Boolean(pendingEffort && !pendingEffort.saved)

  // One picker means one answering home. A cloud home never exposes a Mac's private catalog,
  // and a Mac home never shows a second cloud selection.
  const macAnswers = homeMode ? currentDestination?.kind === 'mac' : !cloud || here === 'this_mac'
  const cloudSubscriptions = cloud && !macAnswers

  const legacyListable =
    !homeMode &&
    macAnswers &&
    local &&
    Boolean(connected && window.atumMatrix.modelCatalog && window.atumMatrix.selectModelRoute)

  const listable = homeMode || legacyListable

  const readyCatalog = catalog.status === 'ready' ? catalog.value : undefined
  const atumProvider = words.atumProvider
  const atumDefault = destinationDefault ?? MATRIX_DEFAULT_MODEL

  const homeOptions = (() => {
    if (!homeMode || !currentDestination) {
      return [] as MatrixAgentHomeModelOption[]
    }

    const visible = (option: MatrixAgentHomeModelOption) =>
      !(cloudOnly && currentDestination.kind === 'cloud' && option.source.startsWith('own_key:'))
    const options = currentDestination.models.filter(visible)

    if (
      placement?.currentModel &&
      visible(placement.currentModel) &&
      !options.some(option => sameHomeModel(option, placement.currentModel))
    ) {
      options.push(placement.currentModel)
    }

    // A cloud agent's account subscription is not in the agent-home projection (R1 keeps the
    // destination record in atum.model-choice/1.4). Add its current model and every model the
    // connected account serves, so the one picker lists exactly what the cloud can run.
    if (cloud && currentDestination.kind === 'cloud') {
      const known = new Set(options.map(option => option.model))

      if (cloudSubscription && !known.has(cloudSubscription.model)) {
        options.push(
          cloudSubscriptionOption({
            model: {
              id: cloudSubscription.model,
              displayName: cloudSubscription.displayName,
              efforts: [cloudSubscription.effort],
              defaultEffort: cloudSubscription.effort
            },
            available: false,
            source: cloudSubscription.source
          })
        )
        known.add(cloudSubscription.model)
      }

      for (const model of cloudChoice?.subscriptionModels ?? []) {
        if (!known.has(model.id)) {
          options.push(
            cloudSubscriptionOption({
              model,
              available: cloudSubscriptionState === 'connected',
              source: cloudSubscription?.source ?? 'opencode_go'
            })
          )
          known.add(model.id)
        }
      }
    }

    return options
  })()

  const homeRouteFor = (option: MatrixAgentHomeModelOption): MatrixModelRoute => {
    const provider = homeProvider(option)

    return {
      id: homeRouteId(option),
      provider: provider.id,
      model: option.model,
      name: matrixModelDisplayName(option.model, option.modelLabel),
      providerLabel: provider.label,
      accountLabel: provider.label,
      connection:
        option.source === 'chatgpt_plan' || option.source === 'opencode_go'
          ? 'plan'
          : option.source === 'atum'
            ? 'local'
            : 'key',
      target: 'agent_default',
      destination: currentDestination?.kind === 'cloud' ? 'cloud' : 'this_mac',
      efforts: option.efforts.filter(
        (effort): effort is MatrixEffort => effort === 'low' || effort === 'medium' || effort === 'high'
      ),
      current:
        option.source === 'opencode_go' || option.source === 'chatgpt_plan'
          ? cloudSubscription?.model === option.model && !cloudSubscriptionRevoked
          : sameHomeModel(option, currentHomeOption),
      ready:
        option.available &&
        !((option.source === 'opencode_go' || option.source === 'chatgpt_plan') && cloudSubscriptionRevoked)
    }
  }

  const homeOptionByRoute = new Map(homeOptions.map(option => [homeRouteId(option), option]))
  const homeCurrentRouteId = currentHomeOption ? homeRouteId(currentHomeOption) : undefined

  // Atum's line-up is always listed where this Mac answers, also while the assistant uses its own
  // Preserve user-visible identity, state and recovery behavior across connection changes.
  // way back to Atum's AI, never a separate "switch back" step.
  const atumVisible = homeMode
    ? homeOptions.some(option => option.source === 'atum') || currentDestination?.kind === 'cloud'
    : managed
      ? !cloud || !macAnswers
      : macAnswers

  const atumRoutes: PickerRoute[] = atumVisible
    ? MATRIX_MODEL_LINEUP.map(row => {
        const model = row.id

        const homeOption = model
          ? homeOptions.find(option => option.source === 'atum' && option.model === model)
          : undefined

        const available = homeMode
          ? Boolean(homeOption?.available)
          : model !== null && Boolean(!cloud || cloudOffered?.has(model))

        const name = row.version ? `${row.name} ${row.version}` : row.name

        return {
          route: {
            id: homeOption ? homeRouteId(homeOption) : matrixModelRouteId('atum', model ?? 'thai-cuc'),
            provider: 'atum',
            model: model ?? 'thai-cuc',
            name: homeOption?.modelLabel ?? name,
            providerLabel: atumProvider,
            accountLabel: atumProvider,
            connection: 'local',
            target: homeMode || cloud ? 'agent_default' : 'conversation_override',
            destination: homeMode
              ? currentDestination?.kind === 'cloud'
                ? 'cloud'
                : 'this_mac'
              : cloud
                ? 'cloud'
                : 'this_mac',
            efforts: homeOption
              ? homeOption.efforts.filter(
                  (effort): effort is MatrixEffort => effort === 'low' || effort === 'medium' || effort === 'high'
                )
              : [],
            current: homeMode
              ? Boolean(homeOption && sameHomeModel(homeOption, currentHomeOption))
              : model === managedCurrent,
            ready: available
          },
          note: !available || row.tagline === 'flagship' ? 'soon' : row.tagline === 'everyday' ? 'default' : undefined,
          tagline: row.tagline,
          disabled: !available,
          ...(available && model === atumDefault ? { badges: ['default' as const] } : {})
        }
      })
    : []

  // Atum-funded OpenRouter models (owner 2026-11-09): the cloud's own offer, under their own rail.
  // Only rows the platform lists as eligible arrive here, so with no active shelf row there is no
  // OpenRouter rail at all. A pick takes the same path as Atum's line-up for this home.
  const shelfRoutes: PickerRoute[] = homeMode
    ? currentDestination?.kind === 'cloud'
      ? homeOptions.flatMap(option => {
          if (option.source !== 'atum' || !option.shelf) {
            return []
          }

          const route = homeRouteFor(option)

          return [{ route, shelf: option.shelf, ...(route.ready ? {} : { disabled: true }) }]
        })
      : []
    : managed && cloud && !macAnswers
      ? (cloudChoice?.shelf ?? []).map(shelf => ({
          route: {
            id: matrixModelRouteId(MATRIX_SHELF_PROVIDER.id, shelf.alias),
            provider: MATRIX_SHELF_PROVIDER.id,
            model: shelf.alias,
            name: shelf.name,
            providerLabel: MATRIX_SHELF_PROVIDER.label,
            accountLabel: MATRIX_SHELF_PROVIDER.label,
            connection: 'local' as const,
            target: 'agent_default' as const,
            destination: 'cloud' as const,
            efforts: [...shelf.efforts],
            current: shelf.alias === managedCurrent,
            ready: true
          },
          shelf
        }))
      : []

  const shelfById = new Map(shelfRoutes.flatMap(({ route, shelf }) => (shelf ? [[route.id, shelf] as const] : [])))

  // The chip's name for a shelf model the offer no longer lists is its alias, never Atum's.
  const managedName = (model: ManagedPick) =>
    parseMatrixShelfModel(model)
      ? (shelfRoutes.find(({ route }) => route.model === model)?.route.name ?? model)
      : matrixModelName(model as MatrixModelId)

  const localRows = legacyListable
  // The connected model is still this destination's model when this build cannot read the
  // native list: the card keeps its name and released effort fallback, as before.
  const localMode = !homeMode && macAnswers && (!managed || legacyListable)

  const connectedRoutes: PickerRoute[] = homeMode
    ? homeOptions
        // Cloud subscription choices come from the account status below. Keeping the stale
        // agent-home projection too creates a disabled look-alike row when a relay is off.
        .filter(
          option =>
            option.source !== 'atum' &&
            !(cloudSubscriptions && (option.source === 'chatgpt_plan' || option.source === 'opencode_go'))
        )
        .map(option => {
          const route = homeRouteFor(option)

          return { route, disabled: !route.ready }
        })
    : legacyListable
      ? (readyCatalog?.routes ?? []).map(route => ({ route, disabled: !route.ready }))
      : []

  const readyAccounts: MatrixModelAccount[] = legacyListable
    ? (readyCatalog?.accounts ?? []).filter(account => account.ready && account.models > 0)
    : []

  const disconnectedAccounts: MatrixModelAccount[] = legacyListable
    ? (readyCatalog?.accounts ?? []).filter(
        account => !account.ready && (account.models > 0 || account.connection === 'plan')
      )
    : []

  const providerAccounts = [...readyAccounts, ...disconnectedAccounts].filter(
    (each, index, accounts) => accounts.findIndex(candidate => candidate.id === each.id) === index
  )

  const sectionProviders: PickerProvider[] = connectedRoutes
    .map(({ route }) => ({ id: route.provider, label: route.providerLabel }))
    .filter((provider, index, providers) => providers.findIndex(candidate => candidate.id === provider.id) === index)

  const accountLabel = (each: MatrixModelAccount) =>
    each.connection === 'plan'
      ? words.planAccount(each.providerLabel)
      : each.connection === 'key'
        ? `${each.providerLabel} · ${words.keyAccount}`
        : each.accountLabel

  const routeSubtitle = (route: MatrixModelRoute, withDestination = true) => {
    const account =
      route.connection === 'plan'
        ? words.planAccount(route.providerLabel)
        : route.connection === 'key'
          ? words.keyAccount
          : route.accountLabel

    const parts = account && account.includes(route.providerLabel) ? [account] : [route.providerLabel, account]

    if (withDestination && route.destination === 'this_mac') {
      parts.push(words.thisMac)
    }

    return parts.filter(Boolean).join(' · ')
  }

  const subscriptionListable = macAnswers && local && Boolean(subscriptionsService?.catalog)

  // The agent's own catalog may already name a subscription model; the name it carries is a
  // display name only when it differs from the id.
  const catalogModelName = (provider: string, model: string) =>
    readyCatalog?.routes.find(route => route.provider === provider && route.model === model)?.name

  // The account subscriptions: only connected providers list models. A Mac-hosted agent gets
  // one compact connect row for an absent plan, or a single combined row when neither is
  // connected. A cloud agent gets real platform/relay models, or one quiet Mac note while a
  // connected ChatGPT plan has no relay; it never gets Connect rows because Settings owns those.
  const subscriptionValue = subscriptions.status === 'ready' ? subscriptions.value : undefined
  const currentSubscriptionRoute = connected ? matrixRouteIdOfChoice(connected) : readyCatalog?.current

  const subscriptionRoutes: PickerRoute[] =
    subscriptionListable && subscriptionValue
      ? subscriptionValue.providers.flatMap(provider => {
          if (!provider.connected) {
            return []
          }

          const providerLabel = matrixSubscriptionProviderLabel(provider.id)

          return (provider.models ?? []).map(model => {
            const id = matrixModelRouteId(provider.id, model)

            return {
              route: {
                id,
                provider: provider.id,
                model,
                name: matrixModelDisplayName(model, catalogModelName(provider.id, model)),
                providerLabel,
                accountLabel: provider.id === 'openai-codex' ? words.planAccount(providerLabel) : words.keyAccount,
                connection: provider.id === 'openai-codex' ? 'plan' : 'key',
                target: 'agent_default',
                destination: 'this_mac',
                efforts: [],
                current: currentSubscriptionRoute === id,
                ready: true
              },
              subscription: true
            }
          })
        })
      : []

  // A saved ChatGPT sign-in that stopped working (main read the account store): one line and
  // one Reconnect row, never a plain "Connect" that reads as if the plan was never linked.
  const chatgptNeedsSignIn =
    subscriptionListable &&
    subscriptionValue?.providers.some(
      provider => provider.id === 'openai-codex' && !provider.connected && provider.needsSignIn === true
    ) === true

  const cloudProvider = (id: string) =>
    cloudSubscriptions ? accountSubscriptions?.providers.find(provider => provider.id === id) : undefined

  const chatgptProvider = cloudProvider('openai-codex')
  const cloudChatGptConnected = chatgptProvider?.connected === true && chatgptProvider.relay?.state === 'enabled'
  // A plan signed in on this Mac that cloud assistants cannot reach yet: its models stay listed,
  // Preserve user-visible identity, state and recovery behavior across connection changes.
  const cloudChatGptPending =
    cloudSubscriptions &&
    (chatgptProvider?.connected === true || chatgptProvider?.localConnected === true) &&
    chatgptProvider?.relay?.state !== 'enabled'
  const opencodeProvider = cloudProvider('opencode-go')
  const opencodeConnected = opencodeProvider?.connected === true

  const opencodeModels = opencodeProvider
    ? (opencodeProvider.modelDetails ??
      (opencodeProvider.models ?? []).map(model => ({
        id: model,
        displayName: matrixModelDisplayName(model),
        efforts: [] as MatrixEffort[],
        defaultEffort: 'medium' as MatrixEffort
      })))
    : []
  const chatgptModels = chatgptProvider
    ? (chatgptProvider.modelDetails ??
      (chatgptProvider.models ?? []).map(model => ({
        id: model,
        displayName: matrixModelDisplayName(model),
        efforts: ['low', 'medium', 'high'] as MatrixEffort[],
        defaultEffort: 'medium' as MatrixEffort
      })))
    : []

  const cloudSubscriptionRoutes: PickerRoute[] = cloudSubscriptions
    ? [
        // ChatGPT plan models are served by the selected owner Mac (R2).
        ...(cloudChatGptConnected || cloudChatGptPending
          ? chatgptModels.map(model => ({
              route: {
                id: matrixModelRouteId('openai-codex', model.id),
                provider: 'openai-codex',
                model: model.id,
                name: model.displayName,
                providerLabel: 'ChatGPT',
                accountLabel: words.planAccount('ChatGPT'),
                connection: 'plan' as const,
                target: 'agent_default' as const,
                destination: 'cloud' as const,
                efforts: [...model.efforts],
                current:
                  cloudSubscription?.source === 'chatgpt_plan' &&
                  cloudSubscription.model === model.id &&
                  !cloudSubscriptionRevoked,
                ready: cloudChatGptConnected
              },
              subscription: true,
              defaultEffort: model.defaultEffort,
              ...(cloudChatGptConnected ? {} : { disabled: true, reason: words.chatgptCloudNotReady })
            }))
          : []),
        // OpenCode Go is account-wide in R1: every served model is a real cloud choice, and the
        // server writes it into atum.model-choice/1.4. A revoked choice shows Reconnect below.
        ...(opencodeConnected
          ? opencodeModels.map(model => ({
              route: {
                id: matrixModelRouteId('opencode-go', model.id),
                provider: 'opencode-go',
                model: model.id,
                name: model.displayName,
                providerLabel: 'OpenCode Go',
                accountLabel: words.planAccount('OpenCode Go'),
                connection: 'plan' as const,
                target: 'agent_default' as const,
                destination: 'cloud' as const,
                efforts: [...model.efforts],
                current:
                  cloudSubscription?.source === 'opencode_go' &&
                  cloudSubscription.model === model.id &&
                  !cloudSubscriptionRevoked,
                ready: true
              },
              subscription: true,
              defaultEffort: model.defaultEffort
            }))
          : [])
      ]
    : []

  // ChatGPT is a provider of its own in every picker: not linked yet is one quiet row that opens
  // the sign-in; a saved sign-in that stopped working is one Reconnect row; a plan the cloud
  // cannot reach yet keeps its models (disabled above) and one row that opens Settings.
  const chatgptRead = cloudSubscriptions ? Boolean(accountSubscriptions) : subscriptionListable && Boolean(subscriptionValue)
  const chatgptLinked = cloudSubscriptions
    ? chatgptProvider?.connected === true || chatgptProvider?.localConnected === true
    : subscriptionValue?.providers.some(provider => provider.id === 'openai-codex' && provider.connected) === true
  const chatgptSignedOut = cloudSubscriptions
    ? chatgptProvider?.needsSignIn === true && !chatgptLinked
    : chatgptNeedsSignIn
  // One short note in a subscription's own list when it has nothing choosable; the fix is the
  // rail's Connect, never a row here.
  const subscriptionNote: { provider: string; text: string } | undefined =
    subscriptionListable && subscriptions.status === 'failed'
      ? { provider: 'openai-codex', text: words.modelsFailed }
      : chatgptSignedOut
        ? { provider: 'openai-codex', text: words.chatgptSignedOut }
        : cloudChatGptPending && chatgptModels.length === 0
          ? { provider: 'openai-codex', text: words.chatgptCloudNotReady }
          : cloudSubscriptions && cloudSubscriptionRevoked && cloudSubscription?.source === 'opencode_go'
            ? { provider: 'opencode-go', text: words.modelsSignedOut }
            : undefined


  // Favorites first in the rail, then Atum's line-up and every current-home provider (including
  // the subscription sources, so a cloud OpenCode Go model has a rail entry of its own).
  const subscriptionProviders = [
    ...(cloudSubscriptions ? cloudSubscriptionRoutes : subscriptionRoutes).map(({ route }) => ({
      id: route.provider,
      label: route.providerLabel
    })),
    // A provider with a note (signed out, not ready) keeps its rail entry; one never linked has none.
    ...(subscriptionNote
      ? [{ id: subscriptionNote.provider, label: matrixSubscriptionProviderLabel(subscriptionNote.provider === 'openai-codex' ? 'openai-codex' : 'opencode-go') }]
      : [])
  ]
    .filter((provider, index, providers) => providers.findIndex(candidate => candidate.id === provider.id) === index)

  const filterSources: PickerFilterSource[] = [
    ...(atumRoutes.length ? [{ id: 'atum', label: atumProvider, ready: true, atum: true }] : []),
    ...(shelfRoutes.length
      ? [{ ...MATRIX_SHELF_PROVIDER, ready: shelfRoutes.some(({ route }) => route.ready) }]
      : []),
    ...sectionProviders.map(provider => ({ ...provider, ready: true })),
    ...subscriptionProviders.map(provider => ({
      ...provider,
      ready: (cloudSubscriptions ? cloudSubscriptionRoutes : subscriptionRoutes).some(
        ({ route }) => route.provider === provider.id && route.ready
      )
    })),
    ...providerAccounts.map(each => ({
      id: each.id,
      label: each.providerLabel,
      ready: each.ready && each.models > 0
    }))
  ].filter((source, index, sources) => sources.findIndex(candidate => candidate.id === source.id) === index)

  // Exactly one route is current: the current home's projection, or the one legacy destination
  // this picker exposes. Models for another place never enter these arrays. On a cloud agent the
  // Preserve user-visible identity, state and recovery behavior across connection changes.
  // as itself, and an Atum alias the 1.1 row still carries under it is never current. A pick in
  // flight wins over both until the snapshot catches up.
  const atumPickHeld = cloud && Boolean(pendingModel)
  const savedCloudPlan = atumPickHeld ? undefined : cloudSubscription
  // On this Mac an assistant answering with its own connection (a ChatGPT plan route, a key) is
  // not on an Atum model, whatever the room's stored Atum choice says: the chip names the
  // connection, so no Atum row may be checked until an Atum pick is made.
  const answersWithConnection = !homeMode && macAnswers && Boolean(connected) && !pendingModel

  const isCurrent = (route: MatrixModelRoute) =>
    homeMode
      ? route.id === homeCurrentRouteId
      : route.provider === 'atum' || route.provider === MATRIX_SHELF_PROVIDER.id
        ? route.current && !savedCloudPlan && !pendingCloudSubscription && !answersWithConnection
        : pendingCloudSubscription
          ? route.id === pendingCloudSubscription.route.id
          : atumPickHeld
            ? false
            : pendingConnected
              ? route.id === pendingConnected.route.id
              : route.current

  const shownSubscriptionRoutes = cloudSubscriptions ? cloudSubscriptionRoutes : subscriptionRoutes

  // Never a mixed list: with no (or a vanished) provider chosen, the first provider in the rail.
  const shownFilter: PickerFilter =
    filter.favoritesOnly || (filter.source !== undefined && filterSources.some(source => source.id === filter.source))
      ? filter
      : { favoritesOnly: false, ...(filterSources[0] ? { source: filterSources[0].id } : {}) }

  const sections = pickerSections({
    atum: atumRoutes,
    connected: [...shelfRoutes, ...connectedRoutes],
    subscriptions: shownSubscriptionRoutes,
    ...(subscriptionNote ? { subscriptionNote: subscriptionNote.text, subscriptionNoteFor: subscriptionNote.provider } : {}),
    providers: [...(shelfRoutes.length ? [{ ...MATRIX_SHELF_PROVIDER }] : []), ...sectionProviders],
    favorites: preferences.favorites,
    query,
    filter: shownFilter,
    isCurrent
  })

  // Preserve user-visible identity, state and recovery behavior across connection changes.
  // answers now (Atum's by default) and lists only that provider's models until the rail changes.
  const currentProvider = [...atumRoutes, ...shelfRoutes, ...connectedRoutes, ...shownSubscriptionRoutes].find(({ route }) =>
    isCurrent(route)
  )?.route.provider

  useEffect(() => {
    if (filterTouched || !currentProvider) {
      return
    }

    setFilter(previous =>
      previous.favoritesOnly || previous.source === currentProvider
        ? previous
        : { favoritesOnly: false, source: currentProvider }
    )
  }, [currentProvider, filterTouched])

  // The catalog is read (or failed), so what opens by itself can be chosen from what answers.
  const settled = homeMode || !legacyListable || (catalog.status !== 'idle' && catalog.status !== 'loading')

  // The catalog's current row is exact; without one, keep the released profile-descriptor
  // fallback only so an older backend without per-model levels still shows its dial.
  const exactRoute = localRows ? readyCatalog?.routes.find(route => route.current) : undefined
  // While a pick is in flight, show the model being chosen with its own exact levels.
  const effortRoute = pendingConnected?.route ?? exactRoute
  const connectedCapability = parseMatrixModelCapabilities(capability ?? connected?.capability)

  const fallbackCapability =
    localMode && effortRoute
      ? undefined
      : localMode && connectedCapability?.id === connected?.model
        ? connectedCapability
        : localMode && connected && capability === undefined && connected.capability === undefined
          ? { id: connected.model, displayName: connected.model, efforts: matrixConnectedModelEfforts(connected) }
          : undefined

  const offered = localMode
    ? effortRoute
      ? { id: effortRoute.model, displayName: effortRoute.name, efforts: effortRoute.efforts }
      : fallbackCapability
    : undefined

  const efforts = parseMatrixModelCapabilities(offered)?.efforts ?? []

  const effortIssue =
    localMode && exactRoute ? matrixModelEffortReconciliation(exactRoute.efforts, chosenEffort) : { supported: true }

  const displayRoute = localRows ? (pendingConnected?.route ?? exactRoute) : undefined

  const homeDisplayRoute = homeMode
    ? (pendingHome?.route ?? [...atumRoutes, ...shelfRoutes, ...connectedRoutes].find(({ route }) => isCurrent(route))?.route)
    : undefined

  const connectedName = displayRoute
    ? routeName(displayRoute)
    : connected
      ? matrixConnectedModelLabel(connected)
      : undefined

  // The chip names what actually answers here; a cloud agent standing by keeps the cloud's name.
  const connectedLabel = connected ? matrixConnectedModelLabel(connected) : undefined
  // An Atum pick in flight names Atum on the chip, exactly as the card's check does.
  const connectedHere = !homeMode && macAnswers && Boolean(connectedLabel) && !pendingModel

  // The chip and the card's check read the same saved choice (a pick in flight first).
  const shownPlanName = pendingCloudSubscription
    ? pendingCloudSubscription.route.name
    : savedCloudPlan
      ? cloudSubscriptionName
      : undefined

  const name = homeDisplayRoute
    ? homeDisplayRoute.name
    : shownPlanName
      ? shownPlanName
      : connectedHere
        ? pendingConnected?.route
          ? routeName(pendingConnected.route)
          : (connectedLabel ?? copy.modelPicker)
        : managed || pendingModel
          ? managedName(managedCurrent)
          : (connectedName ?? copy.modelPicker)

  // Never name a saved level the model on the chip does not advertise.
  const namedEffort = chosenEffort && efforts.includes(chosenEffort) ? chosenEffort : undefined

  const label =
    connectedHere && namedEffort && namedEffort !== MATRIX_DEFAULT_EFFORT
      ? `${name} · ${words.efforts[namedEffort]}`
      : name

  const displayName =
    homeDisplayRoute?.name ??
    shownPlanName ??
    (localMode && !pendingModel ? (displayRoute?.name ?? connectedName) : managedName(managedCurrent))

  const displaySubtitle = localMode
    ? displayRoute
      ? routeSubtitle(displayRoute, true)
      : undefined
    : managed && cloud
      ? words.cloud
      : undefined

  const changeOpen = (next: boolean) => {
    selection.current += 1
    setOpenState(next)
    onOpenChange?.(next)
    shown.current = next

    if (next) {
      setProblem(undefined)
      setEffortNotice(undefined)
      setRetryPick(null)
      loadCatalog()

      if (cloudSubscriptions) {
        void loadAccountSubscriptions()
      } else {
        void loadSubscriptions()
      }
    } else {
      catalogRead.current += 1
      subscriptionRead.current += 1
      setCatalog({ status: 'idle' })
      setSubscriptions({ status: 'idle' })
      setAccountSubscriptions(null)
      setFilterTouched(false)
      setProblem(undefined)
      setEffortNotice(undefined)
      setPendingConnected(null)
      setPendingCloudSubscription(null)
      setPendingHome(null)
      setPendingModel(null)
      setPendingEffort(null)
      setRetryPick(null)
      setQuery('')
      setFilter({
        favoritesOnly: false,
        source: defaultPickerSource({
          managed,
          cloud,
          here,
          connected,
          home,
          subscription: cloudSubscriptionState === 'connected' ? cloudSubscription?.source : undefined,
          shelf: Boolean(cloud && parseMatrixShelfModel(cloudChoice?.current))
        })
      })
    }
  }

  const loadCatalog = (): Promise<MatrixModelCatalog | undefined> => {
    const listCatalog = window.atumMatrix.modelCatalog

    if (!listCatalog || !legacyListable) {
      return Promise.resolve(undefined)
    }

    const token = ++catalogRead.current
    const roomAtRequest = room.id

    // A list already on screen stays while it is read again, so a pick never blanks the card.
    if (shown.current) {
      setCatalog(previous => (previous.status === 'ready' ? previous : { status: 'loading' }))
    }

    return listCatalog(room.id).then(
      value => {
        if (shown.current && catalogRead.current === token && roomAtRequest === currentRoom.current) {
          setCatalog({ status: 'ready', value })
        }

        return value
      },
      (error: unknown) => {
        if (shown.current && catalogRead.current === token && roomAtRequest === currentRoom.current) {
          setCatalog({
            status: matrixConnectedModelProblem(error) === 'unavailable' ? 'unavailable' : 'failed'
          })
        }

        return undefined
      }
    )
  }

  const loadSubscriptions = (): Promise<MatrixSubscriptionCatalog | undefined> => {
    const catalogOfSubscriptions = subscriptionsService?.catalog

    if (!catalogOfSubscriptions || !subscriptionListable) {
      return Promise.resolve(undefined)
    }

    const token = ++subscriptionRead.current
    const roomAtRequest = room.id

    if (shown.current) {
      setSubscriptions(previous => (previous.status === 'ready' ? previous : { status: 'loading' }))
    }

    return catalogOfSubscriptions(room.id).then(
      value => {
        if (shown.current && subscriptionRead.current === token && roomAtRequest === currentRoom.current) {
          setSubscriptions({ status: 'ready', value })
        }

        return value
      },
      () => {
        if (shown.current && subscriptionRead.current === token && roomAtRequest === currentRoom.current) {
          setSubscriptions({ status: 'failed' })
        }

        return undefined
      }
    )
  }

  const loadAccountSubscriptions = (): Promise<MatrixSubscriptionsStatus | undefined> => {
    const readSubscriptions = subscriptionsService?.status

    if (!readSubscriptions || !cloudSubscriptions) {
      return Promise.resolve(undefined)
    }

    const token = ++subscriptionRead.current
    const roomAtRequest = room.id

    return readSubscriptions().then(
      value => {
        if (shown.current && subscriptionRead.current === token && roomAtRequest === currentRoom.current) {
          setAccountSubscriptions(value)
        }

        return value
      },
      () => {
        if (shown.current && subscriptionRead.current === token && roomAtRequest === currentRoom.current) {
          setAccountSubscriptions(null)
        }

        return undefined
      }
    )
  }

  const rememberRecent = (routeId: string) => {
    setPreferences(previous => {
      const next = matrixModelRecentAdd(previous, routeId)
      savePreferences(scope, next)

      return next
    })
  }

  const toggleFavorite = (routeId: string) => {
    setPreferences(previous => {
      const next = matrixModelFavoriteToggle(previous, routeId)
      savePreferences(scope, next)

      return next
    })
  }

  const beginSelection = () => {
    const generation = ++selection.current
    const roomId = room.id
    const scopeAtStart = currentScope.current

    return {
      current: () =>
        generation === selection.current &&
        roomId === currentRoom.current &&
        scopeAtStart === currentScope.current &&
        shown.current
    }
  }

  const save = (
    change: { model?: ManagedPick; effort?: MatrixEffort },
    undo: () => void,
    done: () => void,
    current: () => boolean,
    refused?: () => void,
    failed: () => void = fail
  ) => {
    void window.atumMatrix
      .command({ kind: 'setModel', roomId: room.id, ...change })
      .then(result => {
        if (!current()) {
          return
        }

        // A cloud choice the server refused (ineligible alias, policy changed): the row goes
        // back to what runs, said by the row itself, never as the chat's failure line.
        if ((result as { status?: unknown } | null)?.status === 'refused') {
          undo()
          refused?.()

          return
        }

        done()
      })
      .catch(() => {
        if (!current()) {
          return
        }

        undo()
        failed()
      })
  }

  const chooseModel = (model: ManagedPick, routeId = matrixModelRouteId('atum', model), refused?: () => void) => {
    // A no-op only when this Atum model is the SAVED choice: under a plan choice the 1.1 alias is
    // not saved, so the click writes (and the write replaces the plan choice).
    if (
      (model === managedCurrent && !savedCloudPlan && !pendingCloudSubscription && !answersWithConnection) ||
      switching ||
      pendingEffort
    ) {
      return
    }

    // An assistant answering with its own connection on this Mac goes back to Atum's AI first, then
    // takes the clicked line-up model: one click. Only the default assistant can be switched from
    // here (main's useAtumModel); for another the write is refused and the card says so in place.
    const backToAtumFirst = answersWithConnection && onBackToAtum ? window.atumMatrix.useAtumModel : undefined
    const refusedHere = answersWithConnection && !backToAtumFirst ? () => setProblem('unavailable') : undefined

    const context = beginSelection()
    setRetryPick(null)
    setPendingModel({ value: model, saved: false })

    // Switching back to Atum's AI changes this assistant's projection, which retires the card's
    // selection generation on purpose. The model the person clicked still belongs to the same
    // room and account scope, so the second write is kept by those, not by the generation.
    const roomAtRequest = room.id
    const scopeAtRequest = scope
    const sameHost = () => currentRoom.current === roomAtRequest && currentScope.current === scopeAtRequest
    const current = backToAtumFirst ? sameHost : context.current

    const write = () =>
      save(
        { model },
        () => setPendingModel(null),
        () => {
          setPendingModel({ value: model, saved: true })
          rememberRecent(routeId)
        },
        current,
        refused,
        refusedHere
      )

    if (!backToAtumFirst) {
      write()

      return
    }

    void backToAtumFirst().then(
      result => {
        if (!sameHost()) {
          return
        }

        if (result.state === 'ready') {
          // The switch may have cleared the in-flight pick with the projection: hold it again.
          setPendingModel({ value: model, saved: false })
          write()

          return
        }

        setPendingModel(null)
        fail()
      },
      () => {
        if (sameHost()) {
          setPendingModel(null)
          fail()
        }
      }
    )
  }

  const chooseEffort = (value: string | MatrixEffort) => {
    const next = parseMatrixEffort(value)

    // A level saved but not yet back from sync may be changed again; one still saving may not.
    if (!next || next === chosenEffort || switching || effortSaving) {
      return
    }

    const context = beginSelection()
    setPendingEffort({ value: next, saved: false })
    save(
      { effort: next },
      () => setPendingEffort(null),
      () => setPendingEffort({ value: next, saved: true }),
      context.current
    )
  }

  const reconcileEffort = async (route: MatrixModelRoute, current: () => boolean) => {
    if (!current()) {
      return
    }

    const reconciliation = matrixModelEffortReconciliation(route.efforts, currentEffort.current)

    if (reconciliation.supported || !reconciliation.suggested) {
      return
    }

    const effort = reconciliation.suggested

    if (!current()) {
      return
    }

    setPendingEffort({ value: effort, saved: false })

    try {
      await window.atumMatrix.command({ kind: 'setModel', roomId: room.id, effort })

      if (!current()) {
        return
      }

      setPendingEffort({ value: effort, saved: true })
      setEffortNotice({ kind: 'reconciled', level: effort })
    } catch {
      if (!current()) {
        return
      }

      setPendingEffort(null)
      setEffortNotice({ kind: 'failed' })
    }
  }

  const chooseRoute = (picked: PickerRoute) => {
    if (picked.disabled || isCurrent(picked.route) || switching || pendingEffort) {
      return
    }

    // A cloud agent's OpenCode Go pick is the owner's per-destination choice
    // (`atum.model-choice/1.4`), not a Mac profile switch and not the managed 1.1 offer.
    if (cloud && !macAnswers && (picked.route.provider === 'opencode-go' || picked.route.provider === 'openai-codex')) {
      const write = window.atumMatrix.modelDestinations?.writeSubscription

      if (!write || !agentPrincipal) {
        setRetryPick(picked)

        return
      }

      const effort =
        picked.defaultEffort && picked.route.efforts.includes(picked.defaultEffort)
          ? picked.defaultEffort
          : (picked.route.efforts[0] ?? 'medium')

      const context = beginSelection()
      setProblem(undefined)
      setEffortNotice(undefined)
      setRetryPick(null)
      setPendingCloudSubscription({ route: picked.route, saved: false })

      void write(
        agentPrincipal,
        picked.route.provider === 'openai-codex' ? 'chatgpt_plan' : 'opencode_go',
        picked.route.model,
        effort
      ).then(
        result => {
          if (!context.current()) {
            return
          }

          if (result?.status !== 'saved') {
            setPendingCloudSubscription(null)
            setRetryPick(picked)

            return
          }

          setPendingCloudSubscription({ route: picked.route, saved: true })
          rememberRecent(picked.route.id)
        },
        () => {
          if (!context.current()) {
            return
          }

          setPendingCloudSubscription(null)
          setRetryPick(picked)
        }
      )

      return
    }

    const homeOption = homeOptionByRoute.get(picked.route.id)

    if (homeMode && homeOption && homeBridge && agentPrincipal) {
      const context = beginSelection()
      setProblem(undefined)
      setEffortNotice(undefined)
      setRetryPick(null)
      setPendingHome({ option: homeOption, route: picked.route, saved: false })

      void homeBridge.model(agentPrincipal, homeOption).then(
        result => {
          if (!context.current()) {
            return
          }

          if (result.status !== 'saved') {
            setPendingHome(null)
            setRetryPick(picked)

            return
          }

          setPendingHome({ option: homeOption, route: picked.route, saved: true })
          rememberRecent(picked.route.id)
        },
        () => {
          if (!context.current()) {
            return
          }

          setPendingHome(null)
          setRetryPick(picked)
        }
      )

      return
    }

    // Atum's own rows keep the existing per-conversation/per-cloud write; a connected row is
    // the agent's own profile on this Mac and goes through native main's validated switch.
    if (picked.route.provider === 'atum') {
      const model = picked.route.model as MatrixModelId
      chooseModel(model, picked.route.id, () => setRetryPick(picked))

      return
    }

    // A cloud agent's OpenRouter shelf pick is the same cloud write as Atum's line-up; main
    // refuses one for an agent that does not answer in the cloud.
    if (picked.route.provider === MATRIX_SHELF_PROVIDER.id) {
      const model = parseMatrixShelfModel(picked.route.model)

      if (model && cloud && !macAnswers) {
        chooseModel(model, picked.route.id, () => setRetryPick(picked))
      }

      return
    }

    const select = window.atumMatrix.selectModelRoute
    const subscriptionPick = parseMatrixSubscriptionProvider(picked.route.provider) !== undefined

    if (!select || (!connected && !subscriptionPick)) {
      return
    }

    const context = beginSelection()
    setProblem(undefined)
    setEffortNotice(undefined)
    setRetryPick(null)
    setPendingConnected({ route: picked.route, saved: false })

    void select(room.id, picked.route.id, picked.route.target).then(
      async result => {
        if (!context.current()) {
          return
        }

        if (result.status === 'cancelled') {
          setPendingConnected(null)
          void loadCatalog()

          return
        }

        setPendingConnected({ route: picked.route, saved: true })
        const next = await loadCatalog()

        if (!context.current()) {
          return
        }

        const settled =
          next?.routes.find(route => route.id === result.current) ??
          (result.current ? next?.routes.find(route => route.id === result.current) : undefined) ??
          picked.route

        rememberRecent(picked.route.id)
        await reconcileEffort(settled, context.current)
      },
      (error: unknown) => {
        if (!context.current()) {
          return
        }

        setPendingConnected(null)
        setProblem(matrixConnectedModelProblem(error))
        void loadCatalog()
      }
    )
  }

  // A new room or account/device scope is a new picker lifetime: nothing about the old host
  // leaks. Live answer-source and home projections are deliberately excluded; those arrive
  // asynchronously while the same card/composer interaction is open.
  useEffect(() => {
    selection.current += 1
    setOpenState(false)
    shown.current = false
    catalogRead.current += 1
    subscriptionRead.current += 1
    setCatalog({ status: 'idle' })
    setSubscriptions({ status: 'idle' })
    setAccountSubscriptions(null)
    setFilterTouched(false)
    setProblem(undefined)
    setEffortNotice(undefined)
    setPendingConnected(null)
    setPendingCloudSubscription(null)
    setPendingHome(null)
    setPendingModel(null)
    setPendingEffort(null)
    setRetryPick(null)
    setQuery('')
    setFilter({ favoritesOnly: false, source: initialSourceRef.current })
  }, [room.id, scope, setPendingEffort, setPendingModel])

  // Reconcile a refreshed projection in place. Changing provider/home can change which rows are
  // valid, but it is still the same host and must not dismiss the shared picker.
  useEffect(() => {
    selection.current += 1
    setPreferences(readPreferences(scope))
    // The account's subscriptions are the same account's after a pick: keep them (the ChatGPT
    // rail and its models must not vanish once a ChatGPT model is chosen) and re-read them while
    // the card is open, so a refreshed relay or connection shows up in place.
    if (shown.current) {
      if (cloudSubscriptions) {
        void loadAccountSubscriptions()
      } else {
        void loadSubscriptions()
      }
    }
    setFilterTouched(false)
    setPendingConnected(null)
    setPendingCloudSubscription(null)
    setPendingHome(null)
    setPendingModel(null)
    setPendingEffort(null)
    setRetryPick(null)
    setQuery('')
    setFilter({ favoritesOnly: false, source: initialSource })
  }, [initialSource, macAnswers, scope, setPendingEffort, setPendingModel])

  useEffect(
    () => () => {
      selection.current += 1
      shown.current = false
    },
    []
  )

  // A pick can change what this card lists while it is open (a plan model makes this Mac's own
  // connections the catalog): read that catalog then, instead of a spinner until the card reopens.
  useEffect(() => {
    if (open && legacyListable && catalog.status === 'idle') {
      void loadCatalog()
    }
    // loadCatalog is recreated every render; the three facts above are what this read depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, legacyListable, catalog.status])

  useEffect(() => {
    if (!pendingConnected?.saved) {
      return
    }

    if (connected && matrixRouteIdOfChoice(connected) === pendingConnected.route.id) {
      setPendingConnected(null)

      return
    }

    const timer = setTimeout(() => setPendingConnected(null), 5000)

    return () => clearTimeout(timer)
  }, [pendingConnected, connected])

  useEffect(() => {
    if (!pendingCloudSubscription?.saved) {
      return
    }

    if (cloudSubscription?.model === pendingCloudSubscription.route.model && !cloudSubscriptionRevoked) {
      setPendingCloudSubscription(null)

      return
    }

    const timer = setTimeout(() => setPendingCloudSubscription(null), 5000)

    return () => clearTimeout(timer)
  }, [cloudSubscription, cloudSubscriptionRevoked, pendingCloudSubscription])

  useEffect(() => {
    if (!pendingHome?.saved) {
      return
    }

    if (sameHomeModel(home?.placement?.currentModel, pendingHome.option)) {
      setPendingHome(null)

      return
    }

    const timer = setTimeout(() => setPendingHome(null), 5000)

    return () => clearTimeout(timer)
  }, [home?.placement?.currentModel, pendingHome])

  // The model that answers is on screen when the card opens, however long the list is.
  useEffect(() => {
    if (open && settled) {
      list.current?.querySelector('[aria-current="true"]')?.scrollIntoView?.({ block: 'nearest' })
    }
  }, [open, settled])

  const openSubscriptions = () => {
    changeOpen(false)
    onSubscriptions?.()
  }

  const keys = useModelPickerKeys(list, search)

  const disconnectedForView =
    filter.source === undefined ? disconnectedAccounts : disconnectedAccounts.filter(each => each.id === filter.source)

  const disconnectedNames = disconnectedForView.map(accountLabel).join(', ')
  // A connection that lapsed is a note under the list, with the way to fix it; searching hides it.
  const signInNote = Boolean(onSubscriptions) && disconnectedForView.length > 0 && !query.trim() && !filter.favoritesOnly

  const emptyState = (() => {
    if (query.trim()) {
      return <p className={PICKER_NOTE}>{words.noMatches}</p>
    }

    if (filter.favoritesOnly) {
      return <p className={PICKER_NOTE}>{words.favoritesEmpty}</p>
    }

    if (signInNote) {
      return null
    }

    if (disconnectedForView.length) {
      return <p className={PICKER_NOTE}>{words.needsSignIn(disconnectedNames)}</p>
    }

    return <p className={PICKER_NOTE}>{words.noModels}</p>
  })()

  // This Mac's models are read natively: say so while they load, and why when they do not.
  const catalogState = (() => {
    if (!legacyListable) {
      return null
    }

    if (catalog.status === 'loading' || catalog.status === 'idle') {
      return (
        <div className="flex items-center gap-2 px-2 py-3 text-xs text-(--atum-ink-muted)" role="status">
          <Spinner aria-hidden className="size-3.5 animate-spin" />
          {words.modelsLoading}
        </div>
      )
    }

    if (catalog.status === 'failed' || catalog.status === 'unavailable') {
      return (
        <div className="grid gap-1 px-1 py-1">
          <p className={PICKER_NOTE} role="alert">
            {catalog.status === 'unavailable' ? words.modelsUnavailable : words.modelsFailed}
          </p>
          <div className="flex flex-wrap items-center gap-1">
            <Button onClick={() => void loadCatalog()} size="sm" type="button" variant="ghost">
              <Refresh aria-hidden className="size-3.5" />
              {words.modelsRetry}
            </Button>
          </div>
        </div>
      )
    }

    return null
  })()

  const choosesModel = managed || homeMode
  const backToAtum = !managed && onBackToAtum
  const named = choosesModel || Boolean(connected) || Boolean(displayRoute) || Boolean(homeDisplayRoute)
  const targetName = readyCatalog?.agentName ?? words.thisAssistant

  if (!choosesModel && !listable && !efforts.length && !onAdvanced && !onSubscriptions && !backToAtum) {
    return null
  }

  // Connect is always the rail's final item when the account destination is available. It never
  // falls back to the assistant-scoped native Hermes page.
  const showConnections = Boolean(onSubscriptions || subscriptionsService?.startChatGpt)
  const catalogReady = homeMode || !legacyListable || catalog.status === 'ready'
  // The rail's Connect: choose a service and sign in right here (ChatGPT, OpenCode Go, and any
  // service added later). An older main without the bridge opens Settings instead.
  const openConnections = () => {
    const providers = (cloudSubscriptions ? accountSubscriptions : subscriptionValue)?.providers

    changeOpen(false)

    if (subscriptionsService?.startChatGpt) {
      setConnecting({ ...(providers ? { providers } : {}) })
    } else {
      onSubscriptions?.()
    }
  }


  const atumChipName = MATRIX_MODEL_LINEUP.find(row => row.id === (cloud ? cloudCurrent : managedCurrent))?.name
  const chipLabel =
    !connectedHere && !shownPlanName && (!homeDisplayRoute || homeDisplayRoute.provider === 'atum')
      ? (atumChipName ?? label)
      : label

  const rowTooltip = (route: MatrixModelRoute) => {
    const shelf = shelfById.get(route.id)

    if (shelf) {
      return shelfTooltip(shelf, words, locale, words.changesCloudAssistant)
    }

    if (route.destination === 'cloud' && (route.provider === 'opencode-go' || route.provider === 'openai-codex')) {
      return words.changesCloudAssistant
    }

    if (homeMode) {
      return currentDestination?.kind === 'cloud' ? words.changesCloudAssistant : words.changesAssistant(targetName)
    }

    return route.provider === 'atum'
      ? cloud
        ? words.changesCloudAssistant
        : words.changesConversation
      : words.changesAssistant(targetName)
  }

  return (
    <Popover onOpenChange={changeOpen} open={open}>
      {trigger ? (
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      ) : (
        <Tip label={copy.modelPicker}>
          <PopoverTrigger asChild>
            <button
              aria-label={named ? `${copy.modelPicker}: ${label}` : copy.modelPicker}
              className="ak-btn ak-btn--plain ak-btn--sm max-w-52 shrink-0"
              data-matrix-model-picker
              disabled={disabled}
              style={{ color: 'var(--ak-ink-2)' }}
              type="button"
            >
              <span className="truncate">{chipLabel}</span>
              <ChevronDown aria-hidden className="-me-1 size-3.5 shrink-0" />
            </button>
          </PopoverTrigger>
        </Tip>
      )}
      <PopoverContent
        align="end"
        aria-label={copy.modelPicker}
        className={cn(MODEL_PICKER_CARD, contentClassName)}
        onKeyDown={keys.shortcutKeyDown}
        // A card opened by a click focuses itself (DESIGN.md), never the search field or a row.
        onOpenAutoFocus={event => {
          event.preventDefault()
          content.current?.focus()
        }}
        ref={content}
        side={side}
        sideOffset={8}
        tabIndex={-1}
      >
        <ModelPickerPanel
          filter={shownFilter}
          footer={
            <>
              {!managed && !homeMode && (efforts.length > 0 || (!effortIssue.supported && chosenEffort)) && (
                <div className="shrink-0 border-t border-(--atum-line) px-2 py-1.5" data-matrix-model-effort>
                  {efforts.length > 0 && (
                    <MatrixModelEffortSlider
                      capability={offered}
                      disabled={switching}
                      managed={false}
                      onChange={next => chooseEffort(next)}
                      value={chosenEffort}
                    />
                  )}
                  {!effortIssue.supported && chosenEffort && (
                    <div className="mt-1" data-matrix-model-effort-unsupported role="status">
                      <p className="text-(length:--atum-t-caption) leading-snug text-(--atum-ink-muted)">
                        {efforts.length
                          ? words.effortUnsupported(words.efforts[chosenEffort])
                          : words.effortNoLevels(words.efforts[chosenEffort])}
                      </p>
                      {effortIssue.suggested && (
                        <Button
                          className="mt-1"
                          disabled={effortSaving || switching}
                          onClick={() => chooseEffort(effortIssue.suggested!)}
                          size="sm"
                          type="button"
                          variant="ghost"
                        >
                          {words.useEffort(words.efforts[effortIssue.suggested])}
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              )}

              {problem && (
                <p
                  className="shrink-0 px-2 py-1 text-xs leading-snug text-(--atum-danger)"
                  data-matrix-model-problem
                  role="alert"
                >
                  {words.switchProblem[problem]}
                </p>
              )}
              {retryPick && (
                <p
                  className="shrink-0 px-2 py-1 text-xs leading-snug text-(--atum-danger)"
                  data-matrix-model-retry
                  role="alert"
                >
                  {words.switchRefused}{' '}
                  <button
                    className="underline underline-offset-2"
                    onClick={() => {
                      const picked = retryPick
                      setRetryPick(null)
                      chooseRoute(picked)
                    }}
                    type="button"
                  >
                    {words.modelsRetry}
                  </button>
                </p>
              )}
              {effortNotice && (
                <p
                  className={cn(
                    'shrink-0 px-2 py-1 text-xs leading-snug',
                    effortNotice.kind === 'failed' ? 'text-(--atum-danger)' : 'text-(--atum-ink-muted)'
                  )}
                  data-matrix-model-effort-notice
                  role={effortNotice.kind === 'failed' ? 'alert' : 'status'}
                >
                  {effortNotice.kind === 'failed'
                    ? words.effortReconcileFailed
                    : words.effortReconciled(words.efforts[effortNotice.level ?? MATRIX_DEFAULT_EFFORT])}
                </p>
              )}
            </>
          }
          keys={keys}
          listRef={list}
          onConnect={showConnections ? openConnections : undefined}
          onFilterChange={next => {
            setFilterTouched(true)
            setFilter(next)
          }}
          onQueryChange={setQuery}
          query={query}
          searchRef={search}
          sources={filterSources}
        >
          {managed || listable || atumRoutes.length ? (
            <>
              <ModelPickerList
                busy={switching || Boolean(pendingEffort)}
                favorites={preferences.favorites}
                isCurrent={isCurrent}
                onChoose={chooseRoute}
                onToggleFavorite={toggleFavorite}
                sections={sections}
                tooltip={rowTooltip}
              />
              {catalogState}
              {catalogReady && sections.length === 0 && emptyState && (
                <div className="px-2 py-3">{emptyState}</div>
              )}
              {signInNote && catalogReady && (
                <p className="px-2 py-2 text-(length:--atum-t-caption) text-(--atum-ink-muted)">
                  {words.needsSignIn(disconnectedNames)}
                </p>
              )}
            </>
          ) : displayName ? (
            <div
              aria-current="true"
              className={cn(PICKER_ROW, 'bg-(--atum-hover)')}
              data-matrix-model-current
              role="listitem"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-(--atum-ink)">{displayName}</span>
                <span className="mt-0.5 block truncate text-(length:--atum-t-caption) text-(--atum-ink-muted)">
                  {displaySubtitle ?? (cloud ? words.cloud : words.thisMac)}
                </span>
              </span>
            </div>
          ) : null}
        </ModelPickerPanel>
      </PopoverContent>
      {connecting && (
        <SubscriptionConnectFlow
          bridge={subscriptionsService}
          onClose={() => setConnecting(null)}
          onConnected={() => undefined}
          providers={connecting.providers}
        />
      )}
    </Popover>
  )
}
