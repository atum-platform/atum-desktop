import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

// Static-analysis guards for the Atum product shell. These are lint-shaped
// rules expressed as tests so they run with the suite — each one exists because
// breaking it would silently undo a product decision, not because it is a
// style preference.

const ATUM_DIR = resolve(__dirname)

const sources = readdirSync(ATUM_DIR, { recursive: true })
  .map(entry => String(entry))
  .filter(entry => (entry.endsWith('.tsx') || entry.endsWith('.ts')) && !entry.includes('.test.'))
  .map(entry => [entry, readFileSync(join(ATUM_DIR, entry), 'utf8')] as const)

const DM_DIR = resolve(ATUM_DIR, '../dm')

const dmSourceEntries = readdirSync(DM_DIR, { recursive: true })
  .map(entry => String(entry))
  .filter(entry => (entry.endsWith('.tsx') || entry.endsWith('.ts')) && !entry.includes('.test.'))
  .map(entry => [`dm/${entry}`, readFileSync(join(DM_DIR, entry), 'utf8')] as const)

function stripCommentsAndStrings(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '')
}

describe('Atum shell — tokens, not literals', () => {
  it.each(sources)('%s uses CSS variables for every colour', (_name, source) => {
    const code = stripCommentsAndStrings(source)

    // Raw hex and ad-hoc rgba are how a design system rots. Everything here
    // must be a var(--atum-*) / var(--ui-*) or a semantic Tailwind token.
    expect(code).not.toMatch(/#[0-9a-fA-F]{3,8}\b/u)
    expect(code).not.toMatch(/\brgba?\(/u)
  })
})

describe('Atum roster — S1 one-list and integrated badge contract', () => {
  const panel = readFileSync(join(ATUM_DIR, 'roster-panel.tsx'), 'utf8')
  const localeTypes = readFileSync(resolve(ATUM_DIR, '../../i18n/types.ts'), 'utf8')

  it('renders one flat roster without legacy group headings', () => {
    expect(panel).toContain('data-roster-list')
    // One list: an agent group per agent (each agent's chats nested inside)
    // followed by hosted rows, with no section headings in between.
    expect(panel).toContain('renderAgentGroups()')
    expect(panel).toContain('hostedEntries.map(renderRow)')
    expect(panel).toContain('data-roster-chats')

    for (const key of ['groupAssistant', 'groupApps', 'groupPeople']) {
      expect(panel).not.toContain(key)
      expect(localeTypes).not.toContain(key)
    }
  })

  it('keeps the row to one plain secondary line — no verified tick, no ownership chip (SPEC §5)', () => {
    expect(panel).toContain('data-roster-secondary')
    expect(panel).not.toContain('data-testid="verified-badge"')
    expect(panel).not.toMatch(/badgeShort[\s\S]{0,300}(?:border|rounded|bg-)\(/u)
  })

  it('uses Atum geometry and typography tokens for every roster-row literal', () => {
    expect(panel).not.toMatch(/(?:text|leading|rounded|size|h|min-h|min-w|w)-\[[0-9.]+px\]/u)
    expect(panel).not.toContain('--ui-')
    expect(panel).not.toContain('--conversation-')
    expect(panel).toContain('text-(length:--atum-t-caption)')
    expect(panel).toContain('size-(--atum-avatar-md)')
  })
})

describe('Atum shell — every icon-only control carries a tooltip', () => {
  it.each(sources.filter(([name]) => name.endsWith('.tsx')))('%s wraps icon buttons in <Tip>', (_name, source) => {
    const iconButtons = source.match(/size="icon[^"]*"/gu)?.length ?? 0

    if (iconButtons === 0) {
      return
    }

    // One <Tip> per icon-only button, at minimum.
    expect((source.match(/<Tip\b/gu) ?? []).length).toBeGreaterThanOrEqual(iconButtons)
    expect(source).not.toMatch(/\btitle=/u)
  })
})

describe('Atum Discover — product surface invariants', () => {
  const discoverNames = [
    'discover-panel.tsx',
    'discover-skills-section.tsx',
    'add-skill-dialog.tsx',
    'skill-detail-dialog.tsx'
  ]

  const discoverSources = discoverNames.map(name => [name, readFileSync(join(ATUM_DIR, name), 'utf8')] as const)

  it.each(discoverSources)('%s uses Atum geometry, typography and colour vocabulary', (_name, source) => {
    expect(source).not.toMatch(/(?:text|leading|rounded|size|h|min-h|min-w|w)-\[[0-9.]+px\]/u)
    expect(source).not.toContain('--ui-')
    expect(source).not.toContain('--conversation-')
  })

  it('keeps Discover browse-first instead of moving focus on mount', () => {
    const source = discoverSources.map(([, value]) => value).join('\n')
    expect(source).not.toContain('autoFocus')
    expect(source).not.toContain('.focus()')
  })

  it('uses the App Store pill vocabulary in the locale contract', () => {
    const localeTypes = readFileSync(resolve(ATUM_DIR, '../../i18n/types.ts'), 'utf8')
    const discover = localeTypes.slice(localeTypes.indexOf('    discover: {'), localeTypes.indexOf('    empty: {'))
    expect(discover).toContain('free: string')
    expect(discover).toContain('open: string')
    expect(discover).toContain('try: string')
    expect(discover).not.toContain('start: string')
    expect(discover).not.toContain('connected: string')
  })
})

describe('Atum shell — no Hermes nouns reach the product surface', () => {
  const FORBIDDEN = [
    '$sessions',
    '$profiles',
    '$projects',
    '$cronSessions',
    '$pinnedSessionIds',
    'LayoutTreeRoot',
    // The rim is macOS/Hermes GEOMETRY with Atum contents — the Hermes
    // titlebar surface itself must never be wired back in.
    'WiredPane part="titlebar"'
  ]

  // The rule this fence enforces, restated 2026-09-04: something a person
  // would recognise as THEIRS may be product — an assistant, a chat, a folder.
  // The plumbing that exists only to organise the engine stays hidden.
  //
  // Two crossings pass that test and no others. Assistant CHATS are product
  // (one identity, many conversations — the model every consumer assistant
  // uses), so `assistant-chats.ts` is the one sanctioned reader of
  // `$sessions`. AGENTS are product (a person makes an assistant for a job
  // and gives it a name), so `agents.ts` is the one sanctioned reader of
  // `$profiles`. Each projects rows free of every OTHER Hermes noun, and each
  // fences its own import graph in its own test file.
  //
  // Projects, worktrees, branches, pins, and cron have never passed and are
  // not expected to: nobody outside engineering wants them.
  const SANCTIONED: Record<string, readonly string[]> = {
    'agents.ts': ['$profiles'],
    'assistant-chats.ts': ['$sessions']
  }

  it.each(sources)('%s stays out of the Hermes organisation stores', (name, source) => {
    const code = stripCommentsAndStrings(source)
    const allowed = SANCTIONED[name] ?? []

    for (const noun of FORBIDDEN.filter(candidate => !allowed.includes(candidate))) {
      expect(code, `${noun} must not appear in the Atum shell`).not.toContain(noun)
    }
  })

  it('sanctions exactly two crossings, for chats and for agents, and nothing else', () => {
    expect(Object.keys(SANCTIONED).sort()).toEqual(['agents.ts', 'assistant-chats.ts'])

    for (const name of Object.keys(SANCTIONED)) {
      expect(sources.some(([source]) => source === name)).toBe(true)
    }

    // Each crossing reads exactly one store, and never the other's.
    expect(SANCTIONED['agents.ts']).toEqual(['$profiles'])
    expect(SANCTIONED['assistant-chats.ts']).toEqual(['$sessions'])
  })
})

describe('Atum shell — continuous chrome and destination rail', () => {
  const styles = readFileSync(resolve(ATUM_DIR, '../../styles.css'), 'utf8')
  const shell = readFileSync(join(ATUM_DIR, 'shell.tsx'), 'utf8')
  const shellFrame = readFileSync(join(ATUM_DIR, 'shell-frame.tsx'), 'utf8')

  it('keeps retired floating chrome out while mounting the shared destination rail', () => {
    expect(existsSync(join(ATUM_DIR, 'rim.tsx'))).toBe(false)
    expect(existsSync(join(ATUM_DIR, 'rail.tsx'))).toBe(false)
    expect(shell).not.toContain('AtumRim')
    expect(shell).not.toContain('AtumRail')
    expect(shell).not.toContain('productTitle')
    expect(styles).toContain('--atum-rim-h: 0px')
    expect(shellFrame).toContain('data-atum-destination-rail')
  })

  // The rail and columns align to the one chrome-band height; column rows are
  // still the drag regions and the shell root is not.
  it('drags from aligned chrome rows only', () => {
    // Workspace now delegates its header to the shared surface; its rendered
    // drag region is covered in workspace-panel.test.tsx, not source spelling.
    for (const file of ['roster-panel.tsx', 'shell-surface.tsx']) {
      expect(readFileSync(join(ATUM_DIR, file), 'utf8'), file).toContain('h-(--atum-l-header)')
      expect(readFileSync(join(ATUM_DIR, file), 'utf8'), file).toContain('[-webkit-app-region:drag]')
    }

    expect(shell).not.toContain('data-atum-top-bar')
    // The root declares no region at all (2026-11-05): shell-frame.test.tsx covers the rendered strip.
    expect(shellFrame).not.toContain('overflow-hidden text-(--atum-ink) [-webkit-app-region:drag]')
  })

  // The window controls — the native light reservation and the sidebar toggle
  // — are one component, rendered at the start of whichever row is leftmost.
  // Three rows can host them; none of them may draw its own reservation, and
  // none may re-pad for a leading pill: that threading is how the drift got
  // three places to happen last time.
  it('renders the window controls from one component, on whichever row is leftmost', () => {
    const roster = readFileSync(join(ATUM_DIR, 'roster-panel.tsx'), 'utf8')
    const header = readFileSync(join(ATUM_DIR, 'main-header.tsx'), 'utf8')
    const workspace = readFileSync(join(ATUM_DIR, 'workspace-panel.tsx'), 'utf8')
    const chatPanel = readFileSync(join(ATUM_DIR, 'chat-panel.tsx'), 'utf8')

    expect(existsSync(join(ATUM_DIR, 'traffic-light-pill.tsx'))).toBe(false)
    expect(existsSync(join(ATUM_DIR, 'top-bar.tsx'))).toBe(false)
    expect(shell).not.toContain('AtumTopBar')
    expect(shell).not.toContain('AtumTrafficLightPill')

    const hosts = sources.filter(([, source]) => source.includes('data-atum-traffic-lights')).map(([name]) => name)
    expect(hosts).toEqual(['shell-surface.tsx'])

    for (const [name, source] of [
      ['roster-panel.tsx', roster],
      ['main-header.tsx', header],
      ['workspace-panel.tsx', workspace]
    ] as const) {
      expect(source, name).toContain('<AtumWindowControls')
      expect(source, name).not.toContain('reserveLights')
    }

    expect(chatPanel).not.toContain('leading')

    // Drawer lifecycle/inertness is exercised by shell-frame.test.tsx, not
    // frozen to source spelling. Keep the existing placeholder check below.
    expect(shell).toContain(
      'fallback={<AtumWorkspacePlaceholder overFrame={workspaceIsDrawer || workspaceFullFrame} />}'
    )
    expect(shell).toMatch(
      /export function AtumWorkspacePlaceholder[\s\S]*?data-atum-workspace-loading>[\s\S]*?<AtumWindowControls \/>/u
    )
  })

  // The lights are centred on the band by construction: one constant, derived
  // from the same 48 the CSS token holds, and main.ts imports it rather than
  // keeping a copy. Two copies of this number is how the lights came to land
  // 7px below the row after the auth window handed the product window back.
  it('positions the native lights on the row’s centre line, from one constant', () => {
    const electron = readFileSync(resolve(ATUM_DIR, '../../../electron/main.ts'), 'utf8')
    const windowMode = readFileSync(resolve(ATUM_DIR, '../../../electron/atum-window-mode.ts'), 'utf8')

    expect(styles).toContain('--atum-l-header: 48px')
    expect(windowMode).toContain('export const ATUM_SHELL_HEADER_HEIGHT = 48')
    expect(windowMode).toContain('x: 20')
    expect(windowMode).toContain('y: (ATUM_SHELL_HEADER_HEIGHT - MACOS_TRAFFIC_LIGHTS_HEIGHT) / 2')
    expect(electron).toContain('const WINDOW_BUTTON_POSITION = ATUM_SHELL_WINDOW_BUTTON_POSITION')
    expect(electron).not.toMatch(/const WINDOW_BUTTON_POSITION = \{/u)
  })

  it('keeps initials neutral and the rail account face free of status dots', () => {
    const initials = ['assistant-avatar.tsx', 'chat-header.tsx', 'start-chat-dialog.tsx', 'roster-panel.tsx']
      .map(name => readFileSync(join(ATUM_DIR, name), 'utf8'))
      .join('\n')
    const avatarHelpers = readFileSync(resolve(ATUM_DIR, '../../lib/atum-avatar.ts'), 'utf8')
    const account = readFileSync(resolve(ATUM_DIR, '../../matrix/rail-account.tsx'), 'utf8')

    expect(initials).toContain('bg-(--ak-fill-quiet)')
    expect(initials).toContain('text-(--ak-ink-2)')
    expect(initials).not.toMatch(/ATUM_AVATAR_TINTS|atumAvatarTintIndex|avatarTint|color-mix/u)
    expect(avatarHelpers).not.toMatch(/ATUM_AVATAR_TINTS|atumAvatarTintIndex/u)
    expect(account).not.toContain('atum-rail-account-dot')
    expect(styles).not.toContain('.atum-rail-account-dot')
  })
})

describe('Atum conversation surfaces — presentation, never wire data', () => {
  const details = readFileSync(join(ATUM_DIR, 'workspace-panel.tsx'), 'utf8')
  const dm = readFileSync(resolve(ATUM_DIR, '../dm/index.tsx'), 'utf8')

  const dmSources = readdirSync(resolve(ATUM_DIR, '../dm'))
    .filter(entry => entry.endsWith('.tsx') && !entry.includes('.test.'))
    .map(entry => readFileSync(resolve(ATUM_DIR, '../dm', entry), 'utf8'))
    .join('\n')

  it('routes workspace identity through the shared presentation adapter', () => {
    expect(details).toContain('presentAtumConversation(conversation, locale, { accountId, people }, catalog)')
    expect(details).not.toContain("participantIds.join(', ')")
    expect(details).not.toMatch(/conversation\.(?:id|updatedAt|lastMessageAt)\s*\}/u)
  })

  it('does not stack a second DM identity header', () => {
    expect(dm).not.toContain('DmHeader')
    expect(dm).not.toMatch(/<header\b/u)
  })

  it('keeps ambient connectivity out of the transcript plate', () => {
    const chatPanel = readFileSync(join(ATUM_DIR, 'chat-panel.tsx'), 'utf8')

    expect(chatPanel).not.toContain('$atumConnectivity')
    expect(chatPanel).not.toMatch(/role="status"/u)
  })

  it('uses Atum material tokens throughout app and P2P chat', () => {
    expect(dmSources).not.toContain('--ui-')
  })
})

describe('Atum sheets — fields never masquerade as confirmation dialogs', () => {
  it('keeps Start a chat on the kit form-sheet anatomy', () => {
    const source = readFileSync(resolve(ATUM_DIR, '../../matrix/start-chat.tsx'), 'utf8')

    for (const part of ['ak-sheet', 'ak-sheet-head', 'ak-sheet-title', 'ak-field--search', 'ak-row', 'ak-section', 'ak-sheet-foot']) {
      expect(source).toContain(part)
    }

    expect(source).not.toContain('DialogHeader')
    expect(source).not.toContain('SearchField')
    expect(source).not.toContain('ak-btn--primary')
  })
})

describe('Atum Settings — adjudicated kit contracts', () => {
  const settings = readFileSync(resolve(ATUM_DIR, '../../matrix/settings-revamp.tsx'), 'utf8')
  const rows = readFileSync(resolve(ATUM_DIR, '../../matrix/settings-row.tsx'), 'utf8')
  const sheet = readFileSync(resolve(ATUM_DIR, '../../matrix/settings-sheet.tsx'), 'utf8')
  const preferences = readFileSync(resolve(ATUM_DIR, '../../../shared/matrix-display-preferences.ts'), 'utf8')
  const display = readFileSync(resolve(ATUM_DIR, '../../matrix/display-settings.tsx'), 'utf8')
  const chat = readFileSync(resolve(ATUM_DIR, '../../matrix/app.tsx'), 'utf8')

  it('has no model-picker display preference or composer gate', () => {
    expect(preferences).not.toContain('modelPicker')
    expect(display).not.toContain('modelPicker')
    expect(chat).not.toMatch(/displayPreferences[^\n]*modelPicker/u)
  })

  it('uses kit section, group, row and page-title roles', () => {
    expect(rows).toContain('ak-section')
    expect(rows).toContain('ak-group')
    expect(rows).toContain('ak-row')
    expect(sheet).toContain('[font:var(--ak-t-title)]')
  })

  it('keeps identity and handles on Account, not in a second Public handle section', () => {
    expect(settings).toContain('data-matrix-settings-identity')
    expect(settings).not.toContain('MatrixAliasSettings')
    expect(settings).toContain('data-matrix-settings-account-actions')
  })

  it('keeps Advanced to the assistant chooser, Model, Repair and For developers', () => {
    expect(settings).not.toContain('hermesSetupCopy')
    expect(settings).not.toContain('MatrixDeviceIsolationSetting')
    expect(settings).toContain('title={copy.model}')
    expect(settings).toContain('title={copy.repair}')
    expect(settings).toContain('title={copy.expertTools}')
  })
})

describe('Atum Team Space — R8 company chrome contract', () => {
  const chat = readFileSync(resolve(ATUM_DIR, '../../matrix/app.tsx'), 'utf8')
  const tabs = readFileSync(resolve(ATUM_DIR, '../../matrix/company-space-tabs.tsx'), 'utf8')
  const channelMenu = readFileSync(resolve(ATUM_DIR, '../../matrix/company-channel-menu.tsx'), 'utf8')
  const channelSections = readFileSync(resolve(ATUM_DIR, '../../matrix/team-space/channel-sections.tsx'), 'utf8')
  const kit = readFileSync(resolve(ATUM_DIR, '../../../../../packages/atum-kit/components.css'), 'utf8')

  it('uses the small kit segmented control with the boards\' raised selected segment in both ramps', () => {
    expect(tabs).toContain('className="ak-seg ak-seg--sm"')
    // FlowStore/FlowSettings boards: a raised white chip with the first shadow; raised grey in dark.
    expect(kit).toMatch(/\.ak-seg > \.is-selected \{ background: var\(--ak-surface\);[^}]*box-shadow: var\(--ak-shadow-1\);/u)
    expect(kit).toMatch(/\.dark \.ak-seg > \.is-selected \{ background: var\(--ak-raised\);/u)
  })

  it('orders member faces, search and the overflow menu without a standalone threads control', () => {
    const faces = chat.indexOf('{companyChannel && <MatrixCompanyMembersButton snapshot={snapshot} />}')
    const search = chat.indexOf('{companyChannel && search}', faces)
    const menu = chat.indexOf('<MatrixCompanyChannelMenu', search)

    expect(faces).toBeGreaterThan(0)
    expect(search).toBeGreaterThan(faces)
    expect(menu).toBeGreaterThan(search)
    expect(channelMenu).toContain('{threads.openThreads}')
  })

  // Preserve user-visible identity, state and recovery behavior across connection changes.
  // behaviour in team-space-slack-layout.test.tsx, not by reading its source.
  it('keeps channel creation in the section header', () => {
    expect(channelSections).toContain('action={canAdd ? addMenu(')
    expect(channelSections).not.toContain('TeamSpaceSidebarAddRow')
  })
})

describe('Atum chat — adjudicated everyday-message contracts', () => {
  const chat = readFileSync(resolve(ATUM_DIR, '../../matrix/app.tsx'), 'utf8')
  const actions = readFileSync(resolve(ATUM_DIR, '../../matrix/message-actions.tsx'), 'utf8')
  const greeting = readFileSync(resolve(ATUM_DIR, '../../matrix/greeting.tsx'), 'utf8')
  const starter = readFileSync(resolve(ATUM_DIR, '../../matrix/starter-notice.tsx'), 'utf8')
  const working = readFileSync(resolve(ATUM_DIR, '../../matrix/typing-indicator.tsx'), 'utf8')
  const undecryptable = readFileSync(resolve(ATUM_DIR, '../../matrix/undecryptable-message.tsx'), 'utf8')

  it('implements R9 as four small kit actions under an answer', () => {
    expect(chat).toContain('data-matrix-answer-actions')
    expect(chat.match(/className="ak-iconbtn ak-iconbtn--sm"/gu)?.length).toBeGreaterThanOrEqual(3)
    expect(chat).toContain('appearance="icon" buttonSize="icon-sm" className="ak-iconbtn ak-iconbtn--sm"')
    expect(chat).toContain("latest ? '' : 'opacity-0 group-hover/message:opacity-100 group-focus-within/message:opacity-100'")
  })

  it('keeps failure, working and greeting states on kit anatomy', () => {
    expect(actions).toContain('copy.notSentOffline')
    expect(actions).toContain('ak-btn ak-btn--plain ak-btn--sm')
    expect(undecryptable).not.toMatch(/\bLock\b/u)
    expect(working).toContain('<AtumAtom className="ak-icon text-(--ak-ink-2)" data-working />')
    expect(working).toContain('data-matrix-steps-list')
    expect(greeting).toContain('size-(--atum-avatar-lg)')
    expect(greeting).toContain('[font:var(--ak-t-body)] text-(--ak-ink-2)')
    // A composer notice: inside the composer's glass (STYLE.md §10), not a band of its own.
    expect(starter).toContain('data-matrix-starter-notice')
    expect(starter).not.toContain('ProtonAmount')
  })
})

describe('Atum Store and Drive — R13 destination contracts', () => {
  const store = readFileSync(resolve(ATUM_DIR, '../../matrix/store/discover-view.tsx'), 'utf8')
  const card = readFileSync(resolve(ATUM_DIR, '../../matrix/store/store-card.tsx'), 'utf8')
  const drive = readFileSync(resolve(ATUM_DIR, '../../matrix/drive.tsx'), 'utf8')

  it('keeps the Store balance singular and every catalog row to one kit action', () => {
    expect(store).toContain('[font:var(--ak-t-display)]')
    expect(store).toContain('className="ak-btn ak-btn--plain ak-btn--sm"')
    // The single balance (Proton mark + number) is asserted on the rendered Store in store.test.tsx.
    expect(card).toContain('className="ak-btn ak-btn--sm"')
    expect(card).not.toContain('atum-store-eyebrow')
    // Each item draws its own Phosphor glyph, its kind's as the fallback; the catalog's emoji is
    // only a lookup key and is never drawn (store-card.test.tsx renders that).
    expect(card).toContain('storeGlyphIcon')
    expect(card).toContain('STORE_KIND_ICON')
  })

  it('keeps Drive title-bar status concise and moves file actions behind kit controls', () => {
    expect(drive).toContain('data-matrix-drive-titlebar')
    expect(drive).toContain('className="ak-seg ak-seg--sm"')
    expect(drive).toContain('className="ak-field ak-field--search"')
    expect(drive).toContain('<DropdownMenuItem disabled={busy} onSelect={() => void run(() => bridge.reveal())}>')
    expect(drive).not.toContain('data-matrix-drive-refresh')
  })
})

describe('Atum side panel — adjudicated new-tab contract', () => {
  const launcher = readFileSync(resolve(ATUM_DIR, '../../matrix/workbench-launcher.tsx'), 'utf8')
  const nativeApps = readFileSync(resolve(ATUM_DIR, '../../matrix/native-apps.tsx'), 'utf8')
  const tabs = readFileSync(join(ATUM_DIR, 'workspace-surface.tsx'), 'utf8')

  // Preserve user-visible identity, state and recovery behavior across connection changes.
  // "no Tools section" and label-row actions are superseded. Behaviour lives in workbench.test.tsx.
  it('puts one search field at the top and no browser navigation on a new tab', () => {
    expect(launcher).toContain('className="ak-field ak-field--search"')
    expect(launcher).toContain('copy.searchWeb')
    expect(launcher).not.toMatch(/ChevronLeft|ChevronRight|RefreshCw/u)
  })

  it('shortens native app names', () => {
    expect(nativeApps).toContain('nativeAppShortName')
    expect(nativeApps).toContain('className="w-full truncate text-center"')
  })

  it('uses a real close x inside the selected glass tab chip', () => {
    expect(tabs).toContain('active tab a glass')
    expect(tabs).toContain('<X className="size-3" />')
    expect(tabs).not.toMatch(/ChevronDown|ChevronRight/u)
  })
})

describe('Atum Shell v2 — one opaque ground, one glass plate, SPEC §1 tokens', () => {
  const styles = readFileSync(resolve(ATUM_DIR, '../../styles.css'), 'utf8')
  const shell = readFileSync(join(ATUM_DIR, 'shell.tsx'), 'utf8')
  const shellFrame = readFileSync(join(ATUM_DIR, 'shell-frame.tsx'), 'utf8')
  const chatView = readFileSync(resolve(ATUM_DIR, '../chat/index.tsx'), 'utf8')
  const electronMain = readFileSync(resolve(ATUM_DIR, '../../../electron/main.ts'), 'utf8')
  const indexHtml = readFileSync(resolve(ATUM_DIR, '../../../index.html'), 'utf8')
  const light = styles.match(/\n\.atum-shell,\n[^{]*\{([\s\S]*?)\n\}/u)?.[1] ?? ''
  const dark = styles.match(/\n\.dark \.atum-shell,\n[^{]*\{([\s\S]*?)\n\}/u)?.[1] ?? ''

  it('never mounts the legacy Hermes image backdrop in the product transcript', () => {
    expect(chatView).not.toContain('@/components/Backdrop')
    expect(chatView).not.toContain('<Backdrop')
  })

  // The shell root paints the frame and each column its panel below the
  // titlebar band; the document paints nothing, so that on macOS — vibrancy
  // behind a clear backing — the frame and the launch screen can be tints the
  // desktop frosts through. Elsewhere the document is pre-painted in the ground
  // colour and the frame paints its opaque shade over it.
  it('paints the frame on the shell root and the panels below the band, and keeps the document clear under vibrancy', () => {
    expect(electronMain).toContain("const ATUM_WINDOW_GROUND_LIGHT = '#F4F5F7'")
    expect(electronMain).toContain("const ATUM_WINDOW_GROUND_DARK = '#17181C'")
    expect(electronMain).toContain("const ATUM_WINDOW_VIBRANCY = 'sidebar'")
    expect(electronMain).toContain('vibrancy: IS_MAC ? ATUM_WINDOW_VIBRANCY : undefined')
    expect(electronMain).toContain('backgroundColor: IS_MAC ? TRANSPARENT_WINDOW_BACKGROUND : atumWindowGroundColor()')
    expect(indexHtml).toContain("setAttribute('data-atum-vibrancy', 'sidebar')")
    expect(indexHtml).toContain("scheme === 'dark' ? '#17181C' : '#F4F5F7'")
    expect(styles).toMatch(/\.atum-shell \{\n {2}background: transparent;\n\}/u)
    expect(styles).toMatch(/\[data-atum-shell\] \{\n {2}background: var\(--atum-frame-bg\);\n\}/u)
    expect(styles).toMatch(/html\[data-atum-vibrancy\] \[data-atum-shell\] \{\n {2}background: var\(--atum-frame-tint\);\n\}/u)
    expect(styles).toMatch(/\[data-atum-main\]::before \{[^}]*background: var\(--atum-main-bg\);/u)
    expect(styles).toMatch(/html:has\(\.atum-shell\),[\s\S]*?background:\s*var\(--atum-bg\) !important/u)
    // Gated on the product shell: the legacy chrome, a secondary window and the
    // pet overlay load the same document and must not go clear.
    expect(styles).toMatch(
      /html\[data-atum-vibrancy\]:has\(\.atum-shell\),\nhtml\[data-atum-vibrancy\]:has\(\.atum-shell\) body,\nhtml\[data-atum-vibrancy\]:has\(\.atum-shell\) #root \{\n {2}background: transparent !important;\n\}/u
    )
    expect(styles).not.toMatch(/^html\[data-atum-vibrancy\],$/mu)
    expect(indexHtml).toContain("localStorage.getItem('hermes.desktop.atum.shell') !== 'false'")
    expect(shellFrame).toContain('data-atum-main')
    // Vibrancy blurs; CSS tints. Never both on one surface: the CSS blur would
    // promote the column to a backdrop root that paints over the native frost.
    expect(styles).toMatch(
      /html\[data-atum-vibrancy\] \.atum-sidebar:not\(\[data-atum-drawer='true'\]\) \{\n {2}-webkit-backdrop-filter: none;/u
    )
  })

  it('tints the launch screen and the auth window, and paints the welcome on the ground', () => {
    const connecting = readFileSync(resolve(ATUM_DIR, '../../components/gateway-connecting-overlay.tsx'), 'utf8')
    const authFrame = readFileSync(join(ATUM_DIR, 'auth-frame.tsx'), 'utf8')
    const welcome = readFileSync(join(ATUM_DIR, 'welcome-storyboard.tsx'), 'utf8')

    expect(connecting).toContain("'atum-shell atum-launch fixed inset-0")
    expect(connecting).not.toContain('atum-window-ground')
    expect(styles).toMatch(/\.atum-launch \{\n {2}background: var\(--atum-launch-tint\);\n\}/u)
    // Both ramps, and the opaque projection under reduced transparency.
    expect(styles).toContain('--atum-launch-tint: rgba(244, 245, 247, 0.55)')
    expect(styles).toContain('--atum-launch-tint: rgba(23, 24, 28, 0.55)')
    expect(styles).toContain('--atum-launch-tint: #F4F5F7')
    expect(authFrame).toContain('atum-window-ground')
    expect(welcome).toContain('atum-welcome absolute inset-0 z-50 overflow-hidden atum-window-ground')
  })

  // `.atum-sidebar` is THE material; chat and workspace carry none and sit on
  // the window ground the main column paints. The Hermes transcript paints
  // `--ui-chat-surface-background`, which inside the shell resolved to the FLAT
  // `--atum-bg` — an opaque rectangle over the gradient, seaming down the whole
  // chat column and reading as a line under the sidebar's foot.
  it('keeps the chat column transparent so one ground runs under the floating plate', () => {
    expect(styles).toMatch(/\[data-atum-chat\] \{\n {2}--ui-chat-surface-background: transparent;\n\}/u)

    // The stranded-session veil is an overlay, not the ground: it must stay
    // opaque exactly where the ground went transparent.
    expect(chatView).toContain('bg-(--ui-chat-veil)')
    expect(styles).toContain('--ui-chat-veil: var(--atum-overlay-canvas)')

    // Nor is every card in the transcript the ground: a clarification card or
    // an edit box has to occlude what is behind it, so it keeps a material.
    expect(styles).toMatch(
      /\[data-atum-chat\] \[data-slot='clarify-inline'\],\n\[data-atum-chat\] \.composer-human-message-container \{/u
    )
  })

  it('declares the SPEC §1 light and dark palettes verbatim', () => {
    for (const token of [
      '--atum-bg: #F4F5F7',
      '--atum-bg-high: #FBFBFC',
      '--atum-bg-low: #EEF0F3',
      '--atum-glass: rgba(255, 255, 255, 0.62)',
      '--atum-glass-strong: rgba(255, 255, 255, 0.82)',
      '--atum-card: rgba(255, 255, 255, 0.7)',
      '--atum-sunk: rgba(23, 25, 31, 0.05)',
      '--atum-hover: rgba(23, 25, 31, 0.06)',
      '--atum-pressed: rgba(23, 25, 31, 0.1)',
      '--atum-line: rgba(23, 25, 31, 0.07)',
      '--atum-line-strong: rgba(23, 25, 31, 0.12)',
      '--atum-ink: #1B1D22',
      '--atum-ink-soft: #3B3F47',
      '--atum-ink-muted: #5F646D',
      '--atum-ink-faint: #9096A0',
      '--atum-ink-ghost: #B3B8BF',
      '--atum-accent: var(--atum-ink)',
      '--atum-on-accent: #F4F5F7',
      '--atum-danger: #B42318',
      '--atum-warn: #8A5A00',
      '--atum-focus: rgba(23, 25, 31, 0.35)',
      '--atum-glass-blur: blur(30px) saturate(1.4)',
      '--atum-sheet-blur: blur(40px) saturate(1.5)'
    ]) {
      expect(light).toContain(token)
    }

    for (const token of [
      '--atum-bg: #17181C',
      '--atum-bg-high: #1E2025',
      '--atum-bg-low: #121316',
      '--atum-glass: rgba(255, 255, 255, 0.055)',
      // Preserve user-visible identity, state and recovery behavior across connection changes.
      '--atum-glass-strong: rgba(45, 45, 45, 0.96)',
      '--atum-card: rgba(255, 255, 255, 0.06)',
      '--atum-ink: #ECEDF0',
      '--atum-ink-muted: #9DA2AB',
      '--atum-ink-faint: #666B74',
      '--atum-danger: #F0716A',
      '--atum-warn: #E0B060',
      '--atum-focus: rgba(255, 255, 255, 0.4)'
    ]) {
      expect(dark).toContain(token)
    }
  })

  it('keeps the SPEC §1 radii and geometry', () => {
    for (const token of [
      '--atum-r-sidebar: 16px',
      '--atum-r-composer: 22px',
      '--atum-r-sheet: 20px',
      '--atum-r-card: 14px',
      '--atum-r-group: 16px',
      '--atum-r-input: 12px',
      '--atum-r-button: 10px',
      '--atum-r-row: 10px',
      '--atum-r-tab: 9px',
      '--atum-r-control: 8px',
      '--atum-l-rail: 52px',
      '--atum-l-roster: 268px',
      '--atum-l-header: 48px',
      '--atum-l-tabbar: var(--atum-l-header)'
    ]) {
      expect(light).toContain(token)
    }
  })

  it('is monochrome: the accent is the ink and the old beige material is gone', () => {
    expect(light).toContain('--atum-accent: var(--atum-ink)')
    expect(styles).not.toContain('--atum-accent-soft')
    expect(styles).not.toContain('--atum-ambient')
    expect(styles).not.toContain('--atum-r-fused')
    expect(styles).not.toContain("data-atum-material='legacy-solid'")
    expect(styles).not.toContain('rgba(250, 243, 229')
  })

  it('sets the roster panel and the main and side-panel cards apart on the frame (Atum Kit)', () => {
    // A column flush with the window: no float, no shadow. Inside the frame its
    // top row stays in the titlebar band and the panel below it is the opaque
    // roster shade, so the three steps hold over the vibrancy material.
    expect(styles).toMatch(
      /\.atum-sidebar \{\n {2}background: var\(--atum-sidebar-tint\);\n {2}box-shadow: inset -1px 0 0 var\(--atum-line\);/u
    )
    expect(styles).not.toMatch(/\.atum-sidebar \{[^}]*border-radius/u)
    expect(styles).toContain('--atum-sidebar-tint: var(--atum-roster-bg)')
    expect(styles).toMatch(/\[data-atum-shell\] \.atum-sidebar::before \{[^}]*background: var\(--atum-roster-bg\);/u)
    expect(styles).not.toMatch(/\n\.atum-plate \{/u)
    // Atum Kit (FlowChat, FlowSidePanel): rounded panels 8 px apart, the side panel its own card.
    expect(styles).toMatch(/\[data-atum-shell\] \.atum-sidebar::before \{[^}]*border-radius: var\(--atum-r-panel\);/u)
    expect(styles).toMatch(/\[data-atum-main\]::before \{[^}]*box-shadow: var\(--atum-main-edge\);/u)
    expect(styles).toMatch(/\[data-atum-workspace\]::after \{[^}]*background: var\(--atum-main-bg\);/u)

    const chat = readFileSync(join(ATUM_DIR, 'chat-panel.tsx'), 'utf8')
    const workspace = readFileSync(join(ATUM_DIR, 'workspace-panel.tsx'), 'utf8')
    const roster = readFileSync(join(ATUM_DIR, 'roster-panel.tsx'), 'utf8')

    expect(chat).not.toContain('atum-plate')
    expect(workspace).not.toContain("'atum-plate")
    expect(roster).toContain('atum-sidebar relative flex h-full w-(--atum-l-roster)')
    expect(shellFrame).not.toContain('ps-2.5')
    // Roster width and hide/show lifecycle are exercised in shell-frame.test.tsx.
  })

  it('shapes the composer as the floating pill and the user turn as the strong own bubble', () => {
    expect(styles).toMatch(
      /\.atum-shell \[data-slot='composer-surface'\] \{[^}]*border-radius: var\(--atum-r-composer\)[^}]*min-height: 3\.5rem/u
    )
    expect(styles).toMatch(
      /\.atum-shell \.composer-human-message,?[^{]*\{[^}]*border-radius: 18px[^}]*padding: 0\.5rem 0\.8125rem[^}]*background: var\(--ak-bubble-own, var\(--atum-user-bubble\)\)[^}]*color: var\(--ak-on-bubble-own, var\(--atum-user-bubble-ink\)\)/u
    )
    expect(styles).toMatch(/\.atum-shell \[data-slot='aui_user-bubble-actions'\] \{[^}]*max-width: 78%/u)
    expect(styles).toContain('.atum-shell [data-atum-worked-for]')
    expect(styles).toContain(".atum-shell [data-slot='composer-controls'] button[type='submit']")
    expect(styles).toContain(".atum-shell [data-slot='composer-model']")
  })

  it('retired the native vibrancy bridge from the renderer', () => {
    const main = readFileSync(resolve(ATUM_DIR, '../../main.tsx'), 'utf8')

    expect(main).not.toContain('ensureAtumVibrancySync')
    expect(styles).not.toContain('data-atum-native-glass')
  })
})

describe('Atum shell — keyboard focus follows the Mac convention', () => {
  const styles = readFileSync(resolve(ATUM_DIR, '../../styles.css'), 'utf8')
  const atumStyles = styles.slice(styles.indexOf('/* ── Atum product shell'))

  it('draws the one kit ring for keyboard focus while leaving text entry and self-focused surfaces quiet', () => {
    expect(styles).toMatch(
      /\.atum-shell :focus-visible:not\(\[tabindex='-1'\]\),\nbody:has\(\.atum-shell\) :focus-visible:not\(\[tabindex='-1'\]\) \{\n {2}outline: 3px solid var\(--ak-focus\);\n {2}outline-offset: 1px;/u
    )
    expect(styles).toMatch(
      /body:has\(\.atum-shell\)[\s\S]*?input\[type='text'\],[\s\S]*?\):focus-visible \{\n {2}outline: none;\n {2}box-shadow: none;\n\}/u
    )
    expect(styles).toMatch(
      /\.atum-input:focus,\n\.atum-input:focus-visible,\n\.atum-input:focus-within \{[^}]*box-shadow: none;/u
    )
    expect(styles).toMatch(
      /\[data-slot='dialog-content'\]\[tabindex='-1'\]:is\(:focus, :focus-visible\) \{\n {2}outline: none;/u
    )
  })

  it('uses no other solid outline colour in the Atum shell', () => {
    const outlineColours = [...atumStyles.matchAll(/outline:\s*[^;]*\bsolid\s+([^;]+);/gu)].map(match => match[1])

    expect([...new Set(outlineColours)]).toEqual(['var(--ak-focus)'])
  })

  it.each(sources)('%s leaves the shared focus ring unmodified', (_name, source) => {
    expect(source).not.toMatch(/focus-visible:(?:outline|ring)/u)
    expect(source).not.toMatch(/focus-within:ring/u)
    expect(source).not.toContain('ring-(--atum-focus)')
  })
})

describe('Atum shell — the nav switch owns the destinations', () => {
  const nav = readFileSync(join(ATUM_DIR, 'nav-switch.tsx'), 'utf8')
  const navSurface = readFileSync(join(ATUM_DIR, 'shell-surface.tsx'), 'utf8')
  const controls = readFileSync(join(ATUM_DIR, 'window-controls.tsx'), 'utf8')
  const roster = readFileSync(join(ATUM_DIR, 'roster-panel.tsx'), 'utf8')
  const shell = readFileSync(join(ATUM_DIR, 'shell.tsx'), 'utf8')
  const shellFrame = readFileSync(join(ATUM_DIR, 'shell-frame.tsx'), 'utf8')

  it('is one persistent rail with Home, Discover and a capability-owned Workplace', () => {
    expect(existsSync(join(ATUM_DIR, 'nav-launcher.tsx'))).toBe(false)
    // It is a destination control, distinct from the native window controls.
    expect(controls).not.toContain('AtumNavSwitch')
    expect(shell).not.toContain('AtumNavLauncher')
    // ONE seat: the shell's persistent left rail. It never becomes a bottom
    // dock and survives roster collapse and a workspace taking the frame.
    expect(roster).not.toContain('AtumNavSwitch')
    expect(shell.match(/<AtumNavSwitch\b/gu)?.length).toBe(1)
    expect(shell).toContain('navigation={<AtumNavSwitch tray />}')
    expect(shellFrame).toContain('atum-destination-rail')
    expect(shellFrame).not.toContain('atum-nav-dock')
    expect(roster).not.toContain('data-atum-nav-dock-reserve')
    // The roster's presence follows whether it is SHOWING, not the preference —
    // driving it from the preference left it open beside the storefront.
    expect(shellFrame).toMatch(/useMotionPresence\(!compact && sidebarShowing, 280\)/u)
    expect(shellFrame).toContain('data-atum-workspace-over-frame')
    expect(navSurface).toContain('data-atum-nav-switch')
    expect(navSurface).toContain('data-atum-nav-home')
    expect(navSurface).toContain('data-atum-nav-discover')
    expect(navSurface).toContain('atum-nav-divider')
    expect(navSurface).toContain('data-atum-nav-workplace')
    // That an enabled Workplace dispatches and a coming-soon one does not is behaviour,
    // covered by rendering it in shell-surface.test.tsx, not by matching its source.
    expect(navSurface).toContain('workplaceAvailable = false')
  })

  it('took Discover out of the sidebar', () => {
    expect(roster).not.toContain('data-atum-nav-discover')
    expect(roster).not.toContain('Compass')
  })
})

describe('Atum workspace — the app launcher', () => {
  const styles = readFileSync(resolve(ATUM_DIR, '../../styles.css'), 'utf8')
  const panel = readFileSync(join(ATUM_DIR, 'workspace-panel.tsx'), 'utf8')
  const launcher = readFileSync(join(ATUM_DIR, 'skills-launcher.tsx'), 'utf8')
  const light = styles.match(/\n\.atum-shell,\n[^{]*\{([\s\S]*?)\n\}/u)?.[1] ?? ''
  const dark = styles.match(/\n\.dark \.atum-shell,\n[^{]*\{([\s\S]*?)\n\}/u)?.[1] ?? ''

  it('retains Office accents in both ramps without substituting them for native app artwork', () => {
    for (const token of ['--atum-office-doc', '--atum-office-sheet', '--atum-office-slide', '--atum-office-design']) {
      expect(light).toContain(`${token}:`)
      expect(dark).toContain(`${token}:`)
      expect(launcher).not.toContain(`'${token}'`)
    }
  })

  it('uses the Skills launcher and keeps custom document creation parked', () => {
    expect(panel).not.toContain('importChatDocument')
    expect(panel).not.toContain('importWord')
    expect(panel).toContain('<AtumSkillsLauncher')
    expect(launcher).not.toContain('createChatDocument')
    // The surface picker names the app launcher with the app grid, not a wrench.
    expect(panel).toMatch(/tools: Apps/u)
    expect(panel).not.toContain('Wrench')
    expect(panel).not.toContain('Starmap')
  })
})

describe('Atum shell — the devices control is gone until it is real', () => {
  it('renders no devices affordance, pairing copy, or device name', () => {
    for (const [, source] of sources) {
      const code = stripCommentsAndStrings(source).toLowerCase()

      expect(code).not.toMatch(/pairing|pairingcode|ghép đôi/u)
      expect(code).not.toContain('devicessoon')
    }
  })
})

describe('Atum shell — the type and radius scales are the only scales', () => {
  it.each(sources)('%s uses type tokens, not px literals', (_name, source) => {
    const code = stripCommentsAndStrings(source)

    // BAN 1 — arbitrary type. Nine ad-hoc sizes is not a scale.
    expect(code).not.toMatch(/\btext-\[\d+(?:\.\d+)?px\]/u)
    // BAN 2 — arbitrary radius. Avatars use the ratio tokens; everything else
    // uses a structural radius token.
    expect(code).not.toMatch(/\brounded-\[\d+(?:\.\d+)?px\]/u)
    // BAN 3 — the retired duplicate radius token.
    expect(code).not.toContain('--atum-r-tile')
    // BAN 6 — a bare Tailwind leading utility on Atum text. Line-height
    // travels with its size token, or Vietnamese diacritics clip.
    expect(code).not.toMatch(/\bleading-\d+\b/u)
  })
})

describe('Atum shell — Atum tokens only', () => {
  it.each(sources)('%s does not reach into Hermes token families', (_name, source) => {
    const code = stripCommentsAndStrings(source)

    // BAN 4 — bare --ui-* / --conversation-* inside the product shell. The
    // shared transcript still consumes --conversation-* internally; the Atum
    // chrome must not.
    expect(code).not.toMatch(/--(?:ui|conversation)-/u)
  })

  it.each(sources)('%s uses semantic status tokens, not the raw palette', (_name, source) => {
    const code = stripCommentsAndStrings(source)

    // BAN 5 — raw Tailwind palette + semantic Hermes colour classes. None of
    // them switch with the Atum material.
    expect(code).not.toMatch(
      /\b(?:text|bg|border|ring|fill|stroke|decoration)-(?:amber|red|rose|orange|yellow|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|slate|gray|zinc|neutral|stone)(?:-\d{2,3})?\b/u
    )
    expect(code).not.toMatch(/\b(?:text|bg|border)-(?:white|black)\b/u)
    expect(code).not.toMatch(/\b(?:text|bg|border)-(?:primary|destructive|muted-foreground|foreground)\b/u)
  })
})

describe('Atum shell — one icon family, one registry', () => {
  const atumAndDm = [...sources, ...dmSourceEntries]

  it.each(atumAndDm)('%s uses Tabler through @/lib/icons only', (_name, source) => {
    // BAN 7 — Codicons are a VS Code identity and an icon FONT; they cannot
    // carry a stroke weight and they sit on a different baseline.
    expect(source).not.toContain('Codicon')
    // BAN 8 — one registry. Direct @tabler imports fork the alias table.
    expect(source).not.toMatch(/from '@tabler\/icons-react'/u)
  })
})

describe('Atum material — every colour token exists in both ramps', () => {
  const styles = readFileSync(resolve(ATUM_DIR, '../../styles.css'), 'utf8')
  const block = (selector: RegExp) => styles.match(selector)?.[1] ?? ''
  const light = block(/\n\.atum-shell,\n[^{]*\{([\s\S]*?)\n\}/u)
  const dark = block(/\n\.dark \.atum-shell,\n[^{]*\{([\s\S]*?)\n\}/u)

  const COLOUR_FAMILY =
    /^--atum-(?:bg|glass|card|sunk|hover|pressed|line|ink|on-accent|danger|warn|focus|composer|user-bubble|shadow|browser-page|folder|page|desk|overlay-canvas|sheen|edge|glass-edge|glass-shadow|sheet-shadow)/u

  // Ramp-shared by design: the composed ambient gradient (its per-ramp STOPS
  // are declared in both blocks);
  // --atum-chat-solid is a semantic transparent. --atum-rim-h is geometry.
  // Ramp-shared by design: the aliases that resolve to another token in both
  // ramps, the focus halo (the window ground), the accent (the ink), the
  // terminal (always dark), and the glass blurs.
  const SHARED_BY_DESIGN = new Set([
    '--atum-chat-solid',
    '--atum-accent',
    '--atum-focus-halo',
    '--atum-ink-deep',
    '--atum-ink-strong',
    '--atum-ok',
    '--atum-verified',
    '--atum-desk',
    '--atum-overlay-canvas',
    '--atum-user-bubble-ink',
    '--atum-specular',
    '--atum-auth-field-line',
    '--atum-auth-focus',
    '--atum-shadow-panel',
    '--atum-shadow-chat',
    '--atum-window-bg',
    '--atum-glass-blur',
    '--atum-sheet-blur',
    '--atum-terminal-bg',
    '--atum-terminal-ink',
    '--atum-terminal-prompt',
    '--atum-terminal-sigil',
    '--atum-page',
    '--atum-rim-h'
  ])

  it('declares every colour-family token in .dark .atum-shell too', () => {
    const declared = Array.from(light.matchAll(/^\s*(--atum-[a-z0-9-]+):/gmu), match => match[1])

    const missing = declared.filter(
      token => token && COLOUR_FAMILY.test(token) && !SHARED_BY_DESIGN.has(token) && !dark.includes(`${token}:`)
    )

    // BAN 9 — a colour token defined once is a light-mode-only decision that
    // nobody notices until the demo runs in dark.
    expect(missing, `light-only colour tokens: ${missing.join(', ')}`).toEqual([])
  })
})

it('keeps closed roster disclosure contents out of the shared focus-scope edge scan', () => {
  // Chromium's details content-visibility is not display:none to Radix. The
  // installed-shell proof covers actual key events; keep its CSS fix in CI too.
  const styles = readFileSync(resolve(ATUM_DIR, '../../styles.css'), 'utf8')
  expect(styles).toMatch(/\[data-atum-roster\] details:not\(\[open\]\) > :not\(summary\)\s*\{\s*display: none;/u)
})

describe('Atum material — AA contrast on the ground and the glass (SPEC §1)', () => {
  const styles = readFileSync(resolve(ATUM_DIR, '../../styles.css'), 'utf8')
  const block = (selector: RegExp) => styles.match(selector)?.[1] ?? ''
  const light = block(/\n\.atum-shell,\n[^{]*\{([\s\S]*?)\n\}/u)
  const dark = block(/\n\.dark \.atum-shell,\n[^{]*\{([\s\S]*?)\n\}/u)

  type Rgba = { r: number; g: number; b: number; a: number }

  function parseColour(ramp: string, token: string): Rgba {
    const raw = ramp.match(new RegExp(`${token}: ([^;]+);`, 'u'))?.[1]?.trim()

    if (!raw) {
      throw new Error(`token ${token} not found`)
    }

    const hex = raw.match(/^#([0-9a-f]{6})$/iu)?.[1]

    if (hex) {
      return {
        r: Number.parseInt(hex.slice(0, 2), 16),
        g: Number.parseInt(hex.slice(2, 4), 16),
        b: Number.parseInt(hex.slice(4, 6), 16),
        a: 1
      }
    }

    const rgba = raw.match(/^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/u)

    if (!rgba) {
      throw new Error(`unparseable colour for ${token}: ${raw}`)
    }

    return { r: Number(rgba[1]), g: Number(rgba[2]), b: Number(rgba[3]), a: Number(rgba[4]) }
  }

  const over = (top: Rgba, ground: Rgba): Rgba => ({
    r: top.r * top.a + ground.r * (1 - top.a),
    g: top.g * top.a + ground.g * (1 - top.a),
    b: top.b * top.a + ground.b * (1 - top.a),
    a: 1
  })

  function luminance({ r, g, b }: Rgba): number {
    const chan = (value: number) => {
      const c = value / 255

      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    }

    return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b)
  }

  function ratio(ink: Rgba, ground: Rgba): number {
    const composited = ink.a < 1 ? over(ink, ground) : ink
    const [hi, lo] = [luminance(composited), luminance(ground)].sort((a, b) => b - a) as [number, number]

    return (hi + 0.05) / (lo + 0.05)
  }

  // The window is opaque: every surface composites over the ground (`--atum-bg`
  // between `--atum-bg-high` and `--atum-bg-low`). Glass and cards are thin
  // tints over that ground.
  const SURFACES = ['--atum-glass', '--atum-glass-strong', '--atum-card', '--atum-composer']
  const INKS = ['--atum-ink', '--atum-ink-soft', '--atum-ink-muted']

  it.each([
    ['light', light],
    ['dark', dark]
  ] as const)('%s: body ink clears AA over the ground and every glass surface', (_ramp, block_) => {
    const read = (name: string) => {
      try {
        return parseColour(block_, name)
      } catch {
        return parseColour(light, name)
      }
    }

    for (const groundToken of ['--atum-bg', '--atum-bg-high', '--atum-bg-low']) {
      const ground = read(groundToken)

      for (const inkToken of INKS) {
        expect(ratio(read(inkToken), ground), `${inkToken} on ${groundToken}`).toBeGreaterThanOrEqual(4.5)
      }

      for (const surface of SURFACES) {
        const composited = over(read(surface), ground)

        for (const inkToken of INKS) {
          expect(
            ratio(read(inkToken), composited),
            `${inkToken} on ${surface} over ${groundToken}`
          ).toBeGreaterThanOrEqual(4.5)
        }
      }
    }
  })

  it('reduced-transparency projections are opaque and stop the blur', () => {
    const reduced = styles.match(/@media \(prefers-reduced-transparency: reduce\) \{([\s\S]*?)\n\}\n/u)?.[1] ?? ''

    expect(reduced).toContain('--atum-glass: #FBFBFC')
    expect(reduced).toContain('--atum-glass: #1E2025')
    expect(reduced).toContain('--atum-glass-blur: none')
    expect(reduced).toContain('--atum-sheet-blur: none')
  })
})

describe('Atum shell — WS-4 motion contract', () => {
  const styles = readFileSync(resolve(ATUM_DIR, '../../styles.css'), 'utf8')

  it('implements every choreography with the shared entrance and exit tokens', () => {
    expect(styles).toContain('[data-atum-main-split]')
    expect(styles).toContain("[data-atum-workspace][data-atum-drawer='false']")
    expect(styles).toContain("[data-atum-workspace][data-atum-drawer='true']")
    expect(styles).toContain('[data-atum-roster-slot]')
    expect(styles).toContain("[data-atum-motion='entering'] > [data-atum-roster]")
    expect(styles).toContain('var(--atum-dur) var(--atum-ease)')
    expect(styles).toContain('var(--atum-dur-fast) var(--atum-ease-exit)')
    // Exit inertness and the bounded hide timer have DOM-level regression coverage.
  })

  it('paints the main panel under a panel that owns the frame', () => {
    // Narrow (2g) and expanded both leave the chat mounted behind the panel.
    // A transparent panel shows that transcript straight through the document,
    // so the two states share one rule: the main panel painted below the band.
    expect(styles).toMatch(
      /\[data-atum-workspace\]\[data-atum-drawer='true'\]::before,\n\[data-atum-workspace\]\[data-atum-full-frame='true'\]::before \{[^}]*background: var\(--atum-main-bg\);/u
    )
  })

  it('locks the three shell-entrance delays and welcome overlap', () => {
    expect(styles).toContain('animation-delay: 4800ms')
    expect(styles).toContain('animation-delay: 4880ms')
    expect(styles).toContain('animation-delay: 4960ms')
    expect(styles).toContain('atum-welcome-mark-transit var(--atum-dur-slow) var(--atum-ease) 4400ms both')
  })

  it('keeps reduced motion to the welcome fade and a resting working electron', () => {
    const atom = readFileSync(resolve(ATUM_DIR, '../../components/brand/atum-atom.css'), 'utf8')

    expect(styles.match(/Deliberate exemption from the blanket override above/gu)).toHaveLength(1)
    expect(styles).toContain(".atum-welcome[data-reduced='true'] .atum-welcome-final")
    expect(styles).toContain('animation: atum-welcome-fade 400ms linear both !important')
    expect(atom).toContain('animation: atum-atom-orbit var(--atum-atom-turn) linear infinite')
    expect(atom).toContain('@media (prefers-reduced-motion: reduce)')
    expect(atom).toContain('.atum-atom-track')
    expect(atom).toContain('animation: none !important')
    expect(atom).toContain('transform: rotate(var(--atum-atom-rest-angle)) !important')
    expect(atom).not.toContain('.atum-atom-x')
  })
})
