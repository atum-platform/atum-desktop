import { useStore } from '@nanostores/react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { NoticeBand } from '@/components/ui/error-state'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { $atumAppCatalog, appDisplayName, appSubtitle, appSupportsDirect, refreshAtumAppCatalog } from '@/lib/atum-app-catalog'
import { atumAppSurfaceClient, isAppSurfaceFailure } from '@/lib/atum-app-surfaces'
import type { AtumSocialProjection } from '@/lib/atum-messaging-client'
import { Search } from '@/lib/icons'
import { cn } from '@/lib/utils'
import {
  $atumAccountScopeId,
  $atumAccountStatus,
  $atumSortedRoster,
  ensureAtumSpecialistConversation,
  lookupAtumSocial,
  mutateAtumSocial
} from '@/store/atum-messaging'
import { $discoverShelf, $discoverShelfNonce, $railDestination, type AtumDiscoverShelf } from '@/store/atum-shell'

import { PetStoreView } from '../pets'
import { dmRoute } from '../routes'

import { DiscoverAgentsSection } from './discover-agents-section'
import { DiscoverPetsSection } from './discover-pets-section'
import { DiscoverSkillsSection } from './discover-skills-section'
import { AtumMainHeader } from './main-header'

/**
 * Discover — the storefront. One store, six shelves, one shelf at a time.
 *
 * It replaces the old `discover` boolean inside the roster, which hijacked the
 * chat search box and stacked two unrelated things under it. That mode read as
 * nothing in particular because it was nothing in particular: a filter state
 * pretending to be a destination.
 *
 * The switcher's state is PANEL state, initialized from the `$discoverShelf`
 * arrival intent (the `$rosterShownOnDiscover` shape): whoever sent the user
 * here seeds it, the panel owns it from there, and switching shelves never
 * writes the atom back — a docked route-tile pane reads its shelf identity
 * from its path, so a shelf switch here must not retarget anything. An intent
 * planted while the panel is already open (a `/pets` deep link, an entry
 * point that finds Discover showing) is adopted like a fresh arrival.
 *
 * The shelves, in App Store order, because they answer different questions:
 *
 *   Featured — the cross-catalog mix: curated skills and pets. The one shelf
 *            that shows more than one kind of thing.
 *   Agents   — monthly hiring, existing employees and renewal controls.
 *   Skills   — the store's catalog rows: what the owner publishes, priced and
 *            owned per account, with a "Manage installed →" link out to
 *            Capabilities: acquiring lives here, managing stays there.
 *   Apps     — the server-approved account catalog, shown in full including
 *            registrations that are not ready yet (labelled as such, never
 *            hidden, never fake-clickable).
 *   Pets     — the Pet Store itself: shelves, the Meet stage, the hatch,
 *            unchanged, rendered in place.
 *   People   — a SEARCH, not a list. The platform has no endpoint that browses,
 *            lists or suggests people: `social_lookup` resolves one profile
 *            from a query of three characters or more, and `social_sync` only
 *            returns your own relationships. Showing a "directory" would be
 *            inventing a capability, so this section says plainly that you
 *            find someone by their exact @name.
 *
 * Search stays per-shelf, and that is a decision, not an oversight: the Pets
 * shelf filters a loaded gallery locally (instant, offline), while People is a
 * rate-limited network lookup with failure states. One box would spend the
 * user's rate limit on keystrokes meant for a local filter.
 */

/** The catalog id a hosted conversation belongs to. Mirrors the roster's own
 *  reading of the payload: the server sends `specialist`, older rows only a
 *  title, and neither is guaranteed to be a string. */
function appIdOf(row: { payload?: Record<string, unknown> | null; title?: null | string }): string {
  const specialist = row.payload?.specialist

  return (typeof specialist === 'string' && specialist.trim() ? specialist : (row.title ?? '')).toLowerCase()
}

type RemotePerson = AtumSocialProjection | null
type RemoteState = 'idle' | 'searching' | 'none' | 'result' | 'failed' | 'rate-limited'

/** The shelf switcher's rows. Labels come from copy at render; `soon` marks a
 *  shelf that is drawn and labelled but not a real surface yet — rendered
 *  `aria-disabled` with the tip as its explanation, never clickable. */
interface ShelfTab {
  id: AtumDiscoverShelf
  label: string
  soon?: string
}

export function AtumDiscoverPanel() {
  const { locale, t } = useI18n()
  const account = useStore($atumAccountStatus)
  const conversations = useStore($atumSortedRoster)
  const accountId = useStore($atumAccountScopeId)
  const catalog = useStore($atumAppCatalog)
  const navigate = useNavigate()
  const searchTicket = useRef(0)
  const [query, setQuery] = useState('')
  const [remoteState, setRemoteState] = useState<RemoteState>('idle')
  const [remotePerson, setRemotePerson] = useState<RemotePerson>(null)
  const [rateLimitSeconds, setRateLimitSeconds] = useState(0)
  const [openingApp, setOpeningApp] = useState<null | string>(null)
  const [appOpenFailed, setAppOpenFailed] = useState<null | string>(null)

  const signedIn = account.state === 'signed_in' || account.state === 'refreshing'
  const copy = t.atum.discover

  // Shelf state is panel state, seeded from the arrival intent. The atom is
  // not panel truth: switching shelves never writes it back.
  const seed = useStore($discoverShelf)
  const seedNonce = useStore($discoverShelfNonce)
  const [shelf, setShelf] = useState<AtumDiscoverShelf>(seed)
  const adoptedNonce = useRef(seedNonce)

  useEffect(() => {
    // A NEW intent planted while the panel is open (a one-shot deep link, or an
    // entry point that finds Discover already showing) is an arrival too —
    // adopt it. The NONCE is the signal, not the seed value: nanostores skips
    // an unchanged set, so re-opening the shelf the seed already holds (the
    // user switched away meanwhile) only ever arrives as a nonce bump.
    if (seedNonce !== adoptedNonce.current) {
      adoptedNonce.current = seedNonce
      setShelf($discoverShelf.get())
    }
  }, [seedNonce])

  const shelfTabs: ShelfTab[] = [
    { id: 'featured', label: copy.featuredSection },
    { id: 'agents', label: copy.agentsSection },
    { id: 'skills', label: copy.skillsSection },
    { id: 'apps', label: copy.appsSection },
    { id: 'pets', label: copy.petsSection },
    { id: 'people', label: copy.peopleSection }
  ]

  useEffect(() => {
    if (!signedIn || !accountId) {
      return
    }

    void refreshAtumAppCatalog(accountId).catch(() => {})
  }, [signedIn, accountId])

  useEffect(() => {
    // Editing the query abandons the in-flight lookup as well as its result.
    searchTicket.current += 1
    setRemoteState('idle')
    setRemotePerson(null)
  }, [query])

  useEffect(() => {
    if (remoteState !== 'rate-limited' || rateLimitSeconds <= 0) {
      return
    }

    const timer = window.setInterval(() => setRateLimitSeconds(value => Math.max(0, value - 1)), 1_000)

    return () => window.clearInterval(timer)
  }, [rateLimitSeconds, remoteState])

  // The field asks for an "@name", so the @ is part of what people type. It is
  // not part of the handle, and the lookup matches handles exactly.
  const handle = query.trim().replace(/^@+/u, '')

  // `social_lookup` refuses anything under three characters upstream; saying so
  // before the round trip is kinder than spending the user's rate limit on it.
  const queryIsSearchable = handle.length >= 3

  const searchRemote = async () => {
    // A lookup already in flight for this query would only race with itself.
    if (!queryIsSearchable || remoteState === 'searching') {
      return
    }

    // Two searches can be in flight at once — type "alice", hit Enter, change
    // to "bob", hit Enter. Whichever RESOLVES last would otherwise win, and
    // that is not necessarily the one the user is waiting for. Only the newest
    // request is allowed to write state.
    const ticket = (searchTicket.current += 1)

    setRemoteState('searching')

    try {
      const person = await lookupAtumSocial(handle)

      if (ticket !== searchTicket.current) {
        return
      }

      setRemotePerson(person)
      setRemoteState(person?.availability === 'available' ? 'result' : 'none')
    } catch (error) {
      if (ticket !== searchTicket.current) {
        return
      }

      const message = error instanceof Error ? error.message : ''

      if (message.includes('rate') || message.includes('429')) {
        setRateLimitSeconds(60)
        setRemoteState('rate-limited')
      } else {
        setRemoteState('failed')
      }
    }
  }

  const actOnPerson = async (
    person: NonNullable<RemotePerson>,
    requestedAction?: 'request' | 'accept' | 'decline' | 'block' | 'unblock'
  ) => {
    if (person.availability !== 'available') {
      return
    }

    try {
      const action =
        requestedAction ??
        (person.state === 'incoming_pending' ? 'accept' : person.state === 'blocked_by_me' ? 'unblock' : 'request')

      const next =
        person.state === 'connected' && !requestedAction
          ? person
          : await mutateAtumSocial(action, person.profile.profileId)

      if (next?.availability === 'available' && next.directThreadId && next.canMessage) {
        $railDestination.set('chat')
        navigate(dmRoute(next.directThreadId))
      } else if (next) {
        setRemotePerson(next)
      }
    } catch {
      setRemoteState('failed')
    }
  }

  const openApp = async (appId: string, conversationId: null | string) => {
    if (conversationId) {
      $railDestination.set('chat')
      navigate(dmRoute(conversationId))

      return
    }

    if (openingApp || !signedIn) {
      return
    }
    setOpeningApp(appId)
    setAppOpenFailed(null)

    try {
      if (!accountId) {
        return
      }
      const app = $atumAppCatalog.get().accountId === accountId
        ? $atumAppCatalog.get().apps.find(entry => entry.app === appId)
        : undefined
      if (!appSupportsDirect(app)) {
        throw new Error('app_unavailable')
      }
      if (app!.link.mode === 'external_account' && app!.link.state !== 'linked') {
        const started = await atumAppSurfaceClient().connectStart(appId)

        if (isAppSurfaceFailure(started)) {
          throw new Error('app_connection_failed')
        }

        if ($atumAccountScopeId.get() !== accountId) {
          return
        }
      }

      const ensured = await ensureAtumSpecialistConversation(appId)
      $railDestination.set('chat')
      navigate(dmRoute(ensured))
    } catch (error) {
      // An account switch invalidates the previous account's in-flight ensure;
      // the new account must not inherit a false failure from it.
      if (
        $atumAccountScopeId.get() === accountId &&
        !(error instanceof Error && error.message === 'atum_account_changed')
      ) {
        setAppOpenFailed(appId)
      }
    } finally {
      setOpeningApp(null)
    }
  }

  const apps = catalog.accountId === accountId ? catalog.apps.map(app => ({
    app, conversationId: conversations.find(row => appIdOf(row) === app.app)?.id ?? null, id: app.app
  })) : []

  return (
    <section
      aria-label={copy.title}
      className="relative flex min-w-0 flex-1 flex-col overflow-hidden [-webkit-app-region:no-drag]"
      data-atum-discover
    >
      <AtumMainHeader>
        <AtumDiscoverIdentity />
      </AtumMainHeader>
      <div className="shrink-0 px-10 pt-4">
        <nav aria-label={copy.shelvesAria} className="mx-auto flex w-full max-w-[47.5rem] flex-wrap items-center gap-2" data-atum-shelf-switch>
          {shelfTabs.map(tab => {
            // A `soon` shelf is drawn and labelled but is not a surface yet:
            // `aria-disabled` rather than `disabled` so the tip still explains
            // what it will be — and with no onClick it can never pretend.
            if (tab.soon) {
              return (
                <Tip key={tab.id} label={tab.soon}>
                  <button
                    aria-disabled="true"
                    aria-label={tab.label}
                    className="cursor-default rounded-full bg-(--atum-hover) px-3.5 py-[7px] text-(length:--atum-t-control) font-medium text-(--atum-ink) opacity-70"
                    data-atum-shelf={tab.id}
                    type="button"
                  >
                    {tab.label}
                  </button>
                </Tip>
              )
            }

            return (
              <button
                aria-current={shelf === tab.id ? 'page' : undefined}
                className={cn(
                  'rounded-full px-3.5 py-[7px] text-(length:--atum-t-control) font-medium transition-colors',
                  shelf === tab.id
                    ? 'bg-(--atum-ink) text-(--atum-on-accent)'
                    : 'bg-(--atum-hover) text-(--atum-ink) hover:bg-(--atum-pressed)'
                )}
                data-atum-shelf={tab.id}
                key={tab.id}
                onClick={() => setShelf(tab.id)}
                type="button"
              >
                {tab.label}
              </button>
            )
          })}
        </nav>
      </div>
      {shelf === 'pets' ? (
        // The Pet Store, in place: shelves, the Meet stage, the hatch and the
        // celebration are PR #268's, moved here unchanged — not rewritten.
        <PetStoreView />
      ) : (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[47.5rem] flex-col gap-10 px-10 pb-10 pt-6">
          {shelf === 'featured' && (
            <>
              <DiscoverSkillsSection part="featured" />
              <DiscoverPetsSection onOpenStore={() => setShelf('pets')} />
            </>
          )}
          {shelf === 'agents' && <DiscoverAgentsSection />}
          {shelf === 'skills' && <DiscoverSkillsSection part="skills" />}

          {shelf === 'apps' && (
          <div>
            <div className="mb-3.5 text-(length:--atum-t-label) font-semibold uppercase tracking-[0.06em] text-(--atum-ink-faint)">
              {copy.appsSection}
            </div>
            <div className="grid grid-cols-3 gap-3.5" data-atum-app-catalog-state={catalog.accountId === accountId ? catalog.state : 'idle'} data-testid="discover-apps">
              {apps.map(({ app, conversationId, id }) => {
                const available = Boolean(conversationId) || appSupportsDirect(app)
                const unavailable = !available
                const checking = catalog.state === 'loading'
                const connect = app.link.mode === 'external_account' && app.link.state !== 'linked'
                const busy = openingApp === id

                // The whole card is the control (one click target, one label);
                // the pill inside is its visible call to action. An app that is
                // not ready is drawn at 70% with "coming soon" and disabled —
                // labelled, never hidden, never fake-clickable.
                return (
                  <button
                    aria-busy={busy || undefined}
                    className={cn(
                      'atum-glass-card flex flex-col gap-3.5 rounded-[var(--atum-r-group)] p-[1.125rem] text-left transition-colors',
                      available ? 'hover:bg-(--atum-glass-strong)' : 'cursor-default opacity-70'
                    )}
                    data-discover-app={id}
                    disabled={
                      !available || busy || checking || (!conversationId && (!signedIn || Boolean(unavailable)))
                    }
                    key={id}
                    onClick={() => void openApp(id, conversationId)}
                    type="button"
                  >
                    <img
                      alt=""
                      className="atum-avatar size-12 object-cover"
                      data-face="app"
                      src={app.icon?.url}
                    />
                    <span className="block">
                      <span className="block text-[0.9375rem] font-semibold text-(--atum-ink)">{appDisplayName(app, locale)}</span>
                      <span className="mt-[3px] block text-(length:--atum-t-control) leading-[1.45] text-(--atum-ink-muted)">
                        {appSubtitle(app, locale)}
                      </span>
                    </span>
                    <span className="mt-auto flex items-center justify-between gap-2">
                      <span className="text-(length:--atum-t-body) text-(--atum-ink-faint)">
                        {app.verified ? t.atum.roster.badgeFirstParty : t.atum.roster.badgePartner}
                      </span>
                      {!available ? (
                        <span className="text-(length:--atum-t-control) text-(--atum-ink-faint)">
                          {copy.comingSoon}
                        </span>
                      ) : (
                        <span
                          className={cn(
                            'rounded-full px-3.5 py-[7px] text-(length:--atum-t-control) font-medium',
                            conversationId
                              ? 'bg-(--atum-hover) text-(--atum-ink)'
                              : 'bg-(--atum-ink) text-(--atum-on-accent)'
                          )}
                        >
                          {conversationId
                            ? copy.open
                              : unavailable ? copy.comingSoon
                              : checking
                                ? t.dm.connect.checking
                                : connect
                                  ? t.dm.connect.connect
                                  : copy.open}
                        </span>
                      )}
                    </span>
                  </button>
                )
              })}
            </div>
            {catalog.state === 'loading' && <p className="mt-2 text-(length:--atum-t-body) text-(--atum-ink-muted)" role="status">{t.dm.connect.checking}</p>}
            {catalog.state === 'stale' && <p className="mt-2 text-(length:--atum-t-body) text-(--atum-ink-muted)" role="status">{copy.appsStale}</p>}
            {catalog.state === 'ready' && apps.length === 0 && <p className="mt-2 text-(length:--atum-t-body) text-(--atum-ink-muted)" role="status">{copy.appsEmpty}</p>}
            {catalog.state === 'error' && <NoticeBand className="mt-2" role="alert">{t.dm.connect.retryStatus}</NoticeBand>}
            {appOpenFailed && (
              <NoticeBand className="mt-2" role="alert">
                {t.atum.roster.openAppFailed}
              </NoticeBand>
            )}
          </div>
          )}

          {shelf === 'people' && (
          <div>
            <div className="mb-3 text-(length:--atum-t-label) font-semibold uppercase tracking-[0.06em] text-(--atum-ink-faint)">
              {copy.peopleSection}
            </div>
            {/* Said plainly: people are FOUND, not browsed. There is no endpoint
                that lists them, and an empty "directory" would read as broken. */}
            <p className="text-(length:--atum-t-control) leading-[1.5] text-(--atum-ink-muted)">{copy.peopleHint}</p>

            {signedIn ? (
              <div className="mt-3" data-testid="discover-people">
                <form
                  className="mb-3 flex h-12 items-center gap-2.5 rounded-[var(--atum-r-group)] bg-(--atum-composer) px-4 text-[0.9375rem] shadow-(--atum-glass-shadow) backdrop-blur-[1.875rem] backdrop-saturate-[1.4]"
                  data-atum-discover-search
                  onSubmit={event => {
                    event.preventDefault()
                    void searchRemote()
                  }}
                >
                  <Search aria-hidden className="size-4 shrink-0 text-(--atum-ink-faint)" />
                  <input
                    aria-label={copy.placeholder}
                    className="min-w-0 flex-1 bg-transparent text-(--atum-ink) outline-none placeholder:text-(--atum-ink-faint)"
                    onChange={event => setQuery(event.target.value)}
                    placeholder={copy.placeholder}
                    value={query}
                  />
                </form>
                {remoteState === 'idle' && query.trim() && !queryIsSearchable && (
                  <p className="text-(length:--atum-t-body) text-(--atum-ink-muted)">{copy.tooShort}</p>
                )}
                {remoteState === 'idle' && queryIsSearchable && (
                  <button
                    className="rounded-full bg-(--atum-hover) px-3.5 py-[7px] text-left text-(length:--atum-t-control) font-medium text-(--atum-ink) hover:bg-(--atum-pressed)"
                    onClick={() => void searchRemote()}
                    type="button"
                  >
                    {copy.searchAtum} “{handle}”
                  </button>
                )}
                {remoteState === 'searching' && (
                  <p className="text-(length:--atum-t-body) text-(--atum-ink-muted)" role="status">
                    {copy.searching}
                  </p>
                )}
                {remoteState === 'none' && (
                  <p className="text-(length:--atum-t-body) text-(--atum-ink-muted)">{copy.none}</p>
                )}
                {remoteState === 'rate-limited' && (
                  <p className="text-(length:--atum-t-body) text-(--atum-ink-muted)" role="status">
                    {copy.rateLimited(rateLimitSeconds)}
                  </p>
                )}
                {remoteState === 'failed' && (
                  <div className="flex items-center gap-2">
                    <p className="min-w-0 flex-1 text-(length:--atum-t-body) text-(--atum-ink-muted)" role="alert">
                      {copy.failed}
                    </p>
                    <button
                      className="shrink-0 text-(length:--atum-t-control) text-(--atum-ink-muted) underline underline-offset-2 hover:text-(--atum-ink)"
                      onClick={() => void searchRemote()}
                      type="button"
                    >
                      {t.common.retry}
                    </button>
                  </div>
                )}
                {remoteState === 'result' && remotePerson?.availability === 'available' && (
                  <div className="atum-glass-card flex w-full items-center gap-3.5 rounded-[var(--atum-r-group)] px-[1.125rem] py-3.5">
                    <span className="atum-avatar grid size-12 shrink-0 place-items-center bg-(--atum-sunk) text-[0.9375rem] font-semibold text-(--atum-ink-soft)">
                      {remotePerson.profile.displayName.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[0.9375rem] font-semibold text-(--atum-ink)">
                        {remotePerson.profile.displayName}
                        {remotePerson.profile.verified ? ' ✓' : ''}
                      </span>
                      <span className="block truncate text-(length:--atum-t-control) text-(--atum-ink-muted)">
                        @{remotePerson.profile.handle}
                      </span>
                    </span>
                    <button
                      className="shrink-0 rounded-full bg-(--atum-ink) px-3.5 py-[7px] text-(length:--atum-t-control) font-medium text-(--atum-on-accent) hover:bg-(--atum-ink-soft)"
                      onClick={() => void actOnPerson(remotePerson)}
                      type="button"
                    >
                      {remotePerson.state === 'incoming_pending'
                        ? copy.accept
                        : remotePerson.state === 'blocked_by_me'
                          ? copy.unblock
                          : remotePerson.state === 'connected'
                            ? copy.openChat
                            : copy.connect}
                    </button>
                    {remotePerson.state === 'incoming_pending' && (
                      <button
                        className="shrink-0 text-(length:--atum-t-control) text-(--atum-ink-muted) hover:text-(--atum-ink)"
                        onClick={() => void actOnPerson(remotePerson, 'decline')}
                        type="button"
                      >
                        {copy.decline}
                      </button>
                    )}
                    {remotePerson.state === 'connected' && (
                      <button
                        className="shrink-0 text-(length:--atum-t-control) text-(--atum-ink-muted) hover:text-(--atum-ink)"
                        onClick={() => void actOnPerson(remotePerson, 'block')}
                        type="button"
                      >
                        {copy.block}
                      </button>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <p className="mt-3 text-(length:--atum-t-control) text-(--atum-ink-muted)">{copy.signedOut}</p>
            )}
          </div>
          )}
        </div>
      </div>
      )}
    </section>
  )
}

/**
 * Discover's identity, on the main column's top row (`main-header.tsx`).
 *
 * The mock's workspace-open control is deliberately absent: Discover owns the
 * whole main column (the shell hides the workspace while it shows), so the
 * control would open nothing.
 */
export function AtumDiscoverIdentity() {
  const { t } = useI18n()
  const copy = t.atum.discover

  return (
    <div className="flex min-w-0 max-w-full items-baseline gap-2" data-atum-discover-header>
      <h1 className="shrink-0 text-[0.875rem] leading-[1.3] font-semibold text-(--atum-ink)">{copy.title}</h1>
      <p className="min-w-0 truncate text-[0.8125rem] leading-[1.3] text-(--atum-ink-faint)">{copy.subtitle}</p>
    </div>
  )
}
