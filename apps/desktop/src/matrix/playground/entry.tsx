import '../../styles.css'

import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'

import { I18nProvider } from '@/i18n'

import { matrixModelDisplayName } from '../../../shared/matrix-model-display-name'
import { MatrixApp } from '../app'
import { applyMatrixMaterial, MatrixAppearance } from '../appearance'
import { openAssistantCard } from '../assistant-card'
import { MatrixDesktopServicesBootstrap } from '../desktop-services'

import { playgroundAgentHome, withPlaygroundHome } from './agent-home-fixtures'
import { playgroundAssistants } from './assistant-fixtures'
import { playgroundBridge, playgroundDesktopServices, PlaygroundStore } from './bridge'
import { PlaygroundCheckIns, playgroundCheckInsMode } from './check-ins-fixtures'
import { playgroundCompanyDesktopAdapter, withPlaygroundPrivateCos } from './company-ai-fixtures'
import { playgroundCompanyStore, type PlaygroundCompanyStoreMode } from './company-store-fixtures'
import { playgroundDeskMode, withPlaygroundDesk } from './desk-fixtures'
import {
  playgroundPolicyBridge,
  playgroundPolicyMode,
  playgroundPolicyView,
  withPlaygroundPolicy
} from './execution-policy-fixtures'
import { PLAYGROUND_SCENARIO_LABELS, PLAYGROUND_SCENARIOS, playgroundAlias, type PlaygroundScenario } from './fixtures'
import { isPlaygroundView, PlaygroundGallery } from './gallery'
import { playgroundLinkPreviewMode, playgroundLinkPreviews, withPlaygroundLinkPreviews } from './link-preview-fixtures'
import { playgroundAgentMemory, playgroundMemoryMode } from './memory-fixtures'
import { playgroundDocumentPreview, playgroundPlaceBridges, playgroundPlaces, withPlaygroundPlaces } from './places-fixtures'
import { playgroundRoutines, playgroundRoutinesMode } from './routine-fixtures'
import {
  playgroundGoogleConnections,
  playgroundLoginStartup,
  playgroundPermissions,
  playgroundProfiles,
  playgroundSettingsOptions,
  playgroundUnclaimedAliases,
  withPlaygroundSettings
} from './settings-fixtures'
import { PlaygroundCommerce, playgroundCommerceOptions } from './store-fixtures'
import { playgroundSubscriptions, playgroundSubscriptionsMode } from './subscription-fixtures'

/**
 * The design playground : the real Matrix window on
 * fixture data. Dev only, served by Vite from matrix-playground.html; never bundled.
 */
const params = new URLSearchParams(location.search)
const view = params.get('view')

const initial = (PLAYGROUND_SCENARIOS as readonly string[]).includes(params.get('scenario') ?? '')
  ? (params.get('scenario') as PlaygroundScenario)
  : 'chat'

const LOCALES = ['en', 'vi', 'ja', 'zh', 'zh-hant'] as const
type PlaygroundLocale = (typeof LOCALES)[number]

const initialLocale = (LOCALES as readonly string[]).includes(params.get('lang') ?? '')
  ? (params.get('lang') as PlaygroundLocale)
  : 'en'

/** The first launch's story plays once per install; the playground chooses when. */
function prepareStory(scenario: PlaygroundScenario) {
  try {
    if (scenario === 'first-launch') {
      localStorage.removeItem('io.atum.welcome.played')
    } else {
      localStorage.setItem('io.atum.welcome.played', '1')
    }
  } catch {
    // Storage off: the story counts as seen.
  }
}

prepareStory(initial)
const store = new PlaygroundStore(initial, initialLocale)
// Optional places (Drive, company, Mac apps, a document, offers) come from the URL.
const places = playgroundPlaces(params)
const emitSnapshot = store.emit.bind(store)
// The wallet, the Store and the checkout a signed-in window has (?balance=, ?order=, ?store=).
const commerce = new PlaygroundCommerce(playgroundCommerceOptions(params))
// Settings' native pieces and account states (?recovery=, ?ignored=, ?model=, ?google=, ?login=).
const settings = playgroundSettingsOptions(params)
const googleConnections = playgroundGoogleConnections(settings)
// Check-ins' records everywhere, and their cards and lines from the URL (?checkins=).
const checkIns = new PlaygroundCheckIns(playgroundCheckInsMode(params), () => store.locale)
// The failover control's states from the URL (?policy=paused|loading|answering|saving-failed).
const policyMode = playgroundPolicyMode(params)
const policyView = playgroundPolicyView(policyMode)
const bridge = playgroundBridge(store)
// Link preview cards under messages in the open chat (?links=1).
const linkPreviews = playgroundLinkPreviewMode(params)
// The account's ChatGPT states in Settings › Connections and the model picker (?subscriptions=).
const subscriptionsMode = playgroundSubscriptionsMode(params)
// The agent's desk in the side panel (?desk=free|working|waiting|device), on the open assistant chat.
const deskMode = playgroundDeskMode(params)
// `?home=off` draws an assistant without the agent-home projection (the plain model menu).
const homeDecorated = params.get('home') === 'off' ? (snapshot: typeof store.current) => snapshot : withPlaygroundHome

store.emit = snapshot =>
  emitSnapshot(
    withPlaygroundPolicy(
      withPlaygroundSettings(
        commerce.decorate(
          checkIns.decorate(
            homeDecorated(
              withPlaygroundDesk(
                withPlaygroundLinkPreviews(withPlaygroundPlaces(snapshot, places), linkPreviews),
                deskMode,
                store.locale ?? 'en'
              )
            )
          )
        ),
        settings
      ),
      policyView,
      policyMode
    )
  )
commerce.subscribe(() => store.emit(store.current))
checkIns.subscribe(() => store.emit(store.current))
if (linkPreviews) {
  store.emit(store.current)
}
window.atumMatrix = {
  ...bridge,
  command: checkIns.wrap(bridge.command),
  agentHome: playgroundAgentHome(() => store.current),
  ...playgroundPlaceBridges(places, () => store.current),
  ...(places.doc ? { previewDocument: async () => playgroundDocumentPreview(places) } : {}),
  // The title-bar failover control reads and saves against the fixture (§9.4), never a network.
  executionPolicy: playgroundPolicyBridge(policyMode),
  // The desk's Stop asks the fixture, never a controller: it answers as a stopped turn.
  ...(deskMode
    ? {
        // Only Stop is answered (`stopTurn`); any other cloud request fails as offline would.
        cloudAgent: (async (request: { action: string }) => {
          if (request.action !== 'stopTurn') {
            throw new Error('playground_cloud_unavailable')
          }

          return { state: 'stopped' as const }
        }) as unknown as NonNullable<typeof window.atumMatrix.cloudAgent>
      }
    : {}),
  store: commerce.storeBridge(),
  checkout: commerce.checkoutBridge(),
  wallet: commerce.walletBridge(),
  permissions: playgroundPermissions(settings),
  profiles: playgroundProfiles(() => store.current),
  linkPreviews: playgroundLinkPreviews(),
  // The assistant card's records (?card=offline refuses every write).
  assistants: playgroundAssistants(() => store.current, next => store.emit(next), {
    offline: params.get('card') === 'offline'
  }),
  // Every card's scheduled tasks (?routines=empty|conflict|legacy|unknown).
  routines: playgroundRoutines(playgroundRoutinesMode(params)),
  // Every card's Memory row (?memory=off|offline|empty|none), on fixture data.
  agentMemory: playgroundAgentMemory(playgroundMemoryMode(params)),
  ...(googleConnections ? { googleConnections } : {}),
  ...(subscriptionsMode ? { subscriptions: playgroundSubscriptions(subscriptionsMode) } : {}),
  // The assistant card's per-destination model rows read the fixture's offer; picks save locally.
  modelDestinations: {
    read: async principal => store.current.agents?.find(each => each.principal === principal)?.modelDestinations,
    write: async () => ({ status: 'saved' as const }),
    // A plan pick is saved as the cloud choice, as the server stores it (`atum.model-choice/1.4`).
    writeSubscription: async (principal, source, model, effort) => {
      store.emit({
        ...store.current,
        agents: store.current.agents?.map(agent =>
          agent.principal === principal
            ? {
                ...agent,
                cloudModel: {
                  offered: agent.cloudModel?.offered ?? ['default'],
                  current: agent.cloudModel?.current ?? 'default',
                  subscription: { source, model, effort, displayName: matrixModelDisplayName(model) },
                  subscriptionState: 'connected' as const
                }
              }
            : agent
        )
      })

      return { status: 'saved' as const }
    },
    cap: async () => ({ status: 'saved' as const })
  },
  ...(settings.aliasNone ? { aliases: playgroundUnclaimedAliases(playgroundAlias) } : {})
}

if (places.company) {
  const member = places.company === 'team-member' || places.company === 'member'
  // The company Store (?marketplace=owner|member|short|pending|uncertain): the Marketplace page's fixture.
  const market = params.get('marketplace') as PlaygroundCompanyStoreMode | null

  const companyDesktop = initial === 'team-space-private-cos'
    ? withPlaygroundPrivateCos(playgroundCompanyDesktopAdapter(member))
    : playgroundCompanyDesktopAdapter(member)

  if (market === 'short') {
    // The short wallet the refusal speaks of: 2,500 Protons available.
    const readWallet = companyDesktop.readWallet.bind(companyDesktop)
    companyDesktop.readWallet = async companyId => {
      const wallet = await readWallet(companyId)

      return { ...wallet, balances: { ...wallet.balances, available: 2_500_000_000 } }
    }
  }

  Object.assign(window.atumMatrix, {
    companyDesktop,
    ...(market ? { companyStore: playgroundCompanyStore(member ? 'member' : market) } : {})
  })
}

if (params.has('teamAdmin')) {
  // The Add people sheet's people directory: two people named Lan Nguyễn told apart by handle, someone already
  // invited, and one person an exact email finds.
  const directory = [
    { userId: '@lan:example.invalid', name: 'Lan Nguyễn', handle: 'lan_nguyen' },
    { userId: '@lan2:example.invalid', name: 'Lan Nguyễn', handle: 'lan_pham' },
    { userId: '@bao:example.invalid', name: 'Bảo Trần', handle: 'bao_tran' },
    { userId: '@an:example.invalid', name: 'An Phạm', handle: 'an_pham' },
    // Found by name without a handle: the contacts read (playgroundAlias) supplies it.
    { userId: '@my:example.invalid', name: 'Mỹ Lê' }
  ]

  Object.assign(window.atumMatrix, { people: {
    search: async ({ query }: { query: string }) => {
      const q = query.trim().replace(/^@/u, '').toLowerCase()
      const fold = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/gu, 'd').toLowerCase()

      const results = q.includes('@')
        ? (q === 'an@example.com' ? [directory[3]!] : [])
        : directory.filter(person => fold(person.name).includes(fold(q)) || person.handle === q)

      return { ok: true, value: { results, limited: false } }
    },
    privacy: async () => ({ ok: true, enabled: true }),
    setPrivacy: async () => ({ ok: true, enabled: true })
  } })
}

window.atumLoginStartup = playgroundLoginStartup(settings)
// Scripted design shots pay a QR from the console: `__atumPlaygroundCommerce.pay`.
Object.assign(window, { __atumPlaygroundCommerce: commerce })

const updateVersion = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u.test(params.get('version') ?? '')
  ? params.get('version')!
  : '2.0.0'

window.atumDesktopServices = playgroundDesktopServices(
  params.get('update') === 'ready' ? 'downloaded' : 'idle',
  updateVersion,
  params.get('checked') !== '0'
)

function Playground() {
  const [scenario, setScenario] = useState<PlaygroundScenario>(initial)
  const [locale, setLocale] = useState<PlaygroundLocale>(initialLocale)
  const [run, setRun] = useState(0)

  // `?card=primary|other` opens that assistant's card once the window has its roster, so the
  // same screenshots can be taken of the primary and of any other assistant.
  useEffect(() => {
    const which = params.get('card')

    if (!which) {
      return
    }

    let frame = 0

    const look = () => {
      const agent = store.current.agents?.find(each => (which === 'primary' ? each.isDefault : !each.isDefault))

      if (agent) {
        openAssistantCard({ kind: 'agent', principal: agent.principal })

        return
      }

      if (frame++ < 120) {
        requestAnimationFrame(look)
      }
    }

    look()
  }, [run])

  const choose = (next: PlaygroundScenario) => {
    setScenario(next)
    const url = new URL(location.href)
    url.searchParams.set('scenario', next)
    history.replaceState(null, '', url)
    // A new mount so the window starts the scenario fresh (first launch, etc.).
    prepareStory(next)
    setRun(value => value + 1)
    store.set(next)
  }

  return (
    <>
      <I18nProvider configClient={null} initialLocale={locale} key={`${locale}:${run}`}>
        <MatrixAppearance />
        <MatrixDesktopServicesBootstrap />
        {isPlaygroundView(view) ? (
          // The shell's tokens, around a part that is not wired into the window yet.
          <main className="atum-shell atum-window-ground flex h-dvh min-h-0 flex-col overflow-hidden text-(--atum-ink)">
            <PlaygroundGallery view={view} />
          </main>
        ) : (
          <MatrixApp />
        )}
      </I18nProvider>
      <div
        aria-label="Playground"
        className="fixed top-2 left-1/2 z-[1000] flex -translate-x-1/2 items-center gap-2 rounded-xl border border-black/10 bg-white/80 px-2.5 py-2 text-xs text-neutral-800 shadow-lg backdrop-blur-xl dark:border-white/10 dark:bg-neutral-900/80 dark:text-neutral-100"
        data-matrix-playground
        hidden={params.get('evidence') === '1'}
        role="group"
      >
        <span className="font-semibold">Playground</span>
        <label className="flex items-center gap-1">
          <span className="sr-only">Scenario</span>
          <select
            className="rounded-md border border-black/10 bg-transparent px-1.5 py-1 dark:border-white/15"
            onChange={event => choose(event.target.value as PlaygroundScenario)}
            value={scenario}
          >
            {PLAYGROUND_SCENARIOS.map(value => (
              <option key={value} value={value}>
                {PLAYGROUND_SCENARIO_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1">
          <span className="sr-only">Language</span>
          <select
            className="rounded-md border border-black/10 bg-transparent px-1.5 py-1 dark:border-white/15"
            onChange={event => {
              setLocale(event.target.value as PlaygroundLocale)
              store.setLocale(event.target.value as PlaygroundLocale)
            }}
            value={locale}
          >
            {LOCALES.map(value => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <button
          className="rounded-md border border-black/10 px-2 py-1 hover:bg-black/5 dark:border-white/15 dark:hover:bg-white/10"
          onClick={() => choose(scenario)}
          type="button"
        >
          Replay
        </button>
      </div>
    </>
  )
}

applyMatrixMaterial()
store.set(initial)
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Playground />
  </StrictMode>
)
