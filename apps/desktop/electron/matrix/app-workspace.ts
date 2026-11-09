import {
  appBotDisclosureVersion,
  type AppCatalog,
  type AppDescriptor,
  appLocalizedCopy,
  parseAppCatalog,
  parseAppDescriptor
} from '../../shared/app-catalog'
import { type MatrixAppHistoryPage, parseMatrixAppHistoryPage } from '../../shared/app-history'
import { decodeAppPanel } from '../../shared/app-panel'
import {
  type AppManifestResponse,
  AppSurfaceError,
  parseAppLaunchIssue,
  parseAppManifestResponse,
  parseBotPanelStatus
} from '../../shared/app-view/protocol'
import type { DesktopLocale } from '../../shared/desktop-locale'
import { decodeLookGallery, type LookPackPublished } from '../../shared/look-pack'
import type { MatrixAppMenu, MatrixAppWorkspace } from '../../shared/matrix'
import { appBotOpenRefusal } from '../../shared/matrix-app-bot-failure'
import type { AppViewController } from '../app-view/controller'

import type { MatrixAccount } from './account'
import type { AppAuthSheetRequest } from './app-auth-sheet'
import { appBotConsentStands } from './app-bots/authority'
import { type AppConnectionBeginOptions, createAppConnection } from './app-connection'
import { appIcon, type AppIconCache } from './app-icon'
import { appCatalogLogLine, appCatalogPartialLogLine } from './app-link-log'
import type { MatrixLookAssets } from './look-asset'

/**
 * Gaps between background re-reads of a catalog that could not be read. One failed read at launch
 * (the platform answers 503 for the whole list when any one app is momentarily unavailable) used to
 * leave Moon's and Andy's rows, "+" menu and panel dead until the next restart; the last gap repeats.
 */
const CATALOG_RETRY_MS = [5_000, 15_000, 30_000, 60_000, 120_000] as const

/**
 * The catalog is read when the person signs in and after a link changes. A window that stays
 * open for days (the owner's ran three) never saw an app published since, nor a bot that came
 * back, until the next restart. `revalidate` looks again when the window returns to the front,
 * and at most this often: the read is charged to the same hourly bucket as every other app read.
 */
const REVALIDATE_MS = 5 * 60_000

/**
 * Every app read is charged to a per-principal hourly bucket shared by the catalog, manifests,
 * bot status and launches. Renderer snapshot emissions re-ask for the same menu object many
 * times a minute, so one manifest answer serves the "+" menu and the panel for this long, and
 * concurrent asks share a single Shell read.
 */
const WORKSPACE_TTL_MS = 5 * 60_000
const RATE_LIMIT_FALLBACK_MS = 30_000
const RATE_LIMIT_MAX_WAIT_MS = 10 * 60_000

type Scope = { accountKey: string; generation: number }

const same = (a: Scope | null, b: Scope | null) =>
  Boolean(a && b && a.accountKey === b.accountKey && a.generation === b.generation)

/**
 * The last good catalog with one look's answer laid over it. A look can add and update; it
 * can never withdraw. The platform answers 200 with the apps it could read and leaves out one it
 * could not (`matrix-app-workspace.ts`: "one momentarily unreadable app must not blank the whole
 * roster"), and `atum.app-catalog/1` has no tombstone and no completeness marker, so an app the
 * answer leaves out is only unheard from: it stays as last read. The one exception is an app whose
 * slug the answer gives to another id, which is a replacement; it is dropped, and `refresh`
 * withdraws it as it would at sign-in. Previous order is kept; new apps follow in answer order.
 */
function lookedCatalog(
  previous: readonly AppDescriptor[],
  answer: readonly AppDescriptor[]
): { apps: AppDescriptor[]; kept: AppDescriptor[] } {
  const byId = new Map(answer.map(app => [app.app_id, app]))
  const slugs = new Set(answer.map(app => app.app))
  const known = new Set(previous.map(app => app.app_id))
  const kept: AppDescriptor[] = []

  const apps = previous.flatMap(app => {
    const updated = byId.get(app.app_id)

    if (updated) {
      return [updated]
    }

    if (slugs.has(app.app)) {
      return []
    }

    kept.push(app)

    return [app]
  })

  return { apps: [...apps, ...answer.filter(app => !known.has(app.app_id))], kept }
}

/** Always attempt every independent withdrawal, but never conceal a failure. */
async function drainWithdrawals(operations: Array<Promise<unknown> | undefined>) {
  const results = await Promise.allSettled(operations)
  const failed = results.find(result => result.status === 'rejected')

  if (failed?.status === 'rejected') {
    throw failed.reason
  }
}

/** Composition of existing authorities, not another registry/session engine. */
export function createMatrixApps(deps: {
  account: Pick<MatrixAccount, 'readDomain' | 'appScope' | 'appRequest'> &
    Partial<Pick<MatrixAccount, 'lookGalleryRequest'>>
  views: () => AppViewController
  resource: string
  openExternal(url: string): Promise<void>
  /** Production app authentication sheet. Tests/older composition may retain openExternal. */
  openAuthorize?(request: AppAuthSheetRequest): Promise<{ close(): void }>
  locale?(): DesktopLocale
  changed(): void
  catalogChanged(ids: string[]): Promise<unknown>
  stopParticipants?(slug?: string): Promise<void>
  withdrawParticipant?(slug: string): Promise<void>
  reconcileParticipants?(apps: AppDescriptor[], active: () => boolean): Promise<void>
  /** Closed-code main.log lines for the app-link flow (app-link-log.ts). */
  log?(line: string): void
  /** Icons each account fetched once, so later launches show them with no network. */
  iconCache?: { forAccount(accountKey: string): AppIconCache | null }
  /** Separate 64 MiB digest cache and privileged protocol source for look assets. */
  lookAssets?: Pick<MatrixLookAssets, 'adopt' | 'prefetchFull' | 'reset'>
  /** The sign-in browser came back to Atum. */
  returned?(): void
  /** Runs `run` once after `ms`; the returned function cancels it. Without it, a failed catalog read is not retried. */
  schedule?(run: () => void, ms: number): () => void
  /**
   * A fresh read of this account's bot status for an app (atum.app-bot-status/1). The setup
   * card's link confirms by itself only while it shows consent; without it the card's flow
   * never confirms by itself.
   */
  botStatus?(slug: string): Promise<unknown>
}) {
  let scope: Scope | null = null
  let revision = 0
  let status: MatrixAppWorkspace['state'] = 'loading'
  let apps: AppDescriptor[] = []
  let gallery: LookPackPublished[] = []
  let refreshing = false
  let connection: ReturnType<typeof createAppConnection> | undefined
  let resetPending: Promise<void> | undefined
  const icons = new Map<string, string | null>()
  const botIcons = new Map<string, string | null>()
  const appRevisions = new Map<string, number>()
  // An unknown unlink result must not let an old linked catalog undo the
  // person's withdrawal. Only a fresh, explicitly confirmed connection can
  // release this account-local fence; it is not provider account deletion.
  const withdrawn = new Set<string>()
  const confirmed = new Set<string>()
  let cancelRetry: (() => void) | undefined
  let retries = 0
  let lastCatalogLog = ''
  // When `revalidate` last looked, and how many catalogs `refresh` had adopted by then: a look
  // that another adoption overtook while it read is out of date and is dropped.
  let lastLook = 0
  let adoptions = 0
  let lastPartialLog = ''

  // Keyed by (slug, app id, app version): a new version must never be answered from an old read.
  const workspaceCache = new Map<
    string,
    { at: number; value: { app: AppDescriptor; surface: AppManifestResponse } }
  >()

  const workspaceReads = new Map<string, Promise<{ app: AppDescriptor; surface: AppManifestResponse }>>()
  const botStatusReads = new Map<string, Promise<unknown>>()
  /** The bucket is shared, so the platform's wait applies to every app read this account makes. */
  let readsLimitedUntil = 0

  function clearRetry() {
    cancelRetry?.()
    cancelRetry = undefined
  }

  /** The delay a background re-read was set for, or null when none is (no scheduler, or already pending). */
  function scheduleRetry(): number | null {
    const scheduledFor = deps.account.appScope()

    if (!deps.schedule || cancelRetry || !scheduledFor) {
      return null
    }

    const delay = CATALOG_RETRY_MS[Math.min(retries, CATALOG_RETRY_MS.length - 1)]!
    retries++

    cancelRetry = deps.schedule(() => {
      cancelRetry = undefined

      // The account may have signed out or switched while this waited; reading then would
      // reach a domain this retry was never meant for. The next sign-in reads once itself.
      if (!same(scheduledFor, deps.account.appScope())) {
        return
      }

      void refresh(false, true).catch(() => {})
    }, delay)

    return delay
  }

  /** One line per change of outcome, so a steady outage is a line, not a flood. */
  function logCatalog(result: Parameters<typeof appCatalogLogLine>[0]) {
    const line = appCatalogLogLine(result)
    const key = line.replace(/retry=\S+/u, '')

    if (key !== lastCatalogLog) {
      lastCatalogLog = key
      deps.log?.(line)
    }
  }

  function invalidateApp(slug: string) {
    appRevisions.set(slug, (appRevisions.get(slug) ?? 0) + 1)
    connection?.cancel(slug)
    confirmed.delete(slug)
  }

  function requireCurrentApp(slug: string, ticket: number) {
    if (withdrawn.has(slug)) {
      throw new AppSurfaceError('unlinked')
    }

    if ((appRevisions.get(slug) ?? 0) !== ticket) {
      throw new AppSurfaceError('app_version_incompatible')
    }
  }

  async function request(...args: Parameters<MatrixAccount['appRequest']>) {
    const owner = scope

    try {
      return await deps.account.appRequest(...args)
    } catch (error) {
      if (owner === scope && error instanceof AppSurfaceError && error.code === 'account_unavailable') {
        await reset()
        // An expired app grant empties the catalog while the person is still signed in. Nothing
        // else reads it again (the host sync does so once per sign-in), so Moon's and Andy's chats
        // used to open as plain rooms until a restart: read it again in the background.
        logCatalog({ ok: false, error, retryInMs: scheduleRetry() })
      }

      throw error
    } finally {
      if (owner === scope && !same(scope, deps.account.appScope())) {
        await reset()
      }
    }
  }

  async function loadIcons(catalog: AppDescriptor[], ticket: number) {
    // Optional presentation never delays the catalog/connection path. Bound
    // parallel requests, retained assets and account-late completions. Four
    // workers, so one icon retrying on a slow link never holds up the rest.
    const wanted = () => active() && ticket === revision && apps === catalog
    const owner = scope
    const cache = owner && deps.iconCache ? deps.iconCache.forAccount(owner.accountKey) : null
    const options = { cache, wanted }
    let next = 0

    async function worker() {
      while (next < catalog.length && wanted()) {
        const app = catalog[next++]!

        const [image, botImage] = await Promise.all([
          appIcon(app.icon, deps.resource, options),
          appIcon(app.bot?.avatar ?? null, deps.resource, options)
        ])

        if (wanted()) {
          icons.set(app.app_id, image)
          botIcons.set(app.app_id, botImage)
          deps.changed()
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(4, catalog.length) }, worker))
  }

  const appLooks = () => apps.flatMap(app => (app.look ? [app.look] : []))

  function adoptLooks() {
    if (!scope || !active()) {
      return
    }

    const packs = appLooks()
    deps.lookAssets?.adopt(scope.accountKey, [...packs, ...gallery])
    deps.lookAssets?.prefetchFull(packs)
  }

  async function loadGallery(owner: Scope, ticket: number) {
    if (!deps.account.lookGalleryRequest) {
      return
    }

    try {
      const raw = await deps.account.lookGalleryRequest()
      const next = raw === null ? null : decodeLookGallery(raw)

      // A missing endpoint is an older L1, not an empty gallery. A malformed or transient
      // answer likewise cannot erase the last good account-scoped projection.
      if (!next || !active() || !same(owner, scope) || ticket !== revision) {
        return
      }

      gallery = next
      adoptLooks()
      deps.changed()
    } catch {
      // App packs and the current chat keep working while the optional gallery is absent.
    }
  }

  const active = () => same(scope, deps.account.appScope()) && !resetPending

  function readKey(slug: string, appId: string, appVersionId: string) {
    return `${slug}\u0000${appId}\u0000${appVersionId}`
  }

  /** Fail fast while the platform asked us to wait, before spending another bucket entry. */
  function refuseWhileLimited() {
    const wait = readsLimitedUntil - Date.now()

    if (wait > 0) {
      throw new AppSurfaceError('rate_limited', 429, wait)
    }
  }

  function noteReadFailure(error: unknown) {
    if (!(error instanceof AppSurfaceError) || error.code !== 'rate_limited') {
      return
    }

    const asked = error.retryAfterMs

    const wait =
      asked === null || !Number.isFinite(asked)
        ? RATE_LIMIT_FALLBACK_MS
        : Math.min(RATE_LIMIT_MAX_WAIT_MS, Math.max(1_000, asked))

    readsLimitedUntil = Math.max(readsLimitedUntil, Date.now() + wait)
  }

  function requireApp(slug: string) {
    if (!active() || status !== 'ready') {
      throw new AppSurfaceError('account_unavailable')
    }

    const app = apps.find(value => value.app === slug && value.availability === 'available')

    if (!app) {
      throw new AppSurfaceError('app_unavailable')
    }

    return app
  }

  async function workspace(slug: string): Promise<{ app: AppDescriptor; surface: AppManifestResponse }> {
    const expected = requireApp(slug)
    const appTicket = appRevisions.get(slug) ?? 0
    requireCurrentApp(slug, appTicket)

    if (!expected.has_surface) {
      throw new AppSurfaceError('app_unavailable')
    }

    const key = readKey(slug, expected.app_id, expected.app_version_id)
    const cached = workspaceCache.get(key)

    // A link, unlink or availability change keeps the version id, so the catalog's current binding must still match.
    if (
      cached &&
      cached.value.app.app_id === expected.app_id &&
      cached.value.app.link.state === expected.link.state &&
      cached.value.app.link.mode === expected.link.mode &&
      cached.value.app.availability === expected.availability &&
      cached.value.app.verified === expected.verified &&
      Date.now() - cached.at < WORKSPACE_TTL_MS
    ) {
      return cached.value
    }

    const joined = workspaceReads.get(key)

    if (joined) {
      return joined
    }

    refuseWhileLimited()

    const owner = scope
    const ticket = revision

    const read = (async () => {
      try {
        const raw = (await request({ app: slug, action: 'manifest' })) as Record<string, unknown>

        if (!active() || !same(owner, scope) || ticket !== revision) {
          throw new AppSurfaceError('account_unavailable')
        }

        requireCurrentApp(slug, appTicket)

        if (raw?.profile !== 'atum.app-workspace/1') {
          throw new AppSurfaceError('app_unavailable')
        }

        const app = parseAppDescriptor(raw.descriptor)
        const surface = parseAppManifestResponse(raw)
        const manifest = surface.manifest

        if (
          app.app_id !== expected.app_id ||
          app.app !== slug ||
          app.app_version_id !== expected.app_version_id ||
          manifest.app.id !== app.app_id ||
          manifest.app.slug !== app.app ||
          manifest.app.app_version_id !== app.app_version_id ||
          manifest.app.verified !== app.verified ||
          manifest.app.availability !== app.availability ||
          manifest.link.mode !== app.link.mode ||
          manifest.link.state !== app.link.state ||
          !app.has_surface
        ) {
          throw new AppSurfaceError('app_version_incompatible')
        }

        // The sibling has no independent version: it belongs only to this validated response.
        surface.panel = decodeAppPanel(raw.app_panel, manifest.routes, app.bot?.open_route_id, deps.log)
        const value = { app, surface }

        if (active() && same(owner, scope) && ticket === revision) {
          workspaceCache.set(key, { at: Date.now(), value })
        }

        return value
      } catch (error) {
        noteReadFailure(error)

        throw error
      }
    })()

    workspaceReads.set(key, read)

    try {
      return await read
    } finally {
      // A reset may already have started this account's next read under the same key.
      if (workspaceReads.get(key) === read) {
        workspaceReads.delete(key)
      }
    }
  }

  /** One read per bot while callers wait, and no Shell call at all during a rate-limit wait. */
  function readBotStatus(slug: string): Promise<unknown> {
    const joined = botStatusReads.get(slug)

    if (joined) {
      return joined
    }

    if (!deps.botStatus) {
      throw new AppSurfaceError('app_unavailable')
    }

    refuseWhileLimited()

    const read = (async () => {
      try {
        return await deps.botStatus!(slug)
      } catch (error) {
        noteReadFailure(error)

        throw error
      } finally {
        if (botStatusReads.get(slug) === read) {
          botStatusReads.delete(slug)
        }
      }
    })()

    botStatusReads.set(slug, read)

    return read
  }

  async function reset() {
    // Even a caller joining existing cleanup invalidates an in-flight refresh.
    revision++
    clearRetry()
    retries = 0
    // Another account (or a fresh sign-in) starts with its own reads, cache and wait.
    workspaceCache.clear()
    workspaceReads.clear()
    botStatusReads.clear()
    readsLimitedUntil = 0

    if (resetPending) {
      return resetPending
    }

    connection?.dispose()
    connection = undefined
    status = 'unavailable'
    icons.clear()
    botIcons.clear()
    appRevisions.clear()
    withdrawn.clear()
    confirmed.clear()
    gallery = []
    deps.lookAssets?.reset()
    deps.changed()
    const outgoing = scope
    resetPending = (async () => {
      try {
        await drainWithdrawals([deps.stopParticipants?.(), outgoing ? deps.views().revokeAccount(outgoing) : undefined])
      } finally {
        scope = null
        apps = []
      }
    })()

    try {
      await resetPending
    } finally {
      resetPending = undefined
    }
  }

  /**
   * `looked` is a catalog `revalidate` has just read for the account already in `scope`, at
   * generation `ticket`: it is adopted as read, by the same steps as a fresh read, instead of
   * being read a second time.
   */
  async function refresh(
    interactive = false,
    background = false,
    looked?: { catalog: AppCatalog; ticket: number }
  ) {
    if (refreshing) {
      return
    }

    refreshing = true
    const started = revision

    // A background re-read of an unreadable catalog stays "unavailable" until it has an answer,
    // rather than flashing the apps pages to "loading" every few seconds.
    if (!background || status !== 'unavailable') {
      status = 'loading'
      deps.changed()
    }

    clearRetry()

    try {
      if (!looked) {
        await deps.account.readDomain(interactive)
      }

      if (revision !== started) {
        return
      }

      const current = deps.account.appScope()

      if (!current) {
        throw new Error('matrix_app_unavailable')
      }

      if (!looked && !same(scope, current)) {
        const resetRevision = revision + 1
        await reset()

        if (revision !== resetRevision || !same(current, deps.account.appScope())) {
          return
        }

        scope = current
        status = 'loading'
        const captured = scope
        connection = createAppConnection({
          resource: deps.resource,
          active: () => same(captured, deps.account.appScope()) && same(captured, scope) && !resetPending,
          changed: deps.changed,
          openExternal: deps.openExternal,
          ...(deps.openAuthorize
            ? {
                openAuthorize: async ({ slug, url, onClosed }) => {
                  const owner = scope
                  const ticket = revision
                  const appTicket = appRevisions.get(slug) ?? 0
                  const { app, surface } = await workspace(slug)

                  if (!owner || !active() || ticket !== revision) {
                    throw new AppSurfaceError('account_unavailable')
                  }

                  requireCurrentApp(slug, appTicket)
                  let iconDataUrl = icons.get(app.app_id) ?? null

                  if (!iconDataUrl) {
                    const cache = deps.iconCache?.forAccount(owner.accountKey) ?? null
                    iconDataUrl = await appIcon(app.icon, deps.resource, {
                      cache,
                      wanted: () => active() && owner === scope && ticket === revision
                    })
                  }

                  if (!active() || owner !== scope || ticket !== revision) {
                    throw new AppSurfaceError('account_unavailable')
                  }

                  requireCurrentApp(slug, appTicket)

                  return deps.openAuthorize!({
                    app: slug,
                    appName: app.bot?.display_name ?? appLocalizedCopy(app.name, deps.locale?.() ?? 'vi', slug),
                    approvedOrigins: [
                      surface.web_origin,
                      ...surface.network_origins
                        .filter(entry => entry.kinds.includes('connect'))
                        .map(entry => entry.origin)
                    ],
                    authorizeUrl: url,
                    iconDataUrl,
                    locale: deps.locale?.() ?? 'vi',
                    onClosed
                  })
                }
              }
            : {}),
          request: (slug, action, body) => request({ app: slug, action }, body as Record<string, unknown> | undefined),
          // What a tapped confirm requires of the app (requireApp), minus the transient
          // catalog-loading state: an attempt is cancelled outright when its app changes.
          confirmable: slug => active() && apps.some(app => app.app === slug && app.availability === 'available'),
          confirmed: slug => void settleAutoConfirmed(captured, slug),
          // (g) at the return: consent to the disclosure this Atum shows, on a fresh platform
          // read. The catalog cannot answer it: main does not refresh it after a consent, and
          // a revoke on another device leaves it stale.
          ...(deps.botStatus
            ? {
                consented: async (slug: string) => {
                  const app = apps.find(candidate => candidate.app === slug)

                  if (!active() || !app) {
                    return null
                  }

                  const disclosureVersion = appBotDisclosureVersion(app)

                  return appBotConsentStands(await readBotStatus(slug), disclosureVersion)
                    ? { disclosureVersion }
                    : null
                }
              }
            : {}),
          ...(deps.log ? { log: deps.log } : {}),
          ...(deps.returned ? { returned: deps.returned } : {})
        })
      }

      // A catalog already read must belong to the account the workspace is bound to.
      if (looked && !same(scope, current)) {
        throw new Error('matrix_app_cancelled')
      }

      const ticket = looked ? looked.ticket : revision
      const catalog = looked ? looked.catalog : parseAppCatalog(await request({}))

      if (!active() || ticket !== revision) {
        throw new Error('matrix_app_cancelled')
      }

      for (const previous of apps) {
        const next = catalog.apps.find(app => app.app_id === previous.app_id)

        if (
          !next ||
          next.app !== previous.app ||
          next.app_version_id !== previous.app_version_id ||
          (previous.link.state === 'linked' && next.link.state !== 'linked')
        ) {
          invalidateApp(previous.app)
          await drainWithdrawals([
            deps.withdrawParticipant?.(previous.app),
            deps.views().revokeApp({ ...scope!, app: previous.app })
          ])
        } else if (next.availability !== 'available') {
          invalidateApp(previous.app)
          await drainWithdrawals([
            deps.stopParticipants?.(previous.app),
            deps.views().revokeApp({ ...scope!, app: previous.app })
          ])
        } else if (
          previous.bot?.guest_enabled &&
          (previous.link.state !== next.link.state ||
            (previous.bot.consent === 'accepted' && next.bot?.consent !== 'accepted'))
        ) {
          // Guest -> linked (and a revoke made on another device) changes which
          // authority backs the web surface. Drop the old view rather than let a
          // guest cookie outlive its consent; the chat transcript stays.
          invalidateApp(previous.app)
          await drainWithdrawals([deps.views().revokeApp({ ...scope!, app: previous.app })])
        }
      }

      if (!active() || ticket !== revision) {
        throw new Error('matrix_app_cancelled')
      }

      apps = catalog.apps
      adoptions++
      // A catalog read just now is a look: the window coming forward next does not read it again.
      lastLook = Date.now()
      icons.clear()
      botIcons.clear()
      status = 'ready'
      retries = 0
      logCatalog({ ok: true, apps })
      await deps.catalogChanged(apps.map(app => app.app_id))

      if (!active() || ticket !== revision) {
        return
      }

      const participants = apps.filter(app => !withdrawn.has(app.app))
      const participantTickets = participants.map(app => appRevisions.get(app.app) ?? 0)
      await deps.reconcileParticipants?.(
        participants,
        () =>
          active() &&
          ticket === revision &&
          participants.every(
            (app, index) => !withdrawn.has(app.app) && participantTickets[index] === (appRevisions.get(app.app) ?? 0)
          )
      )
      adoptLooks()

      if (scope) {
        void loadGallery(scope, ticket)
      }

      void loadIcons(apps, ticket)
    } catch (error) {
      status = 'unavailable'

      try {
        await deps.stopParticipants?.()
      } finally {
        // A failed catalog is not an empty catalog, nor evidence of no preference.
        if (!same(scope, deps.account.appScope())) {
          await reset()
        }

        // Still this account's catalog to read: try again in the background.
        logCatalog({ ok: false, error, retryInMs: scheduleRetry() })
      }
    } finally {
      refreshing = false
      deps.changed()
    }
  }

  /**
   * Look at the catalog again, quietly, while the one on screen is ready: an app published since
   * sign-in, a bot that came back, or a link another device changed. The answer is laid over the
   * last good catalog (`lookedCatalog`): it adds and updates, and an app it leaves out stays as last
   * read, so a partial answer can never revoke what it does not mention. Nothing is shown unless the
   * result differs; then it is adopted by the steps `refresh` takes. A look that fails (offline, rate
   * limit, a catalog this Atum cannot read) changes nothing: the apps on screen and the ones running
   * stay as they were, and no retry is queued, because the next look is the retry. At most one look
   * per `REVALIDATE_MS`, and none inside a wait the platform asked for.
   */
  async function revalidate() {
    // The account changes only through `reset`, which moves `revision`: the ticket outlives nothing.
    const ticket = revision

    if (!scope || refreshing || status !== 'ready' || !active() || Date.now() - lastLook < REVALIDATE_MS) {
      return
    }

    try {
      refuseWhileLimited()
    } catch {
      return
    }

    lastLook = Date.now()
    const adopted = adoptions
    let catalog: AppCatalog

    try {
      await deps.account.readDomain(false)
      catalog = parseAppCatalog(await deps.account.appRequest({}))
    } catch (error) {
      noteReadFailure(error)

      return
    }

    // A refresh that started meanwhile has left `status` 'loading', and one that finished has moved
    // `adoptions`: either way a newer read than this look is in charge.
    if (!active() || status !== 'ready' || ticket !== revision || adopted !== adoptions) {
      return
    }

    const looked = catalog.omissionsAuthoritative
      ? { apps: catalog.apps, kept: [] }
      : lookedCatalog(apps, catalog.apps)

    const kept = looked.kept.map(app => app.app).join(',')

    // One line per change of what an answer left out; an answer that leaves nothing out clears it.
    if (kept !== lastPartialLog) {
      lastPartialLog = kept

      if (kept) {
        deps.log?.(appCatalogPartialLogLine(looked.kept))
      }
    }

    if (JSON.stringify(looked.apps) === JSON.stringify(apps)) {
      return
    }

    await refresh(false, true, { catalog: { ...catalog, apps: looked.apps }, ticket })
  }

  /**
   * After a native confirm or a read: release a withdrawal only on a fresh confirmed, ready
   * link; close what the link no longer allows; refresh the descriptor the roster reads.
   */
  async function settle(
    app: AppDescriptor,
    helper: NonNullable<typeof connection>,
    owner: Scope | null,
    appTicket: number,
    nativeConfirmation: boolean
  ) {
    const state = helper.snapshot()[app.app]
    const current = state?.phase === 'idle' ? state.connection : undefined

    if (!active() || owner !== scope || helper !== connection || appTicket !== (appRevisions.get(app.app) ?? 0)) {
      return
    }

    if (nativeConfirmation && current?.state === 'linked') {
      confirmed.add(app.app)
    }

    let reconnected = false

    if (
      confirmed.has(app.app) &&
      current?.available &&
      current.state === 'linked' &&
      current.readiness === 'ready'
    ) {
      reconnected = withdrawn.delete(app.app)
      confirmed.delete(app.app)
    }

    if (active() && current && (!current.available || (current.connectionRequired && current.state !== 'linked'))) {
      invalidateApp(app.app)
      await drainWithdrawals([
        current.connectionRequired && current.state !== 'linked'
          ? deps.withdrawParticipant?.(app.app)
          : deps.stopParticipants?.(app.app),
        deps.views().revokeApp({ ...scope!, app: app.app })
      ])
    }

    // A signed provider receipt can change readiness after confirmation.
    // Refresh the authoritative descriptor before offering chat enrollment;
    // the connection panel alone must not leave the roster on its old link.
    if (active() && current?.available && (current.state !== app.link.state || nativeConfirmation || reconnected)) {
      await refresh()
    }
  }

  /** The setup card's flow confirmed itself (app-connection.ts): settle as a tapped confirm does. */
  async function settleAutoConfirmed(owner: Scope, slug: string) {
    const helper = connection
    const app = apps.find(value => value.app === slug)

    if (!helper || !app || owner !== scope || !active()) {
      return
    }

    try {
      await settle(app, helper, owner, appRevisions.get(slug) ?? 0, true)
    } catch {
      // A failed withdrawal drain or refresh is retried by the next read or refresh.
    }

    deps.changed()
  }

  return {
    refresh,
    revalidate,
    reset,
    knownAppIds: () => apps.map(app => app.app),
    participant(appId: string): AppDescriptor {
      const app = apps.find(value => value.app_id === appId)

      if (
        !active() ||
        status !== 'ready' ||
        !app ||
        app.availability !== 'available' ||
        withdrawn.has(app.app) ||
        app.link.state !== 'linked' ||
        // The room context admits the per-person app participant this Mac hosts. An official
        // bot carries its own group profile in its bot row (atum-app-bots v1 §6.2), independent
        // of the operator-set `apps.room_context_profile`: main's bot paths check the bot itself.
        (!app.bot && app.matrix_room_context !== 'addressed_only')
      ) {
        throw new Error('matrix_app_unavailable')
      }

      return structuredClone(app)
    },
    /** Opening setup grants no provider link or consent and starts no app turn. The refusal
     * names the reason the person can act on (shared/matrix-app-bot-failure.ts). */
    botChat(appId: string): AppDescriptor {
      const app = apps.find(value => value.app_id === appId)

      if (!active() || status !== 'ready' || !app || app.availability !== 'available' || !app.bot) {
        throw new Error('matrix_app_bot_unavailable')
      }

      const refusal = appBotOpenRefusal(app.bot)

      if (refusal) {
        throw new Error(refusal)
      }

      return structuredClone(app)
    },
    account: () => (active() ? scope : null),
    snapshot(): MatrixAppWorkspace {
      // Retain the last confirmed descriptors for explicit withdrawal during a
      // catalog outage. They cannot authorize menu/launch while not ready.
      return {
        state: status,
        apps: active()
          ? apps.map(app => ({
              ...app,
              icon: icons.get(app.app_id) ? { ...app.icon!, url: icons.get(app.app_id)! } : null,
              // Remote catalog URLs remain in main. The renderer receives only
              // digest-checked raster bytes, or an empty presentation URL.
              bot: app.bot
                ? {
                    ...app.bot,
                    avatar: { ...app.bot.avatar, url: botIcons.get(app.app_id) ?? '' }
                  }
                : app.bot
            }))
          : [],
        connections: connection?.snapshot() ?? {},
        ...(gallery.length ? { gallery } : {})
      }
    },
    /**
     * The setup card's status read shares the same per-principal bucket as the manifest. One
     * read serves callers already waiting, and a rate-limited wait is honoured before it spends
     * another entry; the card keeps retrying on its own schedule afterwards.
     */
    async botStatus(appId: string): Promise<unknown> {
      const app = apps.find(value => value.app_id === appId)

      if (!active() || !app?.bot) {
        throw new Error('matrix_app_bot_unavailable')
      }

      return readBotStatus(app.app)
    },
    async menu(appId: string): Promise<MatrixAppMenu> {
      const app = apps.find(value => value.app_id === appId)

      if (!app) {
        throw new Error('matrix_app_unavailable')
      }

      const result = await workspace(app.app)

      return {
        app: result.app,
        ...(result.surface.panel ?? {}),
        routes: result.surface.manifest.routes
          .filter(route => route.placements.includes('menu'))
          .map(({ id, label, icon, session }) => ({ id, label, icon, session })),
        actions: result.surface.manifest.routes
          .filter(route => route.placements.includes('composer'))
          .map(({ id, label, icon, session }) => ({ id, label, icon, session }))
      }
    },
    async history(appId: string, cursor: string | null = null): Promise<MatrixAppHistoryPage> {
      const app = apps.find(value => value.app_id === appId)

      if (
        !app ||
        !active() ||
        status !== 'ready' ||
        !app.has_history ||
        app.link.state !== 'linked' ||
        !app.bot ||
        app.bot.consent !== 'accepted' ||
        app.bot.disclosure_version !== appBotDisclosureVersion(app)
      ) {
        throw new Error('matrix_app_unavailable')
      }

      const ticket = revision
      const appTicket = appRevisions.get(app.app) ?? 0
      const result = await workspace(app.app)
      requireCurrentApp(app.app, appTicket)

      const raw = await request(
        { app: app.app, action: 'history' },
        { app_version_id: result.app.app_version_id, cursor, limit: 20 }
      )

      if (!active() || ticket !== revision) {
        throw new AppSurfaceError('account_unavailable')
      }

      requireCurrentApp(app.app, appTicket)

      return parseMatrixAppHistoryPage(raw, app.app_id, app.app_version_id)
    },
    surfaces: {
      async panelLink(slug: string, begin: boolean) {
        const ticket = revision
        const appTicket = appRevisions.get(slug) ?? 0
        const { surface } = await workspace(slug)

        if (!active() || ticket !== revision) {throw new AppSurfaceError('account_unavailable')}
        requireCurrentApp(slug, appTicket)

        if (surface.manifest.launch?.profile !== 'atum.app-launch/2') {throw new AppSurfaceError('app_unavailable')}
        const raw = await request({ app: slug, action: 'panel-link' }, begin ? {} : undefined)

        if (!active() || ticket !== revision) {throw new AppSurfaceError('account_unavailable')}
        requireCurrentApp(slug, appTicket)

        return parseBotPanelStatus(raw)
      },
      manifest: async (slug: string) => {
        const { surface } = await workspace(slug)

        return {
          ...surface,
          manifest: {
            ...surface.manifest,
            routes: surface.manifest.routes.filter(route => route.placements.includes('menu') || route.placements.includes('composer'))
          }
        }
      },
      async launch(slug: string, routeId: string) {
        const ticket = revision
        const appTicket = appRevisions.get(slug) ?? 0
        const { surface } = await workspace(slug)

        if (!active() || ticket !== revision) {
          throw new AppSurfaceError('account_unavailable')
        }

        requireCurrentApp(slug, appTicket)
        const route = surface.manifest.routes.find(item => item.id === routeId && (item.placements.includes('menu') || item.placements.includes('composer')))

        if (!route || route.session !== 'required' || !surface.manifest.launch) {
          throw new AppSurfaceError('route_unknown')
        }

        const raw = await request(
          { app: slug, action: 'launch' },
          { app_version_id: surface.manifest.app.app_version_id, route_id: routeId }
        )

        if (!active() || ticket !== revision) {
          throw new AppSurfaceError('account_unavailable')
        }

        requireCurrentApp(slug, appTicket)

        return parseAppLaunchIssue(raw, { webOrigin: surface.web_origin, launchPath: surface.manifest.launch.path })
      }
    },
    async connection(
      appId: string,
      action: 'read' | 'begin' | 'confirm' | 'cancel' | 'disconnect',
      options?: AppConnectionBeginOptions
    ) {
      const app = apps.find(value => value.app_id === appId)

      if (!app || !connection || !active()) {
        throw new Error('matrix_app_unavailable')
      }

      if (action === 'begin' || action === 'confirm') {
        requireApp(app.app)
      }

      if (action === 'disconnect') {
        withdrawn.add(app.app)
        invalidateApp(app.app)
        // Local closure must be attempted even if the server cannot be reached;
        // a failed personal-session drain must not prevent canonical unlink.
        await drainWithdrawals([
          deps.views().revokeApp({ ...scope!, app: app.app }),
          deps.withdrawParticipant?.(app.app),
          connection.disconnect(app.app)
        ])
        await refresh()
      } else if (action === 'read' || action === 'confirm') {
        const helper = connection
        const owner = scope
        const appTicket = appRevisions.get(app.app) ?? 0
        const nativeConfirmation = action === 'confirm' && helper.snapshot()[app.app]?.phase === 'confirm'
        await helper[action](app.app)

        if (!active() || owner !== scope || helper !== connection || appTicket !== (appRevisions.get(app.app) ?? 0)) {
          return
        }

        await settle(app, helper, owner, appTicket, nativeConfirmation)
      } else {
        if (action === 'begin' || action === 'cancel') {
          confirmed.delete(app.app)
        }

        if (action === 'begin') {
          await connection.begin(app.app, options?.autoConfirm === true ? { autoConfirm: true } : undefined)
        } else {
          await connection[action](app.app)
        }
      }

      deps.changed()
    }
  }
}
