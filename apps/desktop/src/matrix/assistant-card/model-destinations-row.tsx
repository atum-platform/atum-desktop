import { useEffect, useState } from 'react'

import { useI18n } from '@/i18n'
import { ChevronRight } from '@/lib/icons'

import type {
  MatrixAgentHomeBridge,
  MatrixAgentHomeModelOption,
  MatrixAgentHomeView,
  MatrixAgentView,
  MatrixSubscriptionsBridge
} from '../../../shared/matrix'
import {
  type MatrixModelDestinationsView,
  type MatrixModelDestinationView,
  type MatrixModelId,
  matrixModelName,
  parseMatrixModel
} from '../../../shared/matrix-models'
import { MATRIX_SHELF_PROVIDER } from '../../../shared/matrix-shelf-models'
import {
  MATRIX_SUBSCRIPTION_PROVIDERS,
  type MatrixSubscriptionCatalog,
  type MatrixSubscriptionProvider,
  type MatrixSubscriptionsStatus
} from '../../../shared/matrix-subscriptions'
import { executionDeviceRealName } from '../execution-device-name'
import { executionMachinesCopy } from '../execution-machines-copy'
import { MatrixModelPicker } from '../model-picker'

import { ModelDailyCapRow } from './model-daily-cap-row'

const BADGE = 'shrink-0 rounded-full bg-(--atum-hover) px-1.5 py-0.5 text-[10px] leading-none text-(--atum-ink-muted)'

/** Launch kill switch. The platform still owns and returns the cap; the card does not expose it. */
const SHOW_DAILY_CAP = false

/**
 * The assistant card's "Mô hình" rows (`atum.model-choice/1.3`): one row per destination the
 * agent can answer from — the cloud, then each of the owner's Macs by display name — with that
 * destination's default model. Each row opens the same picker the composer uses, scoped to that
 * host: a cloud host offers the eligible Atum models and shows the account subscriptions
 * disabled ("Use on your Mac"); the Mac this assistant lives on offers its own connections too.
 * A pick writes the owner's choice for that destination; a refusal puts the row back with no
 * error band. With no route (flag off, read failed) the whole group is absent.
 */
export function ModelDestinationsRow({
  agent,
  preferenceScope
}: {
  agent: MatrixAgentView
  /** The same account scope the composer uses, so one set of favorites follows the person. */
  preferenceScope?: string
}) {
  const { locale, t } = useI18n()
  const copy = t.matrixShell
  const bridge = window.atumMatrix?.modelDestinations
  const [view, setView] = useState<MatrixModelDestinationsView | undefined>(agent.modelDestinations)
  const [homeView, setHomeView] = useState<MatrixAgentHomeView | undefined>(agent.home)
  const [picks, setPicks] = useState<Record<string, MatrixAgentHomeModelOption>>({})
  const [openFor, setOpenFor] = useState<string>()

  // Snapshot refreshes replace the projection object even when the same assistant and
  // destinations remain. Reconcile the data without ending an interaction in progress.
  useEffect(() => {
    setView(agent.modelDestinations)
    setPicks({})
  }, [agent.modelDestinations])

  // A different assistant is a different card lifetime; this is the only prop change that
  // retires the destination picker owned by the row group.
  useEffect(() => {
    setOpenFor(undefined)
  }, [agent.principal])

  // If an authoritative refresh actually removes the open destination, close the orphaned
  // controller. Ordinary fresh objects with the same destination leave it alone.
  useEffect(() => {
    setOpenFor(current => (current && !view?.choices.some(choice => choice.id === current) ? undefined : current))
  }, [view])

  useEffect(() => {
    setHomeView(agent.home)
  }, [agent.home, agent.principal])

  // The roster snapshot can predate an account-wide subscription connection. Refresh the native
  // owner projection in the background while the card is open so this Mac's row converges on the
  // same current catalog (and opaque connection references) as the composer without delaying a
  // click on any destination.
  useEffect(() => {
    const home = window.atumMatrix?.agentHome

    if (!home) {
      return
    }

    let current = true
    void home.read(agent.principal).then(
      next => {
        if (current && next) {
          setHomeView(next)
        }
      },
      () => {}
    )

    return () => {
      current = false
    }
  }, [agent.principal])

  // The snapshot's rows can be a minute old; opening the card asks once, quietly.
  useEffect(() => {
    if (!bridge) {
      return
    }

    let current = true
    void bridge.read(agent.principal).then(
      next => {
        if (current && next) {
          setView(next)
        }
      },
      () => {}
    )

    return () => {
      current = false
    }
  }, [agent.principal, bridge])

  if (!bridge || !view?.choices.length) {
    return null
  }

  const currentHome = homeView?.placement?.current

  const choose = async (choice: MatrixModelDestinationView, option: MatrixAgentHomeModelOption) => {
    if (option.source === 'atum') {
      const model = parseMatrixModel(option.model)

      if (!model) {
        return { status: 'refused' as const }
      }

      const result = await bridge.write(agent.principal, choice.id, model)

      if (result.status === 'saved') {
        setPicks(current => ({ ...current, [choice.id]: option }))
        setView(current =>
          current
            ? {
                ...current,
                choices: current.choices.map(each =>
                  each.id === choice.id
                    ? (({ external: _external, ...rest }) => ({
                        ...rest,
                        current: model,
                        recommended: model === current.recommended
                      }))(each)
                    : each
                )
              }
            : current
        )
      }

      return result
    }

    // A cloud subscription pick is account-wide (`atum.model-choice/1.4` or `/1.5`).
    if (choice.kind === 'cloud' && (option.source === 'opencode_go' || option.source === 'chatgpt_plan')) {
      if (option.effort !== 'low' && option.effort !== 'medium' && option.effort !== 'high') {
        return { status: 'refused' as const }
      }

      const source = option.source
      const result = await bridge.writeSubscription(agent.principal, source, option.model, option.effort)

      if (result.status === 'saved') {
        setPicks(current => ({ ...current, [choice.id]: option }))
        setView(current =>
          current
            ? {
                ...current,
                choices: current.choices.map(each =>
                  each.id === choice.id
                    ? {
                        ...each,
                        external: {
                          source,
                          providerLabel: option.providerLabel,
                          model: option.model,
                          modelLabel: option.modelLabel,
                          effort: option.effort
                        }
                      }
                    : each
                )
              }
            : current
        )
      }

      return result
    }

    // A subscription belongs to the Mac where it is connected; only the assistant's current
    // home can be written through that Mac's home bridge.
    const homeBridge = window.atumMatrix.agentHome

    if (!homeBridge || choice.kind !== 'mac' || choice.id !== currentHome) {
      return { status: 'refused' as const }
    }

    const result = await homeBridge.model(agent.principal, option)
    const source = option.source as 'chatgpt_plan' | 'opencode_go' | `own_key:${string}`

    if (result.status === 'saved') {
      setPicks(current => ({ ...current, [choice.id]: option }))
      setView(current =>
        current
          ? {
              ...current,
              choices: current.choices.map(each =>
                each.id === choice.id
                  ? {
                      ...each,
                      external: {
                        source,
                        providerLabel: option.providerLabel,
                        model: option.model,
                        modelLabel: option.modelLabel,
                        effort: option.effort
                      }
                    }
                  : each
              )
            }
          : current
      )
    }

    return result
  }

  const homeFor = (choice: MatrixModelDestinationView): MatrixAgentHomeView => {
    const allModels = destinationModels(choice, homeView, picks[choice.id])

    // Another Mac's connections are not writable from this window: keep them visible only as
    // the row's current, disabled value so the picker never offers a choice that cannot save.
    const models =
      choice.kind === 'mac' && choice.id !== currentHome
        ? allModels.flatMap(model => {
            if (model.source === 'atum') {
              return [model]
            }

            return choice.external && model.source === choice.external.source && model.model === choice.external.model
              ? [{ ...model, available: false }]
              : []
          })
        : allModels

    const current =
      picks[choice.id] ??
      (choice.external
        ? models.find(
            model =>
              model.source === choice.external?.source &&
              model.model === choice.external.model &&
              model.effort === choice.external.effort
          )
        : undefined) ??
      // A saved OpenRouter shelf model is the cloud's current model; `current` is then the Atum fallback.
      models.find(model => model.source === 'atum' && model.model === (choice.shelf ?? choice.current))

    const lives =
      homeView?.lives ??
      (choice.kind === 'cloud'
        ? { kind: 'cloud' as const }
        : { kind: 'mac' as const, name: destinationName(locale, choice), thisMac: choice.thisMac === true })

    return {
      lives,
      move: homeView?.move ?? null,
      targets: homeView?.targets ?? [],
      issue: homeView?.issue ?? null,
      placement: {
        profile: 'atum.agent-home/2.5',
        moveAvailable: false,
        current: choice.id,
        reachability: homeView?.placement?.reachability ?? 'reachable',
        ...(current ? { currentModel: current } : {}),
        destinations: [
          {
            id: choice.id,
            kind: choice.kind,
            name: destinationName(locale, choice),
            thisMac: choice.thisMac === true,
            eligibility: 'ready',
            catalogRevision: 0,
            models
          }
        ]
      }
    }
  }

  const cardHome = (choice: MatrixModelDestinationView): MatrixAgentHomeBridge => ({
    read: async () => homeFor(choice),
    preflight: async () => ({ ok: false as const, reason: 'unused' }),
    move: async () => ({ ok: false as const, reason: 'unused' }),
    cancel: async () => ({ ok: false }),
    model: async (_principal, choiceModel) => {
      const option = homeFor(choice).placement?.destinations[0]?.models.find(
        each =>
          each.connectionRef === choiceModel.connectionRef &&
          each.model === choiceModel.model &&
          each.effort === choiceModel.effort
      )

      return option ? choose(choice, option) : { status: 'refused' as const }
    },
    prepare: async () => ({ ok: false as const, reason: 'unused' })
  })

  return (
    <>
      <div className="atum-settings-row atum-settings-row-quiet" data-assistant-card-model-heading>
        <span className="atum-settings-row-text atum-settings-row-title">{copy.modelPicker}</span>
      </div>
      {view.choices.map(choice => {
        const shelfModel = choice.shelf
          ? homeView?.placement?.destinations
              .find(destination => destination.id === choice.id)
              ?.models.find(model => model.source === 'atum' && model.model === choice.shelf)
          : undefined

        const label = choice.external
          ? `${choice.external.providerLabel} · ${choice.external.modelLabel}`
          : choice.shelf
            ? `${shelfModel?.providerLabel ?? MATRIX_SHELF_PROVIDER.label} · ${shelfModel?.modelLabel ?? choice.shelf}`
            : matrixModelName(choice.current)

        const local = choice.kind === 'mac' && choice.thisMac === true && currentHome === choice.id

        return (
          <MatrixModelPicker
            agentHome={cardHome(choice)}
            agentPrincipal={agent.principal}
            cloud={choice.kind === 'cloud'}
            connected={
              choice.external
                ? {
                    provider:
                      choice.external.source === 'chatgpt_plan'
                        ? 'openai-codex'
                        : choice.external.source.slice('own_key:'.length),
                    model: choice.external.model
                  }
                : undefined
            }
            contentClassName="z-[150] w-[27rem]"
            destinationDefault={choice.external ? undefined : choice.current}
            disabled={false}
            fail={() => undefined}
            home={homeFor(choice)}
            key={choice.id}
            local={local}
            managed
            onOpenChange={next => {
              if (next) {
                setOpenFor(choice.id)
              } else {
                setOpenFor(current => (current === choice.id ? undefined : current))
              }
            }}
            open={openFor === choice.id}
            preferenceScope={preferenceScope}
            room={{
              id: `assistant-card:${agent.principal}:${choice.id}`,
              name: destinationName(locale, choice),
              membership: 'join',
              encrypted: true,
              assistant: true
            }}
            side="bottom"
            subscriptionBridge={local ? cardSubscriptions(homeView, choice) : undefined}
            trigger={
              <button
                aria-haspopup="dialog"
                className="atum-settings-row atum-settings-link"
                data-assistant-card-model-destination={choice.kind}
                type="button"
              >
                <span className="atum-settings-row-title shrink-0">{destinationName(locale, choice)}</span>
                <span className="atum-card-row-value ms-auto" title={label}>
                  {label}
                </span>
                {!choice.external && !choice.shelf && choice.current === view.recommended && (
                  <span className={BADGE} data-assistant-card-model-recommended>
                    {copy.modelRecommended}
                  </span>
                )}
                <ChevronRight aria-hidden className="atum-settings-chevron" />
              </button>
            }
          />
        )
      })}
      {SHOW_DAILY_CAP && view.dailyCap && (
        <ModelDailyCapRow bridge={bridge} cap={view.dailyCap} onView={setView} principal={agent.principal} />
      )}
    </>
  )
}

function destinationModels(
  choice: MatrixModelDestinationView,
  home: MatrixAgentHomeView | undefined,
  picked: MatrixAgentHomeModelOption | undefined
): MatrixAgentHomeModelOption[] {
  const fromHome = home?.placement?.destinations.find(destination => destination.id === choice.id)?.models ?? []
  const models = [...fromHome]

  const add = (option: MatrixAgentHomeModelOption) => {
    if (!models.some(each => each.source === option.source && each.model === option.model)) {
      models.push(option)
    }
  }

  for (const model of choice.models) {
    add(atumOption(model, !choice.unavailable.includes(model)))
  }

  if (picked) {
    add(picked)
  }

  if (choice.external) {
    add({
      connectionRef: `${choice.external.source}:${choice.external.model}`,
      source: choice.external.source,
      providerLabel: choice.external.providerLabel,
      model: choice.external.model,
      modelLabel: choice.external.modelLabel,
      effort: choice.external.effort,
      efforts: [choice.external.effort],
      available: true
    })
  }

  return models.map(model => {
    const unavailable = model.source === 'atum' && choice.unavailable.some(id => id === model.model)

    return unavailable ? { ...model, available: false } : model
  })
}

function atumOption(model: MatrixModelId, available: boolean): MatrixAgentHomeModelOption {
  return {
    connectionRef: 'atum',
    source: 'atum',
    providerLabel: 'Atum',
    model,
    modelLabel: matrixModelName(model),
    effort: 'medium',
    efforts: ['low', 'medium', 'high'],
    available
  }
}

function subscriptionProvider(model: MatrixAgentHomeModelOption): MatrixSubscriptionProvider | undefined {
  if (model.source === 'chatgpt_plan') {
    return 'openai-codex'
  }

  if (model.source === 'opencode_go') {
    return 'opencode-go'
  }

  const own = model.source.startsWith('own_key:') ? model.source.slice('own_key:'.length) : undefined

  return MATRIX_SUBSCRIPTION_PROVIDERS.find(provider => provider === own)
}

/** The host's own connected subscriptions, from the same model list its home picker shows. */
function cardSubscriptions(
  home: MatrixAgentHomeView | undefined,
  choice: MatrixModelDestinationView
): MatrixSubscriptionsBridge {
  const models =
    home?.placement?.destinations.find(destination => destination.id === choice.id)?.models ??
    destinationModels(choice, home, undefined)

  const providers = MATRIX_SUBSCRIPTION_PROVIDERS.map(provider => {
    const connected = models.filter(model => subscriptionProvider(model) === provider)

    return connected.length
      ? { id: provider, connected: true, models: [...new Set(connected.map(model => model.model))] }
      : { id: provider, connected: false }
  })

  return {
    catalog: async (): Promise<MatrixSubscriptionCatalog> => ({ destination: 'this_mac', providers }),
    status: async (): Promise<MatrixSubscriptionsStatus> => ({
      scope: 'account',
      providers: providers.map(({ id, connected }) => ({ id, connected }))
    }),
    startChatGpt: async () => ({ status: 'cancelled' }),
    pollChatGpt: async () => ({ status: 'pending' }),
    cancelChatGpt: async () => undefined,
    disconnectChatGpt: async () => undefined,
    useThisMacForChatGpt: async () => ({ status: 'unavailable' }),
    connectOpenCode: async () => ({ status: 'cancelled' }),
    disconnectOpenCode: async () => undefined
  }
}

function destinationName(locale: string, choice: MatrixModelDestinationView): string {
  const copy = executionMachinesCopy(locale)

  if (choice.kind === 'cloud') {
    return copy.cloud
  }

  const named = executionDeviceRealName({
    displayName: choice.deviceName ?? '',
    ...(choice.deviceModel ? { model: choice.deviceModel } : {})
  })

  const name = named ?? copy.mac(choice.macOrdinal ?? 1)

  return choice.thisMac ? `${name} ${copy.thisMac}` : name
}
