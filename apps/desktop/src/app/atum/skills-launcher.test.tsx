import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { LauncherCapabilityState, LauncherCapabilityTile } from '@/lib/launcher-capability-types'

import type { NativeAppEntry } from '../../../shared/skills-launcher'

const launcherMocks = vi.hoisted(() => ({
  addBundledLauncherSkill: vi.fn(),
  enableLauncherSkill: vi.fn(),
  launchLauncherApp: vi.fn(),
  openStorefront: vi.fn(),
  prepareLauncherSkill: vi.fn(),
  prepareLauncherSetup: vi.fn(),
  refreshLauncherCapabilities: vi.fn()
}))

vi.mock('@/store/native-apps', async () => {
  const { atom } = await import('nanostores')

  return {
    $nativeApps: atom({
      apps: [] as NativeAppEntry[],
      error: null as string | null,
      loading: false,
      result: null,
      scopeKey: 'scope-a'
    }),
    refreshNativeApps: vi.fn()
  }
})
vi.mock('@/store/launcher-capabilities', async () => {
  const { atom } = await import('nanostores')

  return {
    $launcherCapabilities: atom<LauncherCapabilityState>({
      busySkill: null,
      error: null,
      loading: false,
      profile: 'default',
      scopeKey: 'scope-a',
      skills: [],
      support: null
    }),
    ...launcherMocks
  }
})

const $launcherTestTiles = vi.hoisted(() => {
  let tiles: LauncherCapabilityTile[] = []

  return { get: () => tiles, set: (value: LauncherCapabilityTile[]) => {tiles = value} }
})

vi.mock('@/lib/launcher-capabilities', () => ({ OFFICE_SKILLS: { 'com.microsoft.Powerpoint': 'powerpoint' }, projectLauncherTiles: vi.fn(() => $launcherTestTiles.get()) }))
vi.mock('@/app/atum/skills', async () => {
  const { atom } = await import('nanostores')

  return { $atumSkillRows: atom([]) }
})
vi.mock('@/store/atum-store-catalog', () => ({ refreshAtumStoreCatalog: vi.fn(async () => null) }))
vi.mock('@/app/atum/skills-launcher-actions', () => ({ openLauncherOfficeFile: vi.fn() }))
vi.mock('@/app/atum/use-open-storefront', () => ({ useOpenStorefront: () => launcherMocks.openStorefront }))
vi.mock('./launcher-capability-copy', () => ({
  launcherCapabilityCopy: () => ({
    acquireDetail: 'Acquire',
    actionFailed: 'Failed',
    addToAssistant: 'Add to this assistant',
    ambiguousDetail: 'Choose one',
    browseSkills: 'Browse skills',
    capabilityForApp: 'App capability',
    capabilityForSkill: 'Skill capability',
    close: 'Close',
    disabledDetail: 'Disabled',
    enableForAssistant: 'Enable for this assistant',
    includedDetail: 'Included',
    limitations: 'Limitations',
    needsSetupDetail: 'Needs setup',
    noSupportedSkill: 'No supported skill yet',
    openApp: 'Open app',
    openBeside: 'Open beside',
    openNormally: 'Open normally',
    operationCreate: 'Create',
    operationEdit: 'Edit',
    operationFileVisible: 'Visible',
    operationNeedsSetup: 'Needs setup',
    operationRead: 'Read',
    operationReady: 'Ready',
    operationRenderQa: 'Render',
    operationUnknown: 'Unknown',
    operationValidate: 'Validate',
    readyDetail: 'Ready',
    recheck: 'Recheck',
    reasonFileVisibility: 'File visibility',
    reasonMissingTools: 'Missing tools',
    reasonRemoteRuntime: 'Remote runtime',
    reasonVisualQa: 'Visual QA',
    skillOnly: 'Skill only',
    statusAcquire: 'Acquire',
    statusAmbiguous: 'Ambiguous',
    statusChecking: 'Checking',
    statusDisabled: 'Disabled',
    statusIncluded: 'Included',
    statusNeedsSetup: 'Needs setup',
    statusReady: 'Ready',
    statusUnavailable: 'Unavailable',
    statusUnsupported: 'Unsupported',
    unavailableDetail: 'Unavailable',
    unknownCapability: 'Unknown',
    useSkill: 'Use skill'
  })
}))
vi.mock('./app-capability-dialog', () => ({
  AppCapabilityDialog: (props: {
    onAdd?: () => void
    onBrowse?: () => void
    onEnable?: () => void
    onOpenChange: (open: boolean) => void
    open: boolean
    tile: LauncherCapabilityTile | null
  }) =>
    props.open ? (
      <div data-testid="capability-dialog">
        <button onClick={() => props.onAdd?.()} type="button">
          Add to this assistant
        </button>
        <button onClick={() => props.onEnable?.()} type="button">
          Enable for this assistant
        </button>
        <button onClick={() => props.onBrowse?.()} type="button">
          Browse skills
        </button>
        <button onClick={() => props.onOpenChange(false)} type="button">
          Close
        </button>
        <span>{props.tile?.status}</span>
      </div>
    ) : null
}))
vi.mock('./skill-detail-dialog', () => ({
  SkillDetailDialog: ({ entry, open }: { entry: { identifier: string } | null; open: boolean }) =>
    open ? <div data-testid="skill-detail">{entry?.identifier}</div> : null
}))
vi.mock('./add-skill-dialog', () => ({ AddSkillDialog: () => null }))

import { I18nProvider } from '@/i18n'
import { projectLauncherTiles } from '@/lib/launcher-capabilities'
import { $actionPanelOwner } from '@/store/action-panel-owner'
import { $workspaceOpen } from '@/store/atum-shell'
import {
  $launcherCapabilities,
  addBundledLauncherSkill,
  enableLauncherSkill,
  launchLauncherApp,
  prepareLauncherSkill
} from '@/store/launcher-capabilities'
import { $nativeAppRecency } from '@/store/native-app-recency'
import { $nativeApps } from '@/store/native-apps'

import { AtumSkillsLauncher } from './skills-launcher'
import { openLauncherOfficeFile } from './skills-launcher-actions'

const preview: NativeAppEntry = { bundleId: 'com.apple.Preview', id: 'preview', name: 'Preview' }

const appTile = (
  status: LauncherCapabilityTile['status'],
  extra: Partial<LauncherCapabilityTile> = {}
): LauncherCapabilityTile => ({
  app: preview,
  description: '',
  id: `preview-${status}`,
  label: 'Preview',
  operations: {},
  skill: null,
  skillName: 'pdf',
  status,
  storeEntry: null,
  ...extra
})

function renderLauncher() {
  return render(
    <I18nProvider configClient={null} initialLocale="en">
      <AtumSkillsLauncher scopeKey="scope-a" />
    </I18nProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  $actionPanelOwner.set(null)
  $workspaceOpen.set(true)
  $nativeAppRecency.set({})
  $nativeApps.set({ apps: [preview], error: null, loading: false, result: null, scopeKey: 'scope-a' })
  $launcherCapabilities.set({
    busySkill: null,
    error: null,
    loading: false,
    profile: 'default',
    scopeKey: 'scope-a',
    skills: [],
    support: null
  })
  $launcherTestTiles.set([])
  vi.mocked(launchLauncherApp).mockResolvedValue({ app: preview, id: 'launch', status: 'opened' })
  vi.mocked(prepareLauncherSkill).mockReturnValue(true)
})

afterEach(cleanup)

describe('capability launcher', () => {
  it('uses only owner history and refreshes it on panel/surface reopen or owner change', () => {
    const owner = { accountId: 'a', connectionId: 'connection', agent_id: 'agent',
      backend_id: 'backend', profile: 'default', version: 1 as const, submission_dedup: true }

    $actionPanelOwner.set(owner)
    $nativeAppRecency.set({ a: { preview: 100 }, b: { preview: 200 } })
    const view = renderLauncher()
    const projectedHistory = () => vi.mocked(projectLauncherTiles).mock.lastCall?.[3]
    expect(projectedHistory()).toEqual({ preview: 100 })

    const projectionCalls = vi.mocked(projectLauncherTiles).mock.calls.length
    act(() => {
      $nativeAppRecency.set({ a: { preview: 300 }, b: { preview: 200 } })
      $launcherCapabilities.set({ ...$launcherCapabilities.get() })
    })
    expect(vi.mocked(projectLauncherTiles).mock.calls.length).toBeGreaterThan(projectionCalls)
    expect(projectedHistory()).toEqual({ preview: 100 })

    act(() => {$workspaceOpen.set(false)})
    act(() => {$workspaceOpen.set(true)})
    expect(projectedHistory()).toEqual({ preview: 300 })
    act(() => {$nativeAppRecency.set({ a: { preview: 400 }, b: { preview: 200 } })})
    view.unmount()
    renderLauncher()
    expect(projectedHistory()).toEqual({ preview: 400 })
    act(() => {$actionPanelOwner.set({ ...owner, accountId: 'b' })})
    expect(projectedHistory()).toEqual({ preview: 200 })
  })

  it('retains empty-query and IME guards before launching the selected result', () => {
    $launcherTestTiles.set([appTile('ready')])
    renderLauncher()
    const search = screen.getByRole('textbox', { name: 'Search' })
    fireEvent.keyDown(search, { key: 'Enter' })
    fireEvent.change(search, { target: { value: 'pre' } })
    fireEvent.keyDown(search, { key: 'Enter', isComposing: true })
    expect(launchLauncherApp).not.toHaveBeenCalled()
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(launchLauncherApp).toHaveBeenCalledWith(preview, 'scope-a', { skillName: 'pdf' })
  })

  it('retains normal-open and context-menu keyboard actions for muted apps', async () => {
    $launcherTestTiles.set([appTile('unsupported')])
    renderLauncher()
    const tile = screen.getByRole('button', { name: 'Preview' })
    fireEvent.keyDown(tile, { key: 'Enter', altKey: true })
    expect(launchLauncherApp).toHaveBeenCalledWith(preview, 'scope-a', { normal: true })
    fireEvent.keyDown(tile, { key: 'F10', shiftKey: true })
    expect(await screen.findByRole('menuitem', { name: 'Open normally' })).toBeTruthy()
  })
  it('offers the included add action instead of hiding a missing assistant skill', async () => {
    $launcherTestTiles.set([appTile('included')])
    renderLauncher()
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add to this assistant' }))
    await waitFor(() => expect(addBundledLauncherSkill).toHaveBeenCalledWith('pdf', 'scope-a'))
  })

  it('keeps a disabled tile in the keyboard path and opens its enable action', async () => {
    $launcherTestTiles.set([appTile('disabled')])
    renderLauncher()
    const search = screen.getByRole('textbox', { name: 'Search' })
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    await waitFor(() =>
      expect(search.ownerDocument.activeElement).toBe(screen.getByRole('button', { name: 'Preview' }))
    )
    fireEvent.click(search.ownerDocument.activeElement!)
    expect(screen.getByTestId('capability-dialog').textContent).toContain('disabled')
    fireEvent.click(screen.getByRole('button', { name: 'Enable for this assistant' }))
    expect(enableLauncherSkill).toHaveBeenCalledWith('pdf', 'scope-a')
  })

  it('routes unsupported apps to the single skills storefront', () => {
    $launcherTestTiles.set([appTile('unsupported')])
    renderLauncher()
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    fireEvent.click(screen.getByRole('button', { name: 'Browse skills' }))
    expect(launcherMocks.openStorefront).toHaveBeenCalledWith('skills')
  })

  it('opens the actual paid detail entry without starting a purchase', () => {
    const entry = { identifier: 'official/paid-skill' } as LauncherCapabilityTile['storeEntry']
    $launcherTestTiles.set([appTile('acquire', { storeEntry: entry })])
    renderLauncher()
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    expect(screen.getByTestId('skill-detail').textContent).toContain('official/paid-skill')
    expect(addBundledLauncherSkill).not.toHaveBeenCalled()
  })

  it('launches a ready app with its resolved skill but never sends a message', async () => {
    $launcherTestTiles.set([appTile('ready')])
    renderLauncher()
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    await waitFor(() => expect(launchLauncherApp).toHaveBeenCalledWith(preview, 'scope-a', { skillName: 'pdf' }))
    expect(prepareLauncherSkill).not.toHaveBeenCalled()
  })

  it('keeps keyboard selection on the same app when readiness reorders the grid', async () => {
    const first = appTile('ready', { id: 'first', label: 'First', app: { ...preview, id: 'first' } })
    const second = appTile('ready', { id: 'second', label: 'Second', app: { ...preview, id: 'second' } })
    $launcherTestTiles.set([first, second])
    renderLauncher()
    const search = screen.getByRole('textbox', { name: 'Search' })
    fireEvent.change(search, { target: { value: 'pdf' } })
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    await waitFor(() => expect(search.ownerDocument.activeElement).toBe(screen.getByRole('button', { name: 'First' })))
    fireEvent.keyDown(search.ownerDocument.activeElement!, { key: 'ArrowRight' })
    await waitFor(() => expect(search.ownerDocument.activeElement).toBe(screen.getByRole('button', { name: 'Second' })))

    act(() => {$launcherTestTiles.set([second, first])})
    fireEvent.focus(search)
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(launchLauncherApp).toHaveBeenLastCalledWith(second.app, 'scope-a', { skillName: 'pdf' })
  })

  it('restores focus to the muted source tile when its card closes', async () => {
    $launcherTestTiles.set([appTile('unsupported')])
    renderLauncher()
    const tile = screen.getByRole('button', { name: 'Preview' })
    fireEvent.click(tile)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(tile.ownerDocument.activeElement).toBe(tile))
  })
})


it('continues an Office file window chooser from the native store without a primary tile launch', async () => {
  const app = { id: 'ppt', name: 'PowerPoint', bundleId: 'com.microsoft.Powerpoint' }
  $launcherTestTiles.set([appTile('ready', { app, label: app.name, skillName: 'powerpoint' })])
  vi.mocked(openLauncherOfficeFile).mockImplementationOnce(async () => {
    $nativeApps.set({ ...$nativeApps.get(), documentPath: '/work/deck.pptx',
      result: { app, id: 'file-pair', status: 'choose-window', windows: [{ id: 42, title: 'Opened deck' }] } })
  })
  renderLauncher()
  fireEvent.contextMenu(screen.getByRole('button', { name: 'PowerPoint' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Open file…' }))
  expect(openLauncherOfficeFile).toHaveBeenCalledWith(app, 'scope-a')
  fireEvent.click(await screen.findByRole('button', { name: 'Opened deck' }))
  await waitFor(() => expect(launchLauncherApp).toHaveBeenCalledWith(app, 'scope-a', { windowId: 42, skillName: 'powerpoint' }))
})

it('rechecks invalidated cwd evidence while preserving the app grid', async () => {
  $launcherTestTiles.set([appTile('ready')])
  renderLauncher()
  launcherMocks.refreshLauncherCapabilities.mockClear()
  act(() => $launcherCapabilities.set({ ...$launcherCapabilities.get(), scopeKey: null, support: null, loading: true }))
  expect(screen.getByRole('button', { name: 'Preview' })).toBeTruthy()
  await waitFor(() => expect(launcherMocks.refreshLauncherCapabilities).toHaveBeenCalledWith('scope-a'))
})

it('moves by rendered rows and returns from the first row to search', async () => {
  $launcherTestTiles.set(['First', 'Second', 'Third'].map((name, index) => appTile('ready', { id: String(index), label: name })))
  const tops = new Map([['First', 0], ['Second', 0], ['Third', 96]])

  const offset = vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (this: HTMLElement) {
    return tops.get(this.getAttribute('title') ?? '') ?? 0
  })

  try {
    renderLauncher()
    const first = screen.getByRole('button', { name: 'First' })
    first.focus()
    fireEvent.keyDown(first, { key: 'ArrowDown' })
    const third = screen.getByRole('button', { name: 'Third' })
    await waitFor(() => expect(first.ownerDocument.activeElement).toBe(third))
    fireEvent.keyDown(third, { key: 'ArrowUp' })
    await waitFor(() => expect(first.ownerDocument.activeElement).toBe(first))
    fireEvent.keyDown(first, { key: 'ArrowUp' })
    expect(first.ownerDocument.activeElement).toBe(screen.getByRole('textbox', { name: 'Search' }))
  } finally { offset.mockRestore() }
})

it('shows no-results copy for an unmatched query', () => {
  $launcherTestTiles.set([appTile('ready')])
  renderLauncher()
  fireEvent.change(screen.getByRole('textbox', { name: 'Search' }), { target: { value: 'No such app' } })
  expect(screen.getByText('No apps match your search.')).toBeTruthy()
})

it('offers Accessibility settings for the native permission fallback', async () => {
  const openArrangementSettings = vi.fn(async () => undefined)
  vi.stubGlobal('hermesDesktop', { nativeApps: { openArrangementSettings } })
  $nativeApps.set({ ...$nativeApps.get(), result: { app: preview, id: 'fallback', status: 'opened', reason: 'permission' } })
  renderLauncher()
  fireEvent.click(screen.getByRole('button', { name: 'Open Accessibility settings' }))
  await waitFor(() => expect(openArrangementSettings).toHaveBeenCalledOnce())
  vi.unstubAllGlobals()
})
