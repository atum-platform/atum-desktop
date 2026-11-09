/**
 * One closed-code main.log line per step of the native app-link flow (Moon, Andy):
 * `[Matrix] app link app=<slug> step=<step> outcome=<code>`. The slug names a published
 * app, never a person; tickets, codes, URLs and hosts never reach the line.
 */

export type AppLinkStep = 'begin' | 'return' | 'confirm' | 'cancel' | 'request'

export type AppLinkOutcome =
  // begin
  | 'opened'
  | 'unavailable'
  | 'connection_failed'
  | 'callback_failed'
  | 'connect_failed'
  | 'authorize_invalid'
  | 'browser_failed'
  | 'timed_out'
  | 'superseded'
  // return
  | 'received'
  | 'rejected'
  // confirm
  | 'confirmed'
  | 'confirm_failed'
  | 'not_ready'
  // auto-confirm only: a fresh read no longer shows consent to the disclosure this Atum shows
  | 'consent_required'
  // cancel
  | 'cancelled'
  // the IPC request itself (main.ts), refused before the flow starts
  | 'refused_busy'
  | 'refused_signed_out'
  | 'refused_invalid'
  | 'refused_app'
  | 'failed'

/** Where the authority sent the browser, as a class: the API host itself, or another host. */
export type AppLinkAuthorize = 'same_origin' | 'other_origin'

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u
/** The closed states of an official bot in the catalog (shared/app-catalog.ts). */
const BOT_STATES: ReadonlySet<string> = new Set(['starting', 'active', 'paused', 'unavailable'])

export function appLinkLogLine(input: {
  app: string
  step: AppLinkStep
  outcome: AppLinkOutcome
  action?: string
  authorize?: AppLinkAuthorize
  /** A confirm Atum sent itself after the gated browser return, not after a tap. */
  mode?: 'auto'
}): string {
  const app = SLUG.test(input.app) ? input.app : 'unknown'
  const action = input.action && /^[a-z]{1,12}$/u.test(input.action) ? ` action=${input.action}` : ''
  const authorize = input.authorize ? ` authorize=${input.authorize}` : ''
  const mode = input.mode === 'auto' ? ' mode=auto' : ''

  return `[Matrix] app link app=${app} step=${input.step}${action} outcome=${input.outcome}${authorize}${mode}`
}

const word = (value: unknown, allowed: readonly string[]) =>
  typeof value === 'string' && allowed.includes(value) ? value : 'invalid'

/**
 * What the setup card in a bot's chat was told when it opened (or re-read after an
 * action): `[Matrix] app bot status app=<slug> consent=<state> link=<state> ready=<0|1>
 * available=<0|1>`, or `outcome=failed` when the read itself failed.
 */
export function appBotStatusLogLine(app: string, status: unknown): string {
  const slug = SLUG.test(app) ? app : 'unknown'

  if (status === undefined) {
    return `[Matrix] app bot status app=${slug} outcome=failed`
  }

  const raw = status !== null && typeof status === 'object' ? (status as Record<string, unknown>) : {}
  const consent = raw.consent !== null && typeof raw.consent === 'object' ? (raw.consent as Record<string, unknown>) : {}
  const link = raw.link !== null && typeof raw.link === 'object' ? (raw.link as Record<string, unknown>) : {}
  const guest = raw.guest !== null && typeof raw.guest === 'object' ? (raw.guest as Record<string, unknown>) : null
  const guestPart = guest
    ? ` guest=${word(guest.state, ['unsupported', 'start_required', 'ready', 'linked', 'unavailable'])}`
    : ''

  return (
    `[Matrix] app bot status app=${slug} consent=${word(consent.state, ['accepted', 'required', 'revoked'])}` +
    ` link=${word(link.state, ['linked', 'never_linked', 'unlinked'])}` +
    ` ready=${link.ready === true ? 1 : 0} available=${link.available === true ? 1 : 0}${guestPart}`
  )
}

/**
 * Closed reasons an app catalog or menu read can fail for. A word outside this list (including
 * a lowercase message from a library) is logged as `failed`, so main.log never carries free text.
 */
const READ_FAILURE_CODES = new Set([
  'account_unavailable',
  'app_catalog_invalid',
  'app_launch_invalid',
  'app_manifest_invalid',
  'app_surface_absent',
  'app_surface_cancelled',
  'app_surface_failed',
  'app_surface_request_failed',
  'app_surface_unavailable',
  'app_unavailable',
  'app_version_incompatible',
  'intake_status_invalid',
  'intake_values_invalid',
  'matrix_app_cancelled',
  'matrix_app_unavailable',
  'route_unknown',
  'temporarily_unavailable',
  'timeout',
  'unlinked'
])

/** A closed word for why the app catalog (or one app's menu) could not be read. Never raw text. */
export function appReadFailureCode(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      return 'timeout'
    }

    const word = (error as { code?: unknown }).code ?? error.message

    if (typeof word === 'string' && READ_FAILURE_CODES.has(word)) {
      return word
    }
  }

  return 'failed'
}

/**
 * What the app catalog read (the list Moon's and Andy's rows, composer "+" menu and panel are
 * built from) came back with: `[Matrix] apps catalog outcome=ready apps=<n> bots=<n> linked=<n>`
 * or `outcome=failed code=<code> retry=<seconds|none>`. Counts only; no app ids.
 */
export function appCatalogLogLine(
  result:
    | { ok: true; apps: ReadonlyArray<{ app?: unknown; bot?: unknown; link?: { state?: unknown } }> }
    | { ok: false; error: unknown; retryInMs: number | null }
): string {
  // `in`, not `.ok`: this project's electron config does not narrow on a boolean discriminant.
  if ('apps' in result) {
    const bots = result.apps.filter(app => app.bot).length
    const linked = result.apps.filter(app => app.link?.state === 'linked').length

    // Which apps the catalog held, by slug (public product names), each bot with its state: a
    // missing row on someone's Mac is otherwise a guess between "never sent", "sent and hidden" and
    // "sent, listed and off" (a resting bot). The line is written once per change, so a new app
    // or a bot changing state is a new line.
    const slugs = result.apps.flatMap(app => {
      if (typeof app.app !== 'string' || !SLUG.test(app.app)) {
        return []
      }

      const state = (app.bot as { state?: unknown } | null | undefined)?.state

      return [typeof state === 'string' && BOT_STATES.has(state) ? `${app.app}:${state}` : app.app]
    })

    return `[Matrix] apps catalog outcome=ready apps=${result.apps.length} bots=${bots} linked=${linked}${
      slugs.length > 0 ? ` slugs=${slugs.slice(0, 32).join(',')}` : ''
    }`
  }

  return `[Matrix] apps catalog outcome=failed code=${appReadFailureCode(result.error)} retry=${
    result.retryInMs === null ? 'none' : Math.round(result.retryInMs / 1000)
  }`
}

/**
 * `[Matrix] apps catalog outcome=partial kept=<slug,…>`: a look's answer left these apps out and the
 * window kept them as last read (app-workspace.ts `lookedCatalog`). Slugs only, at most 32.
 */
export function appCatalogPartialLogLine(kept: ReadonlyArray<{ app?: unknown }>): string {
  const slugs = kept.flatMap(app => (typeof app.app === 'string' && SLUG.test(app.app) ? [app.app] : []))

  return `[Matrix] apps catalog outcome=partial kept=${slugs.slice(0, 32).join(',')}`
}

/** `[Matrix] apps menu app=<slug> outcome=failed code=<code>`: the composer "+" menu / panel could not be built. */
export function appMenuFailedLogLine(app: string, error: unknown): string {
  const slug = SLUG.test(app) ? app : 'unknown'

  return `[Matrix] apps menu app=${slug} outcome=failed code=${appReadFailureCode(error)}`
}
