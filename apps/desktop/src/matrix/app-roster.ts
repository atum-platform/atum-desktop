import type { AppDescriptor } from '../../shared/app-catalog'
import type { AppShortcutState } from '../../shared/app-shortcuts'

/** A catalog entry is live (may be launched) or a presentation-only coming-soon row. */
export type AppRosterKind = 'live' | 'coming_soon'

/** The one visibility decision shared by live rows and coming-soon placeholders. */
export function appRosterKind(app: Pick<AppDescriptor, 'roster_state'>): AppRosterKind {
  return app.roster_state === 'coming_soon' ? 'coming_soon' : 'live'
}

function eligible(app: AppDescriptor): boolean {
  if (appRosterKind(app) === 'coming_soon') {
    // The parser refuses these combinations, and this guard keeps a hand-built descriptor
    // from turning presentation into authority.
    return app.availability === 'unavailable' && !app.bot && !app.has_surface && app.link.mode === 'none'
  }

  // An official chat identity is a catalog commitment even while its bot is paused.
  if (app.bot) {
    return true
  }

  return app.availability === 'available' && (app.has_surface || app.matrix_room_context === 'addressed_only')
}

/**
 * The effective roster decision for one catalog entry. Matrix account data is the person's
 * authority: explicit `hidden` always wins and explicit `shown` draws an eligible live or
 * coming-soon row. An implicit choice follows the server's effective `roster_default`, but
 * only once the preference is known and writable; unknown, loading and read-only states never
 * guess a default. A server default change never writes the preference.
 */
export function appRosterVisibility(app: AppDescriptor, preference?: AppShortcutState): 'shown' | 'hidden' {
  if (preference?.visibility === 'hidden') {
    return 'hidden'
  }

  if (preference?.visibility === 'shown') {
    return eligible(app) ? 'shown' : 'hidden'
  }

  if (
    !preference ||
    preference.visibility === 'unknown' ||
    preference.status === 'loading' ||
    preference.status === 'readonly'
  ) {
    return 'hidden'
  }

  if (preference.visibility !== 'default') {
    return 'hidden'
  }

  return app.roster_default && eligible(app) ? 'shown' : 'hidden'
}

/**
 * Official chat identities and ordinary apps share one decision table. There is deliberately
 * no client-side row cap: `roster_default` is the platform's effective owner-scoped policy and
 * truncating it would show a roster the owner's server did not approve. Coming-soon entries are
 * presentation only and belong to `projectMatrixRoster`'s placeholders, never this live list.
 */
export function appRoster(apps: readonly AppDescriptor[], preferences: Record<string, AppShortcutState> = {}) {
  return [...apps]
    .sort((a, b) => a.roster_order - b.roster_order || a.app_id.localeCompare(b.app_id))
    .filter(app => appRosterKind(app) === 'live' && appRosterVisibility(app, preferences[app.app_id]) === 'shown')
}
