import type { MatrixRoom, MatrixSnapshot, MatrixUiBridge } from '../../../shared/matrix'
import {
  macSourceStatus,
  type MatrixAgentSourceGate,
  type MatrixAgentSourcesBridge,
  type MatrixAgentSourcesView,
  type MatrixReachMac
} from '../../../shared/matrix-agent-sources'
import type { MatrixCompanyBridge, MatrixCompanyMember11, MatrixCompanyRequest, MatrixCompanyResult } from '../../../shared/matrix-company'
import { MATRIX_COMPANY_CHANNEL_TYPE } from '../../../shared/matrix-company-channel-room'
import type { MatrixDriveBridge, MatrixDriveProblem, MatrixDriveState, MatrixDriveView } from '../../../shared/matrix-drive'
import {
  MATRIX_STANDARD_FOLDERS,
  type MatrixFolderAccessBridge,
  type MatrixFolderAccessView
} from '../../../shared/matrix-folder-access'
import type { MatrixNativeAppsBridge } from '../../../shared/matrix-native-apps'
import type { MatrixTerminalBridge } from '../../../shared/matrix-terminal'
import type { NativeAppEntry } from '../../../shared/skills-launcher'

import { PLAYGROUND_APP_MENUS } from './app-look-fixtures'
import { TEAM_PRESENCE, teamActivity, teamCompanyBridge, teamRooms } from './team-space-fixtures'

/**
 * Optional places for the playground (dev only), switched on from the URL so the
 * plain scenarios stay what a build without them shows:
 *
 * - `?drive=ready|syncing|offline|paused|disconnected|connecting|waiting|reauthenticate|error|
 *   cleanup_failed|unavailable|signIn` — Atum Drive (absent: no Drive in this build; `waiting` is the
 *   browser sign-in; `signIn` is a sign-in held back at launch); `&driveEmpty` shows an empty Drive
 *   folder; `&driveProblem=folder_not_empty|
 *   network|setting_up|not_allowed|…` adds why connecting stopped (`connecting&driveProblem=setting_up`
 *   is the automatic retry's wait).
 *   `&driveFacts=normal|nearing|critical|exceeded|progress|issues|skipped|stale` adds engine facts
 *   (`skipped`: 7 files Drive leaves on this Mac, the header's quiet note).
 * - `?company=1|empty` — the company side of Workplace, with shared spending. `?company=team` is today's wire:
 *   channels with topics, a private one, direct messages and a group; `?company=team2` adds a second
 *   company so the name menu's switching is drawn with no rail; `team-member` shows a non-admin
 *   member without owner chips (team-space-fixtures.ts).
 * - `?macApps=1` — Mac apps in the side panel's new tab.
 * - `?doc=text|word` — a linked document, for the side panel's document tab.
 * - `?offers=1` — a web preview and a running task offered in the chat.
 * - `?appMenus=1` — app pages that load (River and Atlas have screens, the rest none);
 *   River also takes part in chats, so its card's "…" shows every action.
 * - `?firstRunSources=fresh|google-granted` — the first-run ask with every grantable
 *   source off, or with only Google already granted (default: Settings' all-on state).
 * - `?macs=three|none` — cloud-only U1: Your Macs with this Mac needing Full Disk Access, a ready
 *   Mac mini and an older iMac that switched Location back off, plus the one-time composer band;
 *   `none` is an account with no Mac (default: no Mac list, as before).
 */
export interface PlaygroundPlaces {
  drive?: MatrixDriveState | 'waiting' | 'signIn'
  driveProblem?: MatrixDriveProblem
  driveFacts?: (typeof DRIVE_FACTS)[number]
  driveEmpty: boolean
  company?: CompanyMode
  macApps: boolean
  doc?: 'text' | 'word'
  offers: boolean
  appMenus: boolean
  firstRunSources: 'granted' | 'fresh' | 'google-granted'
  macs?: 'three' | 'none'
}

export function playgroundPlaces(params: URLSearchParams): PlaygroundPlaces {
  const drive = params.get('drive')
  const company = params.get('company')
  const doc = params.get('doc')
  const driveProblem = params.get('driveProblem')

  return {
    drive: DRIVE_STATES.find(state => state === drive),
    driveEmpty: params.has('driveEmpty'),
    driveProblem: driveProblem && /^[a-z_]{1,32}$/.test(driveProblem) ? (driveProblem as MatrixDriveProblem) : undefined,
    driveFacts: DRIVE_FACTS.find(facts => facts === params.get('driveFacts')),
    company: COMPANY_MODES.includes(company as CompanyMode) ? (company as CompanyMode) :
      company ? 'members' : undefined,
    macApps: params.has('macApps'),
    doc: doc === 'word' ? 'word' : doc ? 'text' : undefined,
    offers: params.has('offers'),
    appMenus: params.has('appMenus'),
    firstRunSources:
      params.get('firstRunSources') === 'fresh' || params.get('firstRunSources') === 'google-granted'
        ? (params.get('firstRunSources') as 'fresh' | 'google-granted')
        : 'granted',
    macs: params.get('macs') === 'three' || params.get('macs') === 'none' ? (params.get('macs') as 'three' | 'none') : undefined
  }
}

const DRIVE_STATES = [
  'ready',
  'syncing',
  'offline',
  'paused',
  'disconnected',
  'connecting',
  'waiting',
  'signIn',
  'reauthenticate',
  'error',
  'cleanup_failed',
  'unavailable'
] as const satisfies readonly (MatrixDriveState | 'waiting' | 'signIn')[]

const MICRO = 1_000_000
const MINUTE = 60_000
const DRIVE_FACTS = ['normal', 'nearing', 'critical', 'exceeded', 'progress', 'issues', 'skipped', 'stale'] as const

function driveBridge(place: MatrixDriveState | 'waiting' | 'signIn', problem?: MatrixDriveProblem, empty = false, facts?: PlaygroundPlaces['driveFacts']): MatrixDriveBridge {
  const now = Date.now()
  const state: MatrixDriveState = place === 'waiting' ? 'authorizing' : place === 'signIn' ? 'reauthenticate' : place
  const connected = ['ready', 'syncing', 'offline', 'paused'].includes(state)

  const view: MatrixDriveView = {
    state,
    revision: 1,
    ...(problem ? { problem } : {}),
    ...(place === 'waiting' ? { waitingForBrowser: true as const } : {}),
    ...(place === 'signIn' ? { signInNeeded: true as const } : {}),
    ...(state === 'ready' ? { lastSyncAt: now - 4 * MINUTE } : {}),
    rootLabel: 'Drive',
    rootLocation: '~/Atum/Drive',
    canGoBack: false,
    truncated: false,
    rows:
      connected && !empty
        ? [
            { id: 'f-reports', name: 'Báo cáo quý', kind: 'folder', size: 0, modifiedAt: now - 3 * 86_400_000 },
            { id: 'f-plan', name: 'Kế hoạch Đà Lạt.docx', kind: 'file', size: 48_200, modifiedAt: now - 2 * 3_600_000 },
            { id: 'f-budget', name: 'Ngân sách 2026.xlsx', kind: 'file', size: 2_483_712, modifiedAt: now - 86_400_000 },
            { id: 'f-photo', name: 'Hồ Tuyền Lâm.jpg', kind: 'file', size: 5_912_004, modifiedAt: now - 5 * 86_400_000 }
          ]
        : []
  }

  if (connected && facts) {
    const quotaState = facts === 'nearing' || facts === 'critical' || facts === 'exceeded' ? facts : 'normal'
    const used = { normal: 300 * MICRO, nearing: 900 * MICRO, critical: 980 * MICRO, exceeded: 1000 * MICRO }[quotaState]
    view.quota = { total: 1000 * MICRO, used, remaining: 1000 * MICRO - used, state: quotaState }

    if (facts === 'progress' || facts === 'stale') {
      view.progress = { active: true, files: { done: 12, total: 40 }, bytes: { done: 30 * MICRO, total: 100 * MICRO }, etaSeconds: 60, direction: 'mixed' }
    }

    if (facts === 'issues') {
      view.issues = [
        { id: 'issue-full', code: 'drive_full' },
        { id: 'issue-conflicts', code: 'conflicts', count: 3 },
        { id: 'issue-errors', code: 'errors', count: 2 },
        { id: 'issue-sign-in', code: 'signed_out' }
      ]
    }

    if (facts === 'skipped') {
      view.issues = [{ id: 'issue-skipped', code: 'excluded', count: 7 }]
    }

    if (facts === 'stale') {
      view.factsStale = true
    }
  }

  const listeners = new Set<(next: MatrixDriveView) => void>()

  return {
    read: async () => view,
    connect: async () => view,
    chooseFolder: async () => ({ cancelled: true }),
    cancelSignIn: async () => ({ ...view, state: 'disconnected', rows: [], waitingForBrowser: undefined }),
    disconnect: async () => ({ ...view, state: 'disconnected', rows: [] }),
    enter: async () => view,
    back: async () => view,
    open: async () => {},
    reveal: async () => {},
    taskStatus: async () => ({ state: 'ready' }),
    sendTask: async () => ({ state: 'not_sent' }),
    subscribe: listener => {
      listeners.add(listener)

      return () => listeners.delete(listener)
    }
  }
}

export type CompanyMode = 'empty' | 'created' | 'invited' | 'members' | 'member' | 'removing' | 'left' | 'degraded' | 'team' | 'team2' | 'team-member'

const COMPANY_MODES: readonly CompanyMode[] = [
  'empty', 'created', 'invited', 'members', 'member', 'removing', 'left', 'degraded', 'team', 'team2', 'team-member'
]

/** One identity shared by the company directory, its validated room binding and chat fixtures. */
export const PLAYGROUND_COMPANY_ID = 'c1'
export const PLAYGROUND_COMPANY_CHANNEL_ID = '00000000-0000-4000-8000-a6350151b493'
export const PLAYGROUND_COMPANY_ROOM_ID = '!launch-company:example.invalid'

function companiesBridge(mode: CompanyMode): MatrixCompanyBridge {
  if (mode === 'team' || mode === 'team2' || mode === 'team-member') {
    return teamCompanyBridge(
      PLAYGROUND_COMPANY_ROOM_ID,
      PLAYGROUND_COMPANY_CHANNEL_ID,
      mode === 'team2',
      mode === 'team-member' ? 'member' : 'admin'
    )
  }

  const company = { id: PLAYGROUND_COMPANY_ID, displayName: 'Atum Studio', role: (mode === 'member' ? 'member' : 'admin') as 'admin' | 'member',
    authorityGeneration: 1 }

  const channelId = PLAYGROUND_COMPANY_CHANNEL_ID
  const announcementsId = '00000000-0000-4000-8000-01670d853f95'
  const roomId = PLAYGROUND_COMPANY_ROOM_ID

  const refs = {
    self: 'RiUVmyo5zEPwmNwDTzUkOZ9pssoNpuFAbofjwAsJyS8',
    linh: 'nkYQgariaJkLsqK5DOjopVirD0bIPbklFbIRgDxrgew',
    bao: 'DBmU8tVC5nRl7iK9TD1_HUAMix4-Oxfk7bPM6--O_T8',
    chi: 'Qb4yOWEGhKxrTtmzGJA-6CVFxwxjxoEvcX3R2mHddaU',
    removed: 'zCKifP-gRbcTfvfkPTU5D2RQFZUXphRuXqmRiJNlDW4'
  }

  const self: MatrixCompanyMember11 = { memberRef: refs.self, role: 'admin' as const, state: 'active' as const, self: true,
    handle: 'minh', displayName: 'Minh' }

  const linh: MatrixCompanyMember11 = { memberRef: refs.linh, role: 'member' as const, state: 'active' as const, self: false,
    handle: 'lan_nguyen', displayName: 'Lan Nguyễn', avatarUri: 'mxc://atumplatform.com/lan-avatar' }

  const bao: MatrixCompanyMember11 = { memberRef: refs.bao, role: 'member' as const, state: 'invited' as const, self: false,
    handle: 'bao_tran', displayName: null }

  const chi: MatrixCompanyMember11 = { memberRef: refs.chi, role: 'member' as const, state: 'revoking' as const, self: false,
    handle: 'chi', displayName: 'Chi' }

  const removed: MatrixCompanyMember11 = { memberRef: refs.removed, role: 'member' as const, state: 'removed' as const, self: false,
    handle: null, displayName: null }

  const membersByMode: Record<CompanyMode, MatrixCompanyMember11[]> = {
    empty: [],
    created: [self],
    invited: [],
    members: [self, linh, bao, chi, removed],
    member: [{ ...self, role: 'member' as const }, { ...linh, role: 'admin' as const }],
    removing: [self, chi],
    left: [],
    degraded: [self],
    team: [],
    team2: [],
    'team-member': []
  }

  let members: MatrixCompanyMember11[] = membersByMode[mode]
  let companies = mode === 'empty' || mode === 'invited' || mode === 'left' ? [] : [company]

  const v1 = (): MatrixCompanyBridge['request'] => async (input: MatrixCompanyRequest): Promise<MatrixCompanyResult> => {
    if (input.action === 'list') {
      return { ok: true, value: { schemaVersion: 1, companies, invitations: [] } }
    }

    if (input.action === 'read') {
      return { ok: true, value: { schemaVersion: 1, company, members: [
        { principal: '@minh:atum.chat', role: 'admin' as const, state: 'active' as const }
      ], projects: [] } }
    }

    if (input.action === 'list-channels') {
      return { ok: true, value: { schemaVersion: 1, channels: [{
        schemaVersion: 1,
        channel: { id: channelId, companyId: company.id, displayName: 'general', visibility: 'company' as const,
          state: 'active' as const, projectId: null, authorityGeneration: 1, channelGeneration: 1 },
        memberPrincipals: ['@minh:atum.chat'],
        room: { state: 'ready' as const, roomId }
      }] } }
    }

    return { ok: false, error: 'unavailable' }
  }

  const channels11 = { schemaVersion: 2 as const, channels: [
    { schemaVersion: 2 as const,
      channel: { id: channelId, companyId: company.id, displayName: 'general', visibility: 'company' as const,
        state: 'active' as const, projectId: null, authorityGeneration: 1, channelGeneration: 1, systemKey: 'default' as const },
      memberCount: Math.max(1, members.length),
      room: { state: 'ready' as const, roomId } },
    { schemaVersion: 2 as const,
      channel: { id: announcementsId, companyId: company.id, displayName: 'Công bố', visibility: 'company' as const,
        state: 'provisioning' as const, projectId: null, authorityGeneration: 1, channelGeneration: 1 },
      memberCount: Math.max(1, members.length),
      room: { state: 'provisioning' as const, roomId: null } }
  ] }

  const request: MatrixCompanyBridge['request'] = async input => {
    if (mode === 'degraded') { return v1()(input) }

    switch (input.action) {
      case 'list':
        return {
          ok: true,
          value: {
            schemaVersion: 2,
            companies,
            invitations: mode === 'invited' ? [{
              id: 'i1', companyId: 'c2', displayName: 'Lotus Co', role: 'member' as const,
              inviter: { handle: 'minh', displayName: 'Minh' }
            }] : [],
            canCreate: true
          }
        }

      case 'read':
        return { ok: true, value: { schemaVersion: 2, company, members, projects: [], defaultChannelId: channelId } }

      case 'list-channels':
        return { ok: true, value: channels11 }

      case 'accept':
        companies = [company]
        members = membersByMode.members

        return { ok: true, value: { schemaVersion: 2, company, members, projects: [], defaultChannelId: channelId } }

      case 'create':
        companies = [company]
        members = [self]

        return { ok: true, value: { schemaVersion: 2, company, members, projects: [], defaultChannelId: channelId } }

      case 'invite':
        if (input.memberHandle.replace(/^@/, '').toLowerCase() === 'nobody') {
          return { ok: false, error: 'missing' }
        }

        members = [...members, { ...bao, handle: input.memberHandle.replace(/^@/, '').toLowerCase() }]

        return { ok: true, value: { schemaVersion: 2, company, members, projects: [], defaultChannelId: channelId } }

      case 'remove-member':
        members = members.map(member => member.memberRef === input.memberRef
          ? { ...member, state: 'revoking' as const } : member)

        return { ok: true, value: { schemaVersion: 2, companyId: company.id, memberRef: input.memberRef,
          state: 'revoking', authorityGeneration: 2 } }

      case 'leave':
        companies = []

        return { ok: true, value: { schemaVersion: 2, companyId: company.id, state: 'revoking',
          retired: false, authorityGeneration: 2 } }

      default:
        return { ok: false, error: 'unavailable' }
    }
  }

  return {
    pending: async () => ({ ok: true, request: null }),
    request
  }
}

/** A plausible app icon (a tinted rounded square with an initial), drawn inline. */
function appIcon(letter: string, from: string, to: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 112 112"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect x="6" y="6" width="100" height="100" rx="24" fill="url(#g)"/><text x="56" y="72" font-family="-apple-system,Helvetica,Arial" font-size="46" font-weight="600" fill="#fff" text-anchor="middle">${letter}</text></svg>`

  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

const MAC_APPS: NativeAppEntry[] = [
  { id: 'word', name: 'Microsoft Word', bundleId: 'com.microsoft.Word', icon: appIcon('W', '#3f7de0', '#1f4fae') },
  { id: 'excel', name: 'Microsoft Excel', bundleId: 'com.microsoft.Excel', icon: appIcon('X', '#2fa060', '#18703f') },
  { id: 'notes', name: 'Notes', bundleId: 'com.apple.Notes', icon: appIcon('N', '#f8d34c', '#e9a719') },
  { id: 'safari', name: 'Safari', bundleId: 'com.apple.Safari', icon: appIcon('S', '#4fb6f6', '#1e74d8') },
  { id: 'figma', name: 'Figma', bundleId: 'com.figma.Desktop', icon: appIcon('F', '#a259ff', '#6a2cd1') },
  { id: 'calendar', name: 'Calendar', bundleId: 'com.apple.iCal', icon: appIcon('31', '#ff6b5e', '#d8382c') }
]

function nativeAppsBridge(): MatrixNativeAppsBridge {
  return {
    list: async () => MAC_APPS,
    launch: async request => {
      const app = MAC_APPS.find(entry => entry.id === request.appId) ?? MAC_APPS[0]!

      return { id: request.requestId, app, status: request.mode === 'beside' ? 'beside' : 'opened' }
    },
    end: async () => {},
    openArrangementSettings: async () => {},
    onEnded: () => () => {},
    readiness: async () => ({
      skills: [{ name: 'docx', enabled: true, description: 'Read and edit Word documents', category: 'productivity' }],
      support: {
        runtime: { kind: 'local', generation: 'playground' },
        commands: {},
        bundled: [{ name: 'docx', description: 'Read and edit Word documents', category: 'productivity' }],
        verified_bundled: ['docx'],
        routes: { docx: { operations: { read: { state: 'ready', reasons: [] } } } }
      }
    })
  }
}

function terminalsBridge(): MatrixTerminalBridge {
  return {
    open: async () => {},
    close: async () => {},
    read: async (_roomId, id) => ({
      id,
      scope: '',
      sequence: 1,
      output: '$ npm run dev\n\n  VITE ready in 312 ms\n\n  ➜  Local:   http://localhost:5173/\n'
    }),
    respond: async () => {},
    subscribe: () => () => {}
  }
}

function appsBridge(snapshot: () => MatrixSnapshot): NonNullable<MatrixUiBridge['apps']> {
  const ok = async () => ({ ok: true as const })

  return {
    onReturn: () => () => {},
    refresh: async () => {},
    menu: async appId => {
      const app = snapshot().apps?.apps.find(entry => entry.app_id === appId)

      if (!app) {
        throw new Error('playground_app_missing')
      }

      // Each fixture app's declared functions are data (app-look-fixtures.ts), never a branch here.
      const declared = PLAYGROUND_APP_MENUS[app.app]

      return { app, routes: declared?.routes ?? [], ...(declared?.actions ? { actions: declared.actions } : {}) }
    },
    history: async appId => {
      const app = snapshot().apps?.apps.find(entry => entry.app_id === appId)

      if (!app) {
        throw new Error('playground_app_missing')
      }

      return {
        profile: 'atum.app-history/1',
        appId: app.app_id,
        appVersionId: app.app_version_id,
        entries:
          app.app === 'moon'
            ? [
                {
                  id: 'moon-history-owner',
                  revision: 1,
                  occurredAt: Date.now() - 2 * 86_400_000,
                  role: 'owner' as const,
                  source: { id: 'web', label: { en: 'Moon web', vi: 'Moon web' } },
                  text: 'I would like a calm reading focused on the next three months.'
                },
                {
                  id: 'moon-history-app',
                  revision: 1,
                  occurredAt: Date.now() - 2 * 86_400_000 + 60_000,
                  role: 'app' as const,
                  source: { id: 'web', label: { en: 'Moon web', vi: 'Moon web' } },
                  text: 'Your chart points to a season for patient, deliberate choices.'
                }
              ]
            : [],
        nextCursor: null,
        hasMore: false,
        freshnessMs: 0
      }
    },
    connection: async () => {},
    chat: async () => null,
    group: async () => null,
    botInvite: async () => {},
    withdraw: async () => {},
    botStatus: async appId => {
      const app = snapshot().apps?.apps.find(entry => entry.app_id === appId)

      return app?.app === 'moon'
        ? {
            profile: 'atum.app-bot-status/1',
            consent: { state: 'accepted', disclosure_version: app.bot?.disclosure_version ?? 1 },
            link: { state: 'linked', ready: true, available: true }
          }
        : { profile: 'atum.app-bot-status/1', consent: { state: 'required', disclosure_version: 1 }, link: { state: 'never_linked', ready: false, available: false } }
    },
    botConsent: async () => ({ profile: 'atum.app-bot-status/1', consent: { state: 'accepted', disclosure_version: 1 }, link: { state: 'never_linked', ready: false, available: false } }),
    botRevoke: async () => ({ profile: 'atum.app-bot-status/1', consent: { state: 'revoked', disclosure_version: 1 }, link: { state: 'never_linked', ready: false, available: false } }),
    botOutcome: async () => ({ profile: 'atum.app-bot-outcome/1', state: 'none', code: null, action: null, locale: 'en' }),
    botApiMedia: async () => null,
    botIntakeStatus: async () => ({ complete: true, fields: [] }),
    botIntakeSubmit: async () => ({ complete: true, fields: [] }),
    send: async () => ({ eventId: '$app', result: { state: 'published' } }),
    invoke: async () => ({ state: 'published' }),
    view: {
      open: async () => ({ viewId: 'playground-app' }),
      setBounds: ok,
      setVisibility: ok,
      focus: ok,
      reload: ok,
      close: ok,
      onState: () => () => {}
    }
  } as NonNullable<MatrixUiBridge['apps']>
}

/** Settings › What Atum knows: every source Atum reads, all on, kept in the page. */
const PLAYGROUND_MACS: MatrixReachMac[] = [
  {
    id: 'air',
    name: 'MacBook Air',
    thisMac: true,
    state: 'needs_permission',
    sources: { messages: 'needs_permission', browser: 'needs_permission', location: 'off', folders: 'ready' }
  },
  { id: 'mini', name: 'Mac mini', thisMac: false, state: 'ready', sources: { messages: 'ready', browser: 'ready', location: 'off', folders: 'ready' } },
  { id: 'imac', name: 'iMac', thisMac: false, state: 'older' }
]

/** Main's projection (`macSourceStatus`) over the fixture Macs, with iMac's legacy narrow on Location. */
function withPlaygroundMacs(view: MatrixAgentSourcesView, mode: NonNullable<PlaygroundPlaces['macs']>): MatrixAgentSourcesView {
  const macs = mode === 'three' ? PLAYGROUND_MACS : []
  const gates = mode === 'three' ? { ...view.gates, location: false } : view.gates

  return {
    ...view,
    gates,
    macs,
    sources: view.sources.map(source => {
      const gate = source.optOutGate as 'messages' | 'browser' | 'location' | 'folders'

      if (!['messages', 'browser', 'location', 'folders'].includes(gate)) {
        return source
      }

      const heldOff = mode === 'three' && gate === 'location' ? ['iMac'] : []

      return { ...source, ...macSourceStatus(gates[gate], heldOff, macs, gate) }
    }),
    ...(mode === 'three' ? { notice: { sources: ['messages', 'browser', 'folders'] } } : {})
  }
}

function agentSourcesBridge(mode: PlaygroundPlaces['firstRunSources'], macs?: PlaygroundPlaces['macs']): MatrixAgentSourcesBridge {
  const enabled = mode === 'granted'

  let current: MatrixAgentSourcesView = {
    macs: [],
    gates: {
      google: enabled || mode === 'google-granted',
      folders: enabled,
      messages: enabled,
      browser: enabled,
      location: enabled,
      team_spaces: enabled
    },
    sources: (
      [
        ['google.mail', 'google'],
        ['google.calendar', 'google'],
        ['google.drive', 'google'],
        ['mac.files', 'folders'],
        ['mac.message-metadata', 'messages'],
        ['mac.browser-history', 'browser'],
        ['mac.location', 'location'],
        ['matrix.owner-rooms', 'team_spaces']
      ] as const
    ).map(([kind, optOutGate]) => ({
      kind,
      optOutGate,
      grantable: true,
      availability: 'available' as const,
      status: 'ready' as const
    }))
  }

  if (macs) {
    current = withPlaygroundMacs(current, macs)
  }

  return {
    read: async () => current,
    set: async (gate: MatrixAgentSourceGate, enabled: boolean) => {
      current = { ...current, gates: { ...current.gates, [gate]: enabled } }

      return current
    },
    // Shown, never accepted: the band keeps its words; nothing else changes in the page.
    presented: async () => undefined
  } as MatrixAgentSourcesBridge
}

/** Settings › Mac folders and the first-run folder checklist: macOS says yes in the page. */
function folderAccessBridge(): MatrixFolderAccessBridge {
  let current: MatrixFolderAccessView = {
    platform: 'macos',
    folders: MATRIX_STANDARD_FOLDERS.map(kind => ({ id: kind, kind, shared: true, mac: 'not-asked' as const }))
  }
  let added = 0

  return {
    read: async () => current,
    apply: async choices => {
      current = {
        ...current,
        folders: current.folders
          .filter(row => row.kind !== 'added' || choices[row.id] !== false)
          .map(row => {
            const shared = row.kind === 'added' ? true : (choices[row.id] ?? row.shared)

            return { ...row, shared, mac: shared ? 'granted' : row.mac }
          })
      }

      return current
    },
    add: async () => {
      const names = ['Clients', 'Photos 2026', 'Invoices']
      current = {
        ...current,
        folders: [
          ...current.folders,
          { id: `added:${added}`, kind: 'added', name: names[added % names.length], shared: true, mac: 'granted' }
        ]
      }
      added += 1

      return current
    },
    remove: async id => {
      current = { ...current, folders: current.folders.filter(row => row.id !== id) }

      return current
    }
  }
}

/** The bridges a place needs; every one of them is a harmless, in-page fake. */
export function playgroundPlaceBridges(places: PlaygroundPlaces, snapshot: () => MatrixSnapshot): Partial<MatrixUiBridge> {
  return {
    // App descriptors remain the authority for whether an app UI is reachable. Keeping the
    // harmless fake available lets canonical app-chat scenarios exercise the native surface
    // without a second URL capability switch.
    apps: appsBridge(snapshot),
    agentSources: agentSourcesBridge(places.firstRunSources, places.macs),
    folderAccess: folderAccessBridge(),
    ...(places.drive ? { drive: driveBridge(places.drive, places.driveProblem, places.driveEmpty, places.driveFacts) } : {}),
    // The product still gates Company UI on `companyWorkspaceEnabled`; this bridge only supplies
    // the synthetic directory authority once a fixture asks for it.
    companies: companiesBridge(places.company ?? 'members'),
    ...(places.macApps ? { nativeApps: nativeAppsBridge() } : {}),
    ...(places.offers ? { terminals: terminalsBridge() } : {})
  }
}

/** One plain company channel chat, so the chat list can show how a channel row reads. */
function companyChannelRoom(): MatrixRoom {
  return {
    id: PLAYGROUND_COMPANY_ROOM_ID,
    name: 'chung',
    membership: 'join',
    encrypted: false,
    roomType: MATRIX_COMPANY_CHANNEL_TYPE,
    companyChannel: { companyId: PLAYGROUND_COMPANY_ID, channelId: PLAYGROUND_COMPANY_CHANNEL_ID },
    createdAt: Date.now() - 3 * 86_400_000,
    lastActiveAt: Date.now() - 8 * 60_000,
    preview: { own: false, sender: 'Lan', kind: 'text', text: 'Chào cả nhà, mình vừa gửi bản nháp.',
      at: Date.now() - 8 * 60_000 }
  }
}

/** The snapshot facts a place adds on top of a signed-in scenario. */
export function withPlaygroundPlaces(snapshot: MatrixSnapshot, places: PlaygroundPlaces): MatrixSnapshot {
  if (!snapshot.identity || snapshot.state !== 'ready') {
    return snapshot
  }

  const companyChannel = places.company && !['empty', 'invited', 'left'].includes(places.company)
  const existingCompanyRoom = snapshot.rooms.find(room => room.id === PLAYGROUND_COMPANY_ROOM_ID)

  const boundCompanyRoom = existingCompanyRoom
    ? {
        ...existingCompanyRoom,
        encrypted: false,
        roomType: MATRIX_COMPANY_CHANNEL_TYPE,
        companyChannel: { companyId: PLAYGROUND_COMPANY_ID, channelId: PLAYGROUND_COMPANY_CHANNEL_ID }
      }
    : companyChannelRoom()

  const team = places.company === 'team' || places.company === 'team2' || places.company === 'team-member'
    ? teamRooms(existingCompanyRoom, PLAYGROUND_COMPANY_ROOM_ID, PLAYGROUND_COMPANY_CHANNEL_ID)
    : undefined

  return {
    ...snapshot,
    ...(team ? { rooms: [...team, ...snapshot.rooms.filter(room => !team.some(value => value.id === room.id))] } :
      companyChannel ? { rooms: [boundCompanyRoom, ...snapshot.rooms.filter(room =>
        room.id !== PLAYGROUND_COMPANY_ROOM_ID)] } : {}),
    ...(places.appMenus && snapshot.apps
      ? {
          // River takes part in chats and is linked, so its "…" offers every app action.
          apps: {
            ...snapshot.apps,
            apps: snapshot.apps.apps.map(app =>
              app.app === 'river'
                ? { ...app, matrix_room_context: 'addressed_only' as const, link: { mode: 'none' as const, state: 'linked' as const } }
                : app
            )
          }
        }
      : {}),
    ...(places.company ? { companyWorkspaceEnabled: true } : {}),
    // Observed presence for the Team Space people, so the faces that carry a dot draw one.
    ...(team ? { companyActivity: teamActivity(), presence: TEAM_PRESENCE } : {}),
    // A fixture channel's history is short: all of it is loaded, so its intro opens it.
    ...(team?.some(room => room.id === snapshot.roomId && room.companyChannel) ? { historyStart: true as const } : {}),
    ...(places.doc
      ? {
          linkedDocument:
            places.doc === 'word'
              ? { name: 'Kế hoạch Đà Lạt.docx', state: 'linked', revision: '1', kind: 'word' }
              : { name: 'ghi-chu-chuyen-di.md', state: 'linked', revision: '1' }
        }
      : {}),
    ...(places.offers && snapshot.roomId
      ? {
          webPreview: {
            id: 'preview-1',
            label: 'Trang đặt phòng',
            hostname: 'localhost:5173',
            expiresAt: Date.now() + 30 * MINUTE
          },
          terminals: [{ id: 'term-1', ordinal: 1, open: false }]
        }
      : {})
  }
}

/** What the side panel shows for the linked document in `?doc=`. */
export function playgroundDocumentPreview(places: PlaygroundPlaces) {
  if (places.doc === 'word') {
    return {
      token: 'preview',
      name: 'Kế hoạch Đà Lạt.docx',
      kind: 'word' as const,
      saved: false,
      text: 'Kế hoạch Đà Lạt\n\nNgày 1: dạo quanh hồ Xuân Hương, cà phê ở Trại Mát.\nNgày 2: hồ Tuyền Lâm buổi sáng, trưa ở khu phố Pháp.\nNgày 3: chợ hoa, xe sớm về.'
    }
  }

  return {
    token: 'preview',
    name: 'ghi-chu-chuyen-di.md',
    kind: 'text' as const,
    text: '# Ghi chú chuyến đi\n\n- Đặt homestay gần hồ Tuyền Lâm\n- Mang áo khoác: tối 14°C\n- Thử cà phê ở Trại Mát\n'
  }
}
