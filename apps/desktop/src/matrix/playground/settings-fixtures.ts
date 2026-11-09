import type { MatrixSnapshot } from '../../../shared/matrix'
import type { MatrixAliasBridge } from '../../../shared/matrix-aliases'
import type {
  MatrixGoogleConnectionBridge,
  MatrixGoogleConnectionStatus
} from '../../../shared/matrix-google-connections'
import type { MatrixLoginStartupBridge, MatrixLoginStartupStatus } from '../../../shared/matrix-login-startup'
import type { MatrixPermissionsBridge, MatrixPermissionsSnapshot } from '../../../shared/matrix-permissions'
import type { MatrixProfile, MatrixProfilesBridge } from '../../../shared/matrix-profile'

/**
 * Settings on fixture data (dev only): the native pieces the installed app has and the
 * plain playground did not — Mac permissions, start at login, the profile editor, Google
 * connections — plus the account states Settings draws differently, picked from the URL:
 *
 * - `?recovery=on|off` the account has a recovery key / none (default: not known yet);
 *   `kept` it has one and this Mac keeps it (signing in again unlocks by itself); `quiet` this
 *   Mac made it quietly and it is not written down yet
 * - `?ignored=N` N ignored people (the first has a direct chat, so it shows by name)
 * - `?model=own` the assistant answers with the person's own model
 * - `?google=empty|connected|error` Google connections offered (none yet / one account / unreadable)
 * - `?login=on|approval|unavailable` start at login (default: off)
 * - `?permissions=error` the permission check fails
 * - `?alias=none` no public handle yet: check and claim answer as the directory would
 * - `?disk=low|critical` this Mac's disk is filling up (8.2 GB / 2.5 GB free)
 * - `?damaged=1` this Mac's own device lost its keys (a new sign-in mends it)
 * - `?icloud=on|off` a build with the Atum Keys helper: the key's copy in iCloud Keychain
 */
export interface PlaygroundSettingsOptions {
  recovery?: 'on' | 'off' | 'kept' | 'quiet'
  ignored: number
  ownModel: boolean
  google?: 'empty' | 'connected' | 'error'
  login: 'off' | 'on' | 'approval' | 'unavailable'
  permissionsFail: boolean
  aliasNone: boolean
  disk?: 'low' | 'critical'
  damaged: boolean
  icloud?: 'on' | 'off'
}

export function playgroundSettingsOptions(params: URLSearchParams): PlaygroundSettingsOptions {
  const recovery = params.get('recovery')
  const google = params.get('google')
  const login = params.get('login')

  return {
    recovery:
      recovery === 'on' || recovery === 'off' || recovery === 'kept' || recovery === 'quiet' ? recovery : undefined,
    ignored: Math.max(0, Math.min(6, Number(params.get('ignored')) || 0)),
    ownModel: params.get('model') === 'own',
    google: google === 'empty' || google === 'connected' || google === 'error' ? google : undefined,
    login: login === 'on' || login === 'approval' || login === 'unavailable' ? login : 'off',
    permissionsFail: params.get('permissions') === 'error',
    aliasNone: params.get('alias') === 'none',
    disk:
      params.get('disk') === 'low' || params.get('disk') === 'critical'
        ? (params.get('disk') as 'low' | 'critical')
        : undefined,
    damaged: params.get('damaged') === '1',
    icloud:
      params.get('icloud') === 'on' || params.get('icloud') === 'off'
        ? (params.get('icloud') as 'on' | 'off')
        : undefined
  }
}

/** One with a direct chat (shown by its name), the rest by handle. */
const IGNORED = [
  '@hoa:example.invalid',
  '@spam.offers:example.invalid',
  '@tuan.ho:example.invalid',
  '@deal.bot99:example.invalid',
  '@lan:example.invalid',
  '@quang:example.invalid'
]

/** The account states Settings draws differently, laid over a signed-in snapshot. */
export function withPlaygroundSettings(snapshot: MatrixSnapshot, options: PlaygroundSettingsOptions): MatrixSnapshot {
  if (!snapshot.identity) {
    return snapshot
  }

  return {
    ...snapshot,
    // The phone sheet's server line, as the installed app knows it.
    homeserver: snapshot.homeserver ?? 'https://matrix.atum.chat',
    ...(options.recovery
      ? {
          security: {
            recovery: snapshot.security?.recovery ?? 'idle',
            ...(snapshot.security?.verification ? { verification: snapshot.security.verification } : {}),
            storage: options.recovery === 'off' ? ('absent' as const) : ('present' as const),
            ...(options.recovery === 'kept' || options.recovery === 'quiet' ? { kept: true as const } : {}),
            ...(options.recovery === 'quiet' ? { custody: 'device' as const } : {}),
            ...(options.icloud ? { icloud: options.icloud } : {})
          }
        }
      : {}),
    ...(options.ignored > 0 ? { ignoredUsers: IGNORED.slice(0, options.ignored) } : {}),
    ...(options.disk ? { disk: { state: options.disk, freeGb: options.disk === 'low' ? 8.2 : 2.5 } } : {}),
    ...(options.damaged ? { deviceDamaged: true as const } : {}),
    ...(options.ownModel ? { ownModel: true, atumModel: false } : {})
  }
}

/** Mac permissions as a Mac with a few granted and a few still to allow reports them. */
export function playgroundPermissions(options: PlaygroundSettingsOptions): MatrixPermissionsBridge {
  const snapshot: MatrixPermissionsSnapshot = {
    platform: 'macos',
    permissions: {
      screen: 'granted',
      accessibility: 'not-granted',
      microphone: 'not-determined',
      automation: 'manual-check',
      files: 'granted',
      fullDisk: 'not-granted',
      location: 'not-determined'
    }
  }

  return {
    status: async () => {
      await new Promise(resolve => setTimeout(resolve, 120))

      if (options.permissionsFail) {
        throw new Error('playground_permissions_failed')
      }

      return snapshot
    },
    openSettings: async () => {}
  }
}

/** Start at login, as the installed app reads it from macOS. */
export function playgroundLoginStartup(options: PlaygroundSettingsOptions): MatrixLoginStartupBridge {
  let status: MatrixLoginStartupStatus =
    options.login === 'unavailable'
      ? { state: 'unavailable', reason: 'os_error' }
      : {
          state: options.login === 'on' ? 'enabled' : options.login === 'approval' ? 'requires_approval' : 'disabled',
          wasOpenedAtLogin: false,
          // The owner's Mac runs macOS 26: its Login Items pane exists.
          loginItemsPane: true
        }

  return {
    status: async () => status,
    setEnabled: async enabled => {
      status = { state: enabled ? 'enabled' : 'disabled', wasOpenedAtLogin: false, loginItemsPane: true }

      return status
    },
    openSettings: async () => {},
    acknowledge: async () => {}
  }
}

/** The profile editor's native side: one fixed person, nothing uploaded anywhere. */
const AVATAR_COLORS = ['#6D7CE4', '#49A88B', '#D9785B', '#B269C7', '#D2A548', '#5C9CC9']

/** A synthetic face, so the playground can show avatar rows without a homeserver. */
function playgroundMemberAvatar(userId: string, name: string): string {
  const hash = [...userId].reduce((sum, value) => sum + value.codePointAt(0)!, 0)
  const color = AVATAR_COLORS[hash % AVATAR_COLORS.length]
  const initial = [...name.trim()][0]?.toLocaleUpperCase() ?? '?'
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="14" fill="${color}"/><text x="32" y="41" font-family="system-ui,sans-serif" font-size="28" font-weight="600" fill="#fff" text-anchor="middle">${initial}</text></svg>`

  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

export function playgroundProfiles(snapshot: () => MatrixSnapshot): MatrixProfilesBridge {
  const profile = (): MatrixProfile => ({
    userId: snapshot().identity?.userId ?? '@sample-member:example.invalid',
    displayName: snapshot().ownProfile?.displayName ?? 'Sample Member',
    avatarMxc: null,
    avatarUrl: null
  })

  return {
    read: async () => profile(),
    open: async () => ({ scope: 'playground-profile' }),
    change: async (_scope, change) =>
      change.kind === 'name' ? { ...profile(), displayName: change.displayName } : profile(),
    close: async () => {},
    member: async userId => {
      const member = snapshot().members?.find(value => value.userId === userId)

      return {
        userId,
        avatarUrl: member?.avatarMxc ? playgroundMemberAvatar(userId, member.name) : null
      }
    }
  }
}

/** Google connections when the build offers them: none yet, or one account with three sources. */
export function playgroundGoogleConnections(
  options: PlaygroundSettingsOptions
): MatrixGoogleConnectionBridge | undefined {
  if (!options.google) {
    return undefined
  }

  let status: MatrixGoogleConnectionStatus = {
    available: true,
    sources:
      options.google === 'connected'
        ? [
            {
              id: 's-mail',
              groupId: 'g1',
              provider: 'google',
              kind: 'email',
              label: 'person@example.com',
              state: 'connected',
              enabled: true
            },
            {
              id: 's-cal',
              groupId: 'g1',
              provider: 'google',
              kind: 'calendar',
              label: 'Sample Member',
              state: 'connected',
              enabled: true
            },
            {
              id: 's-drive',
              groupId: 'g1',
              provider: 'google',
              kind: 'drive',
              label: 'person@example.com',
              state: 'connected',
              enabled: false
            }
          ]
        : []
  }

  return {
    status: async () => {
      if (options.google === 'error') {
        throw new Error('playground_google_unreadable')
      }

      return { status }
    },
    connect: async () => ({ status }),
    disconnect: async groupId => {
      status = { ...status, sources: status.sources.filter(source => source.groupId !== groupId) }

      return { status }
    },
    setSourcePreferences: async preferences => {
      status = {
        ...status,
        sources: status.sources.map(source => {
          const change = preferences.find(preference => preference.id === source.id)

          return change ? { ...source, enabled: change.enabled } : source
        })
      }

      return { status }
    }
  }
}

/** No public handle yet (`?alias=none`): "minh_nguyen" is free for you, any other name ending
 * in _bot for an assistant, and every other name is taken. Claims and renames stick per target. */
export function playgroundUnclaimedAliases(directory: MatrixAliasBridge['request']): MatrixAliasBridge {
  const claimed = new Map<string, string>()
  const free = (handle: string, assistantId?: string) => (assistantId ? handle.endsWith('_bot') : handle === 'minh_nguyen')

  return {
    pending: async () => ({ ok: true as const, request: null }),
    request: async input => {
      if (input.action === 'current') {
        const handle = claimed.get(input.assistantId ?? '')

        return { ok: true, value: { kind: 'current', alias: handle ? { handle, generation: 1 } : null } }
      }

      if (input.action === 'check') {
        await new Promise(resolve => setTimeout(resolve, 300))
        const handle = input.handle.replace(/^@/, '').toLowerCase()
        const available = free(handle, input.assistantId) && ![...claimed.values()].includes(handle)

        return { ok: true, value: { kind: 'check', handle, available, code: available ? null : 'alias_unavailable' } }
      }

      if (input.action === 'claim' || input.action === 'rename') {
        const previous = claimed.get(input.assistantId ?? '')
        claimed.set(input.assistantId ?? '', input.handle)

        return input.action === 'rename' && previous
          ? { ok: true, value: { kind: 'rename', handle: input.handle, generation: 1, previous } }
          : { ok: true, value: { kind: 'claim', handle: input.handle, generation: 1 } }
      }

      return directory(input)
    }
  }
}
