import { lazy, Suspense, useEffect, useMemo, useState } from 'react'

import { AtumAtom } from '@/components/brand/atum-atom'
import { ErrorBoundary } from '@/components/error-boundary'
import { Loader } from '@/components/ui/loader'
import { Spinner } from '@/lib/icons'

import type { MatrixSignInMethod, MatrixSnapshot } from '../../../shared/matrix'
import { MatrixCrashFallback } from '../crash-fallback'
import { MatrixRailAccount } from '../rail-account'
import { type MatrixSettingsPane, MatrixSettingsSheet } from '../settings-sheet'
import { MatrixSignIn } from '../sign-in'
import { type DiscoverStore, MatrixDiscoverView } from '../store/discover-view'
import { MatrixProtonsPane, type ProtonsWalletData } from '../store/protons-pane'
import { MatrixStoreSidebar } from '../store/store-sidebar'
import type { DiscoverShelf } from '../store/top-up'

import { AwarenessGallery } from './awareness-gallery'
import { PLAYGROUND_SCENARIOS, scenarioSnapshot } from './fixtures'
import { PlaygroundGoogleSettings } from './google-fixtures'
import {
  PLAYGROUND_ASSISTANT,
  PLAYGROUND_WALLET,
  PlaygroundCommerce,
  playgroundCommerceOptions,
  playgroundHistory
} from './store-fixtures'

export const PLAYGROUND_VIEWS = [
  'awareness',
  'awareness-stale',
  'awareness-unavailable',
  'awareness-loading',
  'awareness-empty',
  'store',
  'store-loading',
  'store-unavailable',
  'protons',
  'protons-loading',
  'sign-in',
  'sign-in-pending',
  'sign-in-opening',
  'sign-in-returning',
  'sign-in-failed',
  'sign-in-timed-out',
  'sign-in-email-off',
  'sign-in-google-only',
  'sign-in-mismatch',
  'legacy-sign-in',
  'settings-protons',
  'settings-google',
  'account-menu',
  'loaders',
  'crash',
  'crash-legacy'
] as const
export type PlaygroundView = (typeof PLAYGROUND_VIEWS)[number]

/**
 * The old app's own sign-in view, for comparison only: its real component over its real
 * account store, set to signed out with Google and passwords on. Loaded on demand so no
 * other view imports the old stores.
 */
const LegacySignIn = lazy(async () => {
  const [{ AtumAuthView }, { $atumAccountStatus }, { ATUM_SIGNED_OUT_IDENTITY_FIXTURE }] = await Promise.all([
    import('@/app/atum/auth-view'),
    import('@/store/atum-messaging'),
    import('@/lib/atum-account-facts')
  ])

  $atumAccountStatus.set({ ...ATUM_SIGNED_OUT_IDENTITY_FIXTURE.status, providers: { google: true, password: true } })

  return { default: () => <AtumAuthView /> }
})

/**
 * The sign-in window on its own, as the gate draws it; the ways in and Cancel move between
 * its states. `sign-in-failed` is a Google sign-in that did not finish (trying again is the
 * same button), `sign-in-timed-out` a browser trip left too long, `sign-in-email-off` a
 * server without passwords before main has learned it (email answers with its one sentence
 * instead of opening the browser), and `sign-in-google-only` the same server once main's
 * background check has learned it (production today): Google is the only way in.
 * `sign-in-mismatch` is another person's account over a session the sign-in server ended
 * (the `session-ended` scenario): its one sentence, then a quiet Sign out, confirmed in place.
 * `sign-in-returning` is the moment the browser is back and the window has come to the front:
 * the sign-in finishes here (`snapshot.signInReturned`). `sign-in-opening` is the moment before
 * the browser opens (a returning person's Atum account sign-in proves itself first:
 * `snapshot.signInBrowser`).
 */
function PlaygroundSignIn({ view }: { view: PlaygroundView }) {
  const [state, setState] = useState<MatrixSnapshot['state']>(
    view === 'sign-in-pending' || view === 'sign-in-returning' || view === 'sign-in-opening'
      ? 'signing_in'
      : view === 'sign-in-failed'
        ? 'error'
        : 'signed_out'
  )

  const [error, setError] = useState<string | null>(
    view === 'sign-in-failed'
      ? 'matrix_connection_failed'
      : view === 'sign-in-timed-out'
        ? 'matrix_login_timed_out'
        : view === 'sign-in-email-off'
          ? 'matrix_password_unavailable'
          : view === 'sign-in-mismatch'
            ? 'matrix_account_mismatch'
            : null
  )

  return (
    <MatrixSignIn
      attempted={view === 'sign-in-failed' || view === 'sign-in-mismatch' || state === 'error'}
      browser={view !== 'sign-in-opening'}
      email={
        view === 'sign-in-google-only' ||
        view === 'sign-in-mismatch' ||
        view === 'sign-in-returning' ||
        view === 'sign-in-opening'
          ? 'unavailable'
          : 'unknown'
      }
      error={state === 'signing_in' ? null : error}
      failed={false}
      onCancel={() => setState('signed_out')}
      onSignIn={(method: MatrixSignInMethod) => {
        if (view === 'sign-in-email-off' && method !== 'google') {
          setError('matrix_password_unavailable')

          return
        }

        setError(null)
        setState('signing_in')
      }}
      returned={view === 'sign-in-returning' && state === 'signing_in'}
      state={state}
    />
  )
}

const PHONE = { icon: <span aria-hidden className="inline-block size-4" />, label: 'Use on phone', onOpen: () => {} }

/** Settings and the account menu with the slots the runtime lane fills: phone and wallet. */
function PlaygroundAccount({ view }: { view: PlaygroundView }) {
  const [pane, setPane] = useState<MatrixSettingsPane>('protons')
  const snapshot = scenarioSnapshot('chat')

  if (view === 'account-menu') {
    return (
      <div className="p-6">
        <MatrixRailAccount
          balance={PLAYGROUND_WALLET}
          fail={() => {}}
          onOpenChange={() => {}}
          onOpenSettings={() => {}}
          onTopUp={() => {}}
          open
          phone={PHONE}
          snapshot={snapshot}
        />
      </div>
    )
  }

  return (
    <MatrixSettingsSheet
      fail={() => {}}
      onClose={() => {}}
      onPaneChange={setPane}
      open
      pane={pane}
      protons={{
        data: PLAYGROUND_WALLET,
        history: playgroundHistory(Date.now()),
        onLoadMore: () => {},
        onAbout: () => {},
        onTopUp: () => {}
      }}
      snapshot={snapshot}
    />
  )
}

/**
 * Parts of the window not wired in yet, on fixture data (dev only): Discover with a store
 * provider, the Protons pane, the account slots, and the sign-in window. `?view=` picks one; the app
 * scenarios stay in PLAYGROUND_SCENARIOS.
 */
export function PlaygroundGallery({ view }: { view: PlaygroundView }) {
  if (view === 'loaders') {
    return <PlaygroundLoaders />
  }

  if (view === 'crash') {
    return <MatrixCrashFallback reset={() => {}} />
  }

  // The engine's own fallback, for comparison only: what a crash showed before.
  if (view === 'crash-legacy') {
    return (
      <ErrorBoundary label="playground">
        <PlaygroundThrow />
      </ErrorBoundary>
    )
  }

  if (view.startsWith('awareness')) {
    return <AwarenessGallery key={view} view={view} />
  }

  if (view === 'legacy-sign-in') {
    return (
      <Suspense fallback={null}>
        <LegacySignIn />
      </Suspense>
    )
  }

  if (view.startsWith('sign-in')) {
    return <PlaygroundSignIn view={view} />
  }

  if (view === 'settings-protons' || view === 'account-menu') {
    return <PlaygroundAccount view={view} />
  }

  // Settings › Account › Google in the state `?google=` names (google-fixtures.tsx).
  if (view === 'settings-google') {
    return <PlaygroundGoogleSettings />
  }

  if (view.startsWith('protons')) {
    const data: ProtonsWalletData = view === 'protons-loading' ? { state: 'loading', wallet: null } : PLAYGROUND_WALLET

    return (
      <div className="mx-auto w-full max-w-[32.5rem] overflow-y-auto px-6 py-10">
        <MatrixProtonsPane
          data={data}
          history={
            view === 'protons'
              ? playgroundHistory(Date.now())
              : { entries: [], error: false, loading: false, next: null }
          }
          onAbout={() => {}}
          onLoadMore={() => {}}
          onTopUp={() => {}}
        />
      </div>
    )
  }

  return <PlaygroundStorefront view={view} />
}

/**
 * Discover with the simulated store, wallet and checkout (dev only): buying spends the
 * fixture balance or is refused for too few Protons, a pack shows its QR, and
 * `__atumPlaygroundCommerce.pay()` pays it. `?balance=` and `?order=` start elsewhere.
 */
function PlaygroundStorefront({ view }: { view: PlaygroundView }) {
  const [shelf, setShelf] = useState<DiscoverShelf>('featured')
  const [query, setQuery] = useState('')
  const [commerce] = useState(() => {
    const instance = new PlaygroundCommerce(playgroundCommerceOptions(new URLSearchParams(location.search)))
    Object.assign(window, { __atumPlaygroundCommerce: instance })

    return instance
  })

  const [, setRevision] = useState(0)
  useEffect(() => commerce.subscribe(() => setRevision(value => value + 1)), [commerce])
  const storeBridge = useMemo(() => commerce.storeBridge(), [commerce])
  const checkoutBridge = useMemo(() => commerce.checkoutBridge(), [commerce])

  const store: DiscoverStore = {
    snapshot: {
      ...commerce.store,
      state: view === 'store-loading' ? 'loading' : view === 'store-unavailable' ? 'unavailable' : commerce.store.state
    },
    onRetry: () => {},
    onAcquire: item =>
      item.offer
        ? storeBridge.purchase({ offerId: item.offer.id, offerVersion: item.offer.version })
        : Promise.resolve({ outcome: 'uncertain' as const }),
    onCancel: id => storeBridge.cancel(id),
    onResume: async () => ({ outcome: 'uncertain' })
  }

  return (
    <div className="flex min-h-0 flex-1">
      <MatrixStoreSidebar onQueryChange={setQuery} onShelfChange={setShelf} query={query} shelf={shelf} />
      <MatrixDiscoverView
        agents={[
          {
            principal: PLAYGROUND_ASSISTANT,
            userId: '@playground:example.test',
            assistantId: PLAYGROUND_ASSISTANT,
            name: 'Atum',
            isDefault: true,
            ready: true,
            hermes: 'ready',
            atumModel: true
          },
          {
            principal: 'agent-moon',
            userId: '@moon:example.test',
            assistantId: '00000000-0000-4000-8000-e79acd97ac88',
            name: 'Moon',
            isDefault: false,
            ready: true,
            hermes: 'ready',
            atumModel: true
          }
        ]}
        apps={{ state: view === 'store-unavailable' ? 'unavailable' : 'ready', items: [], onRetry: () => {} }}
        checkout={{
          snapshot: commerce.checkout,
          onRefresh: () => {},
          onStart: packId => checkoutBridge.start(packId),
          onStatus: () => checkoutBridge.status(),
          onResume: () => checkoutBridge.resume(),
          onOpenCheckout: () => checkoutBridge.openCheckout(),
          onDismissTerminal: () => checkoutBridge.dismissTerminal()
        }}
        onShelfChange={setShelf}
        query={query}
        shelf={shelf}
        store={store}
        tryItem={() => () => {}}
        wallet={commerce.wallet}
      />
    </div>
  )
}

export function isPlaygroundView(value: string | null): value is PlaygroundView {
  return (
    (PLAYGROUND_VIEWS as readonly string[]).includes(value ?? '') &&
    !(PLAYGROUND_SCENARIOS as readonly string[]).includes(value ?? '')
  )
}

/**
 * Every wait the window draws (dev only), per the Kit (packages/atum-kit/STYLE.md §10, §12): the
 * Kit spinner at its two sizes for anything the app is waiting on, and the atom only for the
 * assistant at work.
 */
function PlaygroundLoaders() {
  const sizes = ['size-3.5', 'size-4', 'size-5'] as const

  const inks = [
    'text-(--atum-ink)',
    'text-(--atum-ink-soft)',
    'text-(--atum-ink-muted)',
    'text-(--atum-ink-faint)'
  ] as const

  return (
    <div className="flex flex-col gap-6 p-10" data-playground-loaders>
      <div className="flex items-center gap-6">
        <Loader label="Loading" size="sm" />
        <Loader label="Loading" />
        <span className="grid size-16 place-items-center rounded-(--atum-r-card) bg-(--atum-sunk)">
          <Loader label="Loading" />
        </span>
        <span className="text-xs text-(--atum-ink-muted)">Loader · sm · lg · lg in a state mark</span>
      </div>
      <div className="flex items-center gap-6 text-(--atum-ink-muted)">
        {sizes.map(size => (
          <Spinner className={`${size} animate-spin`} key={size} />
        ))}
        <span className="text-xs">Spinner in a row or button (currentColor)</span>
      </div>
      {inks.map(ink => (
        <div className={`flex items-center gap-6 ${ink}`} key={ink}>
          {sizes.map(size => (
            <AtumAtom className={size} key={size} />
          ))}
          <span className="text-xs">AtumAtom, the assistant at work · {ink}</span>
        </div>
      ))}
    </div>
  )
}

function PlaygroundThrow(): never {
  throw new Error("Cannot read properties of undefined (reading 'roomId')")
}
