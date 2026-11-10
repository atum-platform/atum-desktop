/**
 * What the agent's settings show about where it lives: the controller's view put into the owner's words.
 *
 * Names come from the owner's own device registry (`execution-device-names.ts`: their active Macs and what they
 * called them). A Mac the registry does not know is shown without a name and the window says "another Mac"; an
 * unreachable registry means no list of places to move to, never a guess.
 */
import type {
  MatrixAgentHomeDestinationView,
  MatrixAgentHomeModelOption,
  MatrixAgentHomeView
} from '../../../shared/matrix'
import { type MatrixModelId, matrixModelName, parseMatrixModel } from '../../../shared/matrix-models'
import { MATRIX_SHELF_PROVIDER, type MatrixShelfModelId, parseMatrixShelfModel } from '../../../shared/matrix-shelf-models'

import { externalModelLabel } from './connection-participant'
import type { PlacementConnectionFailure } from './connection-platform'
import type { HomeLocation } from './contract'
import type { PlacementModelChoiceV25, SanitizedMacConnectionV25 } from './contract-v25'
import type { AgentHomeView } from './controller'
import { type AgentHomeOwnerState, type CloudHomeOffer, cloudHomeOptions, waitingForHomeMac } from './owner-controller'

export interface MacName {
  displayName: string
  thisMac: boolean
}

export type MacNames = Readonly<Record<string, MacName>>

/** A cloud-route agent still has one honest known place when the additive owner snapshot cannot
 * be read. Preserve that place and surface the closed failure instead of collapsing it into an
 * endless “finding…” state. The retry remains the same authoritative GET. */
export function ownerHomeReadFallback(
  failure: PlacementConnectionFailure | undefined,
  cloud: boolean
): MatrixAgentHomeView | undefined {
  if (!failure || !cloud) {
    return undefined
  }

  return {
    lives: { kind: 'cloud' },
    move: null,
    targets: [],
    issue: failure.kind === 'unsupported' ? 'platform_unsupported' : failure.reason === 'agent_home_generation_conflict' ? 'placement_stale' : 'placement_unavailable'
  }
}

function place(location: HomeLocation, names: MacNames | null, me: string | null) {
  if (location.kind === 'cloud') {
    return { kind: 'cloud' as const }
  }

  return {
    kind: 'mac' as const,
    name: names?.[location.deviceServiceId]?.displayName ?? '',
    thisMac: location.deviceServiceId === me
  }
}

export function homeViewFor(home: AgentHomeView | null, names: MacNames | null, me: string | null): MatrixAgentHomeView | undefined {
  if (!home) {
    return undefined
  }

  const current = home.lives.kind === 'mac' ? home.lives.deviceServiceId : null

  // The legacy 2.1 controller cannot start a move out of a cloud home, so `canMove` is false
  // there even though the native app is signed in on a real Mac. Keep those Macs in the display
  // view: the 2.5 owner flow decides whether a move is actionable, while its launch-disabled
  // route gets an honest read-only fallback instead of claiming there is no Mac.
  const targets =
    (home.canMove || home.lives.kind === 'cloud') && names
      ? Object.entries(names)
          .filter(([id]) => id !== current)
          .map(([id, value]) => ({
            id,
            name: value.displayName,
            ...(id === me || value.thisMac ? { thisMac: true } : {})
          }))
          .sort((left, right) => left.name.localeCompare(right.name))
      : []

  return {
    lives: home.lives.kind === 'cloud' ? { kind: 'cloud' } : { kind: 'mac', name: names?.[home.lives.deviceServiceId]?.displayName ?? '', thisMac: home.lives.thisMac },
    move: home.move ? { step: home.move.step, to: place(home.move.to, names, me), role: home.move.role } : null,
    targets,
    activation: home.activation,
    issue: home.issue
  }
}

function option(
  choice: PlacementModelChoiceV25,
  providerLabel: string,
  modelLabel: string,
  efforts: MatrixAgentHomeModelOption['efforts'],
  available: boolean
): MatrixAgentHomeModelOption {
  return {
    connectionRef: choice.connectionRef,
    source: choice.source as MatrixAgentHomeModelOption['source'],
    providerLabel,
    model: choice.model,
    modelLabel,
    effort: choice.effort,
    efforts,
    available
  }
}

/** The wire label is ASCII; Atum's own rows show the product name in the owner's app. */
function destinationModelLabel(
  model: SanitizedMacConnectionV25['models'][number],
  source: SanitizedMacConnectionV25['source']
): string {
  const managed = source === 'atum' ? parseMatrixModel(model.model) : undefined

  return managed ? matrixModelName(managed) : model.modelLabel || externalModelLabel(model.model)
}

function choiceLabel(choice: PlacementModelChoiceV25): string {
  const managed = choice.source === 'atum' ? parseMatrixModel(choice.model) : undefined

  return managed ? matrixModelName(managed) : externalModelLabel(choice.model)
}

function cloudDestination(offers?: readonly CloudHomeOffer[]): MatrixAgentHomeDestinationView {
  return {
    id: 'cloud',
    kind: 'cloud',
    name: '',
    thisMac: false,
    eligibility: 'ready',
    catalogRevision: 0,
    // What the platform serves this agent now (an alias it does not serve is shown unavailable, not hidden); the two
    // line-up aliases only until an offer has been read. An OpenRouter shelf row is listed under its own rail with its
    // name and price, and only while the platform offers it: one missing its price is not drawn at all.
    models: cloudHomeOptions(offers).flatMap(({ choice, available }) => {
      const shelf = parseMatrixShelfModel(choice.model)
        ? offers?.find(each => each.alias === choice.model)?.shelf
        : undefined

      if (parseMatrixShelfModel(choice.model) && (!shelf || !available)) {
        return []
      }

      const row = option(
        choice,
        shelf ? MATRIX_SHELF_PROVIDER.label : 'Atum',
        shelf ? shelf.name : matrixModelName(choice.model as MatrixModelId),
        offerEfforts(offers, choice),
        available
      )

      return [shelf ? { ...row, shelf } : row]
    })
  }
}

function offerEfforts(
  offers: readonly CloudHomeOffer[] | undefined,
  choice: PlacementModelChoiceV25
): MatrixAgentHomeModelOption['efforts'] {
  const row = offers?.find(each => each.alias === choice.model)
  const efforts = (row?.efforts ?? []).filter((each): each is 'low' | 'medium' | 'high' =>
    each === 'low' || each === 'medium' || each === 'high'
  )

  return efforts.length > 0 ? efforts : [choice.effort]
}

/** A cloud destination's saved plan choice (`atum.model-choice/1.4`): the current model as itself. */
export interface CloudHomeSavedPlanChoice {
  source: 'chatgpt_plan' | 'opencode_go'
  model: string
  modelLabel: string
  providerLabel: string
  effort: MatrixAgentHomeModelOption['effort']
}

/** Add the narrow 2.5 owner/catalog/application projection to the legacy placement row. */
export function ownerHomeViewFor(
  base: MatrixAgentHomeView,
  state: AgentHomeOwnerState,
  names: MacNames | null,
  me: string | null,
  /** The cloud destination's SAVED choice: an Atum alias, or a plan model. Never a recommendation
   * standing in for a plan choice, or an Atum row reads as already chosen and a click does nothing. */
  cloudModel?: MatrixModelId | MatrixShelfModelId | CloudHomeSavedPlanChoice,
  cloudOffers?: readonly CloudHomeOffer[],
  supersededDeviceIds: readonly string[] = []
): MatrixAgentHomeView {
  const snapshot = state.snapshot
  const location = snapshot.placement.location
  const superseded = new Set(supersededDeviceIds)
  const devices = snapshot.eligibleDevices.filter(
    device =>
      !superseded.has(device.deviceServiceId) ||
      (location.kind === 'mac' && location.deviceServiceId === device.deviceServiceId)
  )

  if (
    location.kind === 'mac' &&
    !devices.some(device => device.deviceServiceId === location.deviceServiceId)
  ) {
    const deviceServiceId = location.deviceServiceId

    devices.push({
      deviceServiceId,
      displayName: names?.[deviceServiceId]?.displayName || '',
      eligibility: 'ready'
    })
  }

  // `eligibleDevices` is per agent. A cloud agent can therefore omit the Mac this signed-in
  // app is running on even though this Mac is the one target the owner plainly has. Add it as a
  // preparable candidate; `prepare` publishes its real catalog, and the platform remains the
  // authority that promotes it to ready before preflight can move anything.
  if (me && !devices.some(device => device.deviceServiceId === me)) {
    devices.push({
      deviceServiceId: me,
      displayName: names?.[me]?.displayName || '',
      eligibility: 'unavailable',
      reason: 'not_enrolled'
    })
  }

  const homeDevice = location.kind === 'mac' ? location.deviceServiceId : null
  // The home Mac is not answering and the platform offers no move: the sheet waits for it (see `waitingForHome`).
  const waitingForHome = waitingForHomeMac(snapshot)

  const macs = devices.map(device => {
    const catalog = state.catalogs[device.deviceServiceId]
    const fresh = catalog?.freshness === 'fresh'
    const connections = (Array.isArray(catalog?.connections) ? catalog.connections : []) as SanitizedMacConnectionV25[]
    // Set-up is for the Mac the window is on, while the assistant lives elsewhere and no move is going: a Mac with no fresh
    // catalog is not set up (or its set-up lapsed); one with a fresh catalog and nothing in it only lacks a connected model.
    const setUp: MatrixAgentHomeDestinationView['setUp'] =
      device.deviceServiceId === me &&
      device.deviceServiceId !== homeDevice &&
      snapshot.placement.activeMove === null &&
      device.eligibility === 'unavailable' &&
      (device.reason === 'catalog_unavailable' || device.reason === 'not_enrolled')
        ? fresh && connections.length === 0
          ? 'connect'
          : 'needed'
        : undefined
    const models = connections.flatMap(connection =>
      connection.models.map(model =>
        option(
          {
            destination: `mac:${device.deviceServiceId}`,
            deviceServiceId: device.deviceServiceId,
            source: connection.source,
            connectionRef: connection.connectionRef,
            model: model.model,
            effort: model.defaultEffort
          } as PlacementModelChoiceV25,
          connection.providerLabel,
          destinationModelLabel(model, connection.source),
          model.efforts,
          fresh && connection.state === 'available'
        )
      )
    )

    return {
      id: device.deviceServiceId,
      kind: 'mac' as const,
      name: device.displayName || names?.[device.deviceServiceId]?.displayName || '',
      thisMac: device.deviceServiceId === me,
      eligibility: device.eligibility,
      ...(device.eligibility === 'unavailable' ? { reason: device.reason } : {}),
      ...(setUp ? { setUp } : {}),
      catalogRevision: catalog?.catalogRevision ?? 0,
      models
    }
  })
  const destinations: MatrixAgentHomeDestinationView[] = [cloudDestination(cloudOffers), ...macs]
  const current = snapshot.placement.location.kind === 'cloud' ? 'cloud' : snapshot.placement.location.deviceServiceId
  const projection = state.modelApplication
  const currentDestination = destinations.find(destination => destination.id === current)
  const cloudChoice: MatrixAgentHomeModelOption | undefined =
    typeof cloudModel === 'string'
      ? cloudDestination(cloudOffers).models.find(model => model.model === cloudModel)
      : cloudModel
        ? {
            connectionRef: `${cloudModel.source}:${cloudModel.model}`,
            source: cloudModel.source,
            providerLabel: cloudModel.providerLabel,
            model: cloudModel.model,
            modelLabel: cloudModel.modelLabel,
            effort: cloudModel.effort,
            efforts: [cloudModel.effort],
            available: true
          }
        : undefined
  const currentModel = projection
    ? currentDestination?.models.find(
        model =>
          model.connectionRef === projection.choice.connectionRef &&
          model.model === projection.choice.model &&
          model.effort === projection.choice.effort
      ) ??
      option(
        projection.choice,
        projection.choice.source === 'chatgpt_plan' ? 'ChatGPT' : projection.choice.source === 'atum' ? 'Atum' : 'Local model',
        choiceLabel(projection.choice),
        [projection.choice.effort],
        projection.status === 'applied'
      )
    : cloudChoice ?? currentDestination?.models[0]

  return {
    ...base,
    placement: {
      profile: 'atum.agent-home/2.5',
      moveAvailable: snapshot.moveCapability.state === 'available',
      ...(waitingForHome ? { waitingForHome } : {}),
      current,
      reachability: snapshot.currentHomeReachability.state,
      destinations,
      ...(currentModel ? { currentModel } : {}),
      ...(projection ? { modelStatus: projection.status } : {}),
      ...(state.progress
        ? {
            progress: {
              state: state.progress.state,
              sequence: state.progress.sequence,
              reason: state.progress.reason
            }
          }
        : {})
    }
  }
}
