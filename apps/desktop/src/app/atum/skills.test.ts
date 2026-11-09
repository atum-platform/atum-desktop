import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { type WritableAtom } from 'nanostores'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AtumStoreCatalogWire, AtumStoreItemWire } from '@/lib/atum-store-items'

const hermes = vi.hoisted(() => ({
  getActionStatus: vi.fn(),
  getSkillHubSources: vi.fn(),
  installSkillFromHub: vi.fn(),
  previewSkillHub: vi.fn(),
  uninstallSkillFromHub: vi.fn(),
  updateSkillsFromHub: vi.fn()
}))

const talkToAtumAgent = vi.hoisted(() => vi.fn())

vi.mock('@/hermes', async importOriginal => ({ ...(await importOriginal<Record<string, unknown>>()), ...hermes }))
vi.mock('@/lib/query-client', () => ({ queryClient: { invalidateQueries: vi.fn() } }))
vi.mock('@/store/activity', () => ({ upsertDesktopActionTask: vi.fn() }))
vi.mock('@/store/profile', async importOriginal => {
  const { atom } = await import('nanostores')

  return {
    ...(await importOriginal<Record<string, unknown>>()),
    $activeGatewayProfile: atom('default'),
    normalizeProfileKey: (value: null | string | undefined) => value?.trim() || 'default'
  }
})
// The store catalog the tests control directly — the whole point of D2 is
// that the shelves read THIS, not a constant compiled into the app.
vi.mock('@/store/atum-store-catalog', async () => {
  const { atom } = await import('nanostores')

  return {
    $atumStoreCatalog: atom<AtumStoreCatalogView>({ accountId: null, catalog: null, state: 'idle' }),
    refreshAtumStoreCatalog: vi.fn(async () => null)
  }
})
vi.mock('./agents', async () => {
  const { atom } = await import('nanostores')

  return {
    $atumAgents: atom([
      { id: 'default', title: 'Atum', hostedId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', identityId: 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa' },
      { id: 'atum-alfred', title: 'Alfred', hostedId: 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb', identityId: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb' }
    ]),
    ATUM_AGENT_ID: 'default',
    talkToAtumAgent
  }
})

import { projectSkillEntry } from '@/lib/atum-store-items'
import { $discoverShelf, $railDestination } from '@/store/atum-shell'
import type { AtumStoreCatalogView } from '@/store/atum-store-catalog'
import { stashSessionDraft, takeSessionDraft } from '@/store/composer'
import { $hubActions, $hubInstalledOverride } from '@/store/hub-actions'

import { $atumAgents } from './agents'
import {
  $atumSkillRows,
  $fulfillableSkillIds,
  addAtumSkill,
  atumSkillTarget,
  loadAtumSkillPreview,
  refreshAtumSkills,
  removeAtumSkill,
  tryAtumSkill
} from './skills'

const skillItem = (id: string, identifier: string, overrides: Partial<AtumStoreItemWire> = {}): AtumStoreItemWire => ({
  accent: 'var(--atum-sunk)',
  detail: {
    description: { en: `${id} details`, vi: `Chi tiết ${id}` },
    needs: [],
    try_prompt: { en: `Try ${id}`, vi: `Thử ${id}` }
  },
  featured: false,
  glyph: '🔷',
  hashes: [],
  id,
  kind: 'skill',
  offer: { id: '00000000-0000-4000-8000-11e594f48195', price_protons: 0, version: 1 },
  sort_order: 1,
  source: { identifier, type: 'hermes_optional' },
  summary: { en: `${id} summary`, vi: `Tóm tắt ${id}` },
  title: { en: id, vi: id },
  ...overrides
})

const SKILL_A = skillItem('concept-diagrams', 'official/creative/concept-diagrams', { featured: true, sort_order: 1 })
const SKILL_B = skillItem('stocks', 'official/finance/stocks', { sort_order: 2 })

const defaultEntitlements: AtumStoreCatalogWire['entitlements'] = ['a', 'b', 'c'].map(letter => ({
  assistant_id: `${letter.repeat(8)}-1111-4111-8111-${letter.repeat(12)}`,
  assistant_identity_id: `${letter.repeat(8)}-2222-4222-8222-${letter.repeat(12)}`,
  granted_at: '2026-09-10T00:00:00Z', id: 'concept-diagrams', kind: 'skill', state: 'active'
}))

const catalog = (items: AtumStoreItemWire[], entitlements: AtumStoreCatalogWire['entitlements'] = defaultEntitlements): AtumStoreCatalogWire => ({
  available_protons: 0,
  entitlements,
  items
})

const $storeView = (await import('@/store/atum-store-catalog')).$atumStoreCatalog

const entry = projectSkillEntry(SKILL_A, false)!
// The module mock above replaces the computed store with a plain atom, so the
// tests may write to it; the real export is read-only, hence the cast.
const $mockAgents = $atumAgents as unknown as WritableAtom<Array<{ id: string; title: string; hostedId: string; identityId: string }>>

const completed = (name: string, exitCode = 0, lines = ['done']) => ({
  exit_code: exitCode,
  lines,
  name,
  pid: null,
  running: false
})

describe('Atum skills adapter boundaries', () => {
  const source = readFileSync(resolve(__dirname, 'skills.ts'), 'utf8')

  it.each([
    '@/store/profile',
    '$profiles',
    '$sessions',
    '$projects',
    '$cronSessions',
    '$pinnedSessionIds',
    'worktree',
    'git_branch'
  ])('does not reach for %s', noun => {
    expect(source).not.toContain(noun)
  })

  it('never reads a compiled-in skill catalog — the store owns the rows', () => {
    expect(source).not.toContain('atum-skill-catalog')
    expect(source).not.toContain('ATUM_SKILL_ENTRIES')
  })

  it('is the only Atum shell source that reads the skills hub adapter', () => {
    const offenders = readdirSync(__dirname, { recursive: true })
      .map(name => String(name))
      .filter(name => /\.(ts|tsx)$/u.test(name) && !/\.test\.(ts|tsx)$/u.test(name) && name !== 'skills.ts')
      .filter(name => {
        const candidate = readFileSync(resolve(__dirname, name), 'utf8')

        return (
          candidate.includes('@/store/hub-actions') ||
          /from '@\/hermes'/u.test(candidate) &&
            /(getSkillHubSources|installSkillFromHub|previewSkillHub|uninstallSkillFromHub)/u.test(candidate)
        )
      })

    expect(offenders).toEqual([])
  })
})

describe('Atum skills rows come from the store catalog', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    $mockAgents.set([
      { id: 'default', title: 'Atum', hostedId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', identityId: 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa' },
      { id: 'atum-alfred', title: 'Alfred', hostedId: 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb', identityId: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb' }
    ])
    hermes.getActionStatus.mockReset()
    hermes.getSkillHubSources.mockReset()
    hermes.installSkillFromHub.mockReset()
    hermes.uninstallSkillFromHub.mockReset()
    // The fulfilment probe: the bundled Hermes resolves every fixture skill.
    hermes.previewSkillHub.mockReset().mockImplementation(async (identifier: string) =>
      ['official/creative/concept-diagrams', 'official/finance/stocks'].includes(identifier) ? { files: ['SKILL.md'] } : null
    )
    $hubActions.set({})
    $hubInstalledOverride.set({})
    $fulfillableSkillIds.set(null)
    $storeView.set({ accountId: 'acct', catalog: catalog([SKILL_A, SKILL_B]), state: 'ready' })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders exactly the rows the store catalog lists — and changes when it changes', async () => {
    hermes.getSkillHubSources.mockResolvedValue({ installed: {} })

    await refreshAtumSkills()

    expect($atumSkillRows.get().map(row => row.entry.id)).toEqual(['concept-diagrams', 'stocks'])

    // No recompile, no release: a new published row appears on the next read.
    hermes.previewSkillHub.mockImplementation(async (identifier: string) =>
      ['official/creative/concept-diagrams', 'official/finance/stocks', 'official/creative/pixel-art'].includes(identifier)
        ? { files: ['SKILL.md'] }
        : null
    )
    $storeView.set({
      accountId: 'acct',
      catalog: catalog([SKILL_A, SKILL_B, skillItem('pixel-art', 'official/creative/pixel-art', { sort_order: 3 })]),
      state: 'ready'
    })

    // pixel-art is not in the probe's answer yet, so it stays hidden until the
    // next refresh probes it (decision 11: known absence hides).
    expect($atumSkillRows.get().map(row => row.entry.id)).toEqual(['concept-diagrams', 'stocks'])

    await refreshAtumSkills()

    expect($atumSkillRows.get().map(row => row.entry.id)).toEqual(['concept-diagrams', 'stocks', 'pixel-art'])
  })

  it('hides a listed item this build cannot fulfil once the probe answers no', async () => {
    hermes.previewSkillHub.mockImplementation(async (identifier: string) =>
      identifier === 'official/creative/concept-diagrams' ? { files: ['SKILL.md'] } : null
    )
    hermes.getSkillHubSources.mockResolvedValue({ installed: {} })

    await refreshAtumSkills()

    expect($atumSkillRows.get().map(row => row.entry.id)).toEqual(['concept-diagrams'])
  })

  it('treats the hub\'s 404 "Skill not found" as a verdict, not as unknown — an unfulfillable skill leaves the shelf', async () => {
    // The preview route RAISES 404 when nothing resolves; it does not resolve
    // to a falsy value. A rejection used to land in "unknown" and the priced
    // row stayed on sale.
    hermes.previewSkillHub.mockImplementation(async (identifier: string) => {
      if (identifier === 'official/creative/concept-diagrams') {
        return { files: ['SKILL.md'] }
      }

      throw new Error(`404: {"detail":"Skill not found: ${identifier}"}`)
    })
    hermes.getSkillHubSources.mockResolvedValue({ installed: {} })

    await refreshAtumSkills()

    expect($fulfillableSkillIds.get()?.has('official/finance/stocks')).toBe(false)
    expect($atumSkillRows.get().map(row => row.entry.id)).toEqual(['concept-diagrams'])
  })

  it('keeps the previous knowledge on a transport failure — only a verdict changes the fulfilment set', async () => {
    hermes.previewSkillHub.mockRejectedValue(new Error('network unreachable'))
    hermes.getSkillHubSources.mockResolvedValue({ installed: {} })

    await refreshAtumSkills()

    // No verdict at all: rows stay visible rather than blanking on a hiccup.
    expect($fulfillableSkillIds.get()).toBeNull()
    expect($atumSkillRows.get().map(row => row.entry.id)).toEqual(['concept-diagrams', 'stocks'])
  })

  it('marks an entitlement as Owned and a priced offer as Protons', async () => {
    $storeView.set({
      accountId: 'acct',
      catalog: catalog(
        [
          SKILL_A,
          { ...SKILL_B, offer: { id: '00000000-0000-4000-8000-e79acd97ac88', price_protons: 5000, version: 3 } }
        ],
        [{ assistant_id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', assistant_identity_id: 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa', granted_at: '2026-09-10T00:00:00Z', id: 'concept-diagrams', kind: 'skill', state: 'active' }]
      ),
      state: 'ready'
    })
    hermes.getSkillHubSources.mockResolvedValue({ installed: {} })

    await refreshAtumSkills()

    const [owned, priced] = $atumSkillRows.get()
    expect(owned!.entry.owned).toBe(true)
    expect(priced!.entry.owned).toBe(false)
    expect(priced!.entry.price).toEqual({ amount: 5000, kind: 'protons' })
    expect(priced!.entry.offer).toMatchObject({ priceProtons: 5000, version: 3 })
  })

  it('renders nothing while the catalog is not loaded', () => {
    $storeView.set({ accountId: 'acct', catalog: null, state: 'idle' })

    expect($atumSkillRows.get()).toEqual([])
  })

  it('queries master and named agents explicitly and joins installed maps into catalog rows', async () => {
    hermes.getSkillHubSources
      .mockResolvedValueOnce({ installed: { [entry.identifier]: { name: 'concept-diagrams' } } })
      .mockResolvedValueOnce({ installed: {} })

    await refreshAtumSkills()

    expect(hermes.getSkillHubSources).toHaveBeenNthCalledWith(1, { profile: null })
    expect(hermes.getSkillHubSources).toHaveBeenNthCalledWith(2, { profile: 'atum-alfred' })
    expect($atumSkillRows.get()).toHaveLength(2)
    expect($atumSkillRows.get()[0]!.assistants.map(assistant => assistant.agentId)).toEqual([
      'default',
      'atum-alfred'
    ])
    expect($atumSkillRows.get()[0]!.installedFor).toEqual(['default'])
  })

  it('projects preview file names without exposing raw skill instructions', async () => {
    hermes.previewSkillHub.mockResolvedValue({ files: ['SKILL.md', 'scripts/render.js'], skill_md: '# private' })

    await expect(loadAtumSkillPreview(entry)).resolves.toEqual({ files: ['SKILL.md', 'scripts/render.js'] })
    expect(hermes.previewSkillHub).toHaveBeenCalledWith(entry.identifier)
  })

  it('installs for multiple assistants strictly sequentially', async () => {
    let finishFirst: ((value: ReturnType<typeof completed>) => void) | undefined

    const firstStatus = new Promise<ReturnType<typeof completed>>(resolvePromise => {
      finishFirst = resolvePromise
    })

    hermes.installSkillFromHub
      .mockResolvedValueOnce({ name: 'first' })
      .mockResolvedValueOnce({ name: 'second' })
    hermes.getActionStatus.mockImplementationOnce(() => firstStatus).mockResolvedValueOnce(completed('second'))
    hermes.getSkillHubSources.mockResolvedValue({ installed: {} })

    const installing = addAtumSkill(entry, ['default', 'atum-alfred'])
    await vi.waitFor(() => expect(hermes.installSkillFromHub).toHaveBeenCalledTimes(1))

    finishFirst!(completed('first'))
    await vi.waitFor(() => expect(hermes.installSkillFromHub).toHaveBeenCalledTimes(2))
    await installing

    expect(hermes.installSkillFromHub).toHaveBeenNthCalledWith(1, entry.identifier, atumSkillTarget('default'))
    expect(hermes.installSkillFromHub).toHaveBeenNthCalledWith(2, entry.identifier, atumSkillTarget('atum-alfred'))
  })

  it('exposes a failed exit and its last non-empty log line without throwing', async () => {
    hermes.installSkillFromHub.mockResolvedValue({ name: 'failed-install' })
    hermes.getActionStatus.mockResolvedValue(completed('failed-install', 2, ['checking', '', 'could not install']))
    hermes.getSkillHubSources.mockResolvedValue({ installed: {} })

    await expect(addAtumSkill(entry, ['default'])).resolves.toBeUndefined()

    const state = $atumSkillRows.get()[0]!.assistants[0]!
    expect(state.action).toBe('failed')
    expect(state.lastLogLine).toBe('could not install')
  })

  it('surfaces a spawn failure as a failed assistant state instead of throwing', async () => {
    hermes.installSkillFromHub.mockRejectedValue(new Error('backend offline'))
    hermes.getSkillHubSources.mockResolvedValue({ installed: {} })

    await expect(addAtumSkill(entry, ['atum-alfred'])).resolves.toBeUndefined()

    const state = $atumSkillRows.get()[0]!.assistants[1]!
    expect(state.action).toBe('failed')
    expect(state.lastLogLine).toBe('backend offline')
  })

  it('queues same-skill installs from separate calls so backend action names never collide', async () => {
    let finishFirst: ((value: ReturnType<typeof completed>) => void) | undefined

    const firstStatus = new Promise<ReturnType<typeof completed>>(resolvePromise => {
      finishFirst = resolvePromise
    })

    hermes.installSkillFromHub
      .mockResolvedValueOnce({ name: 'first' })
      .mockResolvedValueOnce({ name: 'second' })
    hermes.getActionStatus.mockImplementationOnce(() => firstStatus).mockResolvedValueOnce(completed('second'))
    hermes.getSkillHubSources.mockResolvedValue({ installed: {} })

    const first = addAtumSkill(entry, ['default'])
    const second = addAtumSkill(entry, ['atum-alfred'])
    await vi.waitFor(() => expect(hermes.installSkillFromHub).toHaveBeenCalledTimes(1))

    // Give the second call every chance to spawn early; it must not.
    for (let tick = 0; tick < 5; tick += 1) {
      await Promise.resolve()
    }

    expect(hermes.installSkillFromHub).toHaveBeenCalledTimes(1)

    finishFirst!(completed('first'))
    await vi.waitFor(() => expect(hermes.installSkillFromHub).toHaveBeenCalledTimes(2))
    await Promise.all([first, second])

    expect(hermes.installSkillFromHub).toHaveBeenNthCalledWith(2, entry.identifier, atumSkillTarget('atum-alfred'))
  })

  it('clears a failed poll only when a fresh read after the action shows the skill installed', async () => {
    hermes.installSkillFromHub.mockResolvedValue({ name: 'flaky-poll' })
    hermes.getActionStatus.mockRejectedValue(new Error('socket hang up'))
    hermes.getSkillHubSources.mockResolvedValue({ installed: { [entry.identifier]: { name: 'concept-diagrams' } } })

    await addAtumSkill(entry, ['default'])

    const state = $atumSkillRows.get()[0]!.assistants[0]!
    expect(state.installedName).toBe('concept-diagrams')
    expect(state.action).toBe('idle')
  })

  it('keeps the failure when the read after a failed poll also fails, even if an older map said installed', async () => {
    hermes.getSkillHubSources.mockResolvedValueOnce({ installed: { [entry.identifier]: { name: 'concept-diagrams' } } })
    hermes.getSkillHubSources.mockResolvedValueOnce({ installed: {} })
    await refreshAtumSkills()

    hermes.installSkillFromHub.mockResolvedValue({ name: 'flaky-poll' })
    hermes.getActionStatus.mockRejectedValue(new Error('socket hang up'))
    hermes.getSkillHubSources.mockRejectedValue(new Error('sources offline'))

    await addAtumSkill(entry, ['default'])

    expect($atumSkillRows.get()[0]!.assistants[0]!.action).toBe('failed')
  })

  it('keeps a failed removal failed while the skill is still present', async () => {
    hermes.getSkillHubSources.mockResolvedValue({ installed: { [entry.identifier]: { name: 'concept-diagrams' } } })
    await refreshAtumSkills()

    hermes.uninstallSkillFromHub.mockResolvedValue({ name: 'remove-diagram' })
    hermes.getActionStatus.mockResolvedValue(completed('remove-diagram', 2, ['permission denied']))

    await removeAtumSkill(entry, 'default')

    const state = $atumSkillRows.get()[0]!.assistants[0]!
    expect(state.action).toBe('failed')
    expect(state.installedName).toBe('concept-diagrams')
    expect(state.lastLogLine).toBe('permission denied')
  })

  it('resolves the uninstall name from a fresh read taken inside its queued turn', async () => {
    hermes.getSkillHubSources.mockResolvedValueOnce({ installed: { [entry.identifier]: { name: 'stale-name' } } })
    hermes.getSkillHubSources.mockResolvedValueOnce({ installed: {} })
    await refreshAtumSkills()

    // The read inside the removal's turn sees the name the backend recorded.
    hermes.getSkillHubSources.mockResolvedValue({ installed: { [entry.identifier]: { name: 'recorded-name' } } })
    hermes.uninstallSkillFromHub.mockResolvedValue({ name: 'remove-diagram' })
    hermes.getActionStatus.mockResolvedValue(completed('remove-diagram'))

    await removeAtumSkill(entry, 'default')

    expect(hermes.uninstallSkillFromHub).toHaveBeenCalledWith('recorded-name', atumSkillTarget('default'))
  })

  it('lets only the newest of two overlapping refreshes commit, in one write', async () => {
    let finishOld: ((value: { installed: Record<string, { name: string }> }) => void) | undefined

    const oldAlfred = new Promise<{ installed: Record<string, { name: string }> }>(resolvePromise => {
      finishOld = resolvePromise
    })

    hermes.getSkillHubSources
      .mockResolvedValueOnce({ installed: {} }) // old refresh: default
      .mockImplementationOnce(() => oldAlfred) // old refresh: atum-alfred, still pending
      .mockResolvedValue({ installed: { [entry.identifier]: { name: 'concept-diagrams' } } }) // new refresh: both

    const oldRefresh = refreshAtumSkills()
    $mockAgents.set([
      { id: 'default', title: 'Atum', hostedId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', identityId: 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa' },
      { id: 'atum-new', title: 'Bảo', hostedId: 'cccccccc-1111-4111-8111-cccccccccccc', identityId: 'cccccccc-2222-4222-8222-cccccccccccc' }
    ])
    await refreshAtumSkills()

    finishOld!({ installed: { [entry.identifier]: { name: 'from-the-past' } } })
    await oldRefresh

    const row = $atumSkillRows.get()[0]!
    expect(row.assistants.map(assistant => assistant.agentId)).toEqual(['default', 'atum-new'])
    expect(row.installedFor).toEqual(['default', 'atum-new'])
    expect(row.assistants.every(assistant => assistant.installedName === 'concept-diagrams')).toBe(true)
  })

  it('puts the try-it prompt under a draft already waiting for a new chat, keeps its attachments, and sends nothing', () => {
    $railDestination.set('discover')
    $discoverShelf.set('skills')
    stashSessionDraft(null, '  Nháp đang viết dở', [{ id: 'att-1', kind: 'file', label: 'notes.md' }])

    tryAtumSkill('Vẽ sơ đồ giải thích vòng tuần hoàn của nước.', 'atum-alfred')

    expect(talkToAtumAgent).toHaveBeenCalledWith('atum-alfred')
    expect($railDestination.get()).toBe('chat')
    // Set-then-navigate ordering in reverse: leaving Discover is not an
    // arrival, so the shelf seed is left for the next visit's reset.
    expect($discoverShelf.get()).toBe('skills')

    const draft = takeSessionDraft(null)
    expect(draft.text).toBe('  Nháp đang viết dở\n\nVẽ sơ đồ giải thích vòng tuần hoàn của nước.')
    expect(draft.attachments.map(attachment => attachment.id)).toEqual(['att-1'])
  })

  it('removes with the installed map name rather than the identifier path', async () => {
    hermes.getSkillHubSources.mockResolvedValueOnce({
      installed: { [entry.identifier]: { name: 'locked-diagram-name' } }
    })
    await refreshAtumSkills()

    hermes.uninstallSkillFromHub.mockResolvedValue({ name: 'remove-diagram' })
    hermes.getActionStatus.mockResolvedValue(completed('remove-diagram'))
    // The removal reads the map again inside its turn (still installed, same
    // name), then the settle read sees it gone.
    hermes.getSkillHubSources
      .mockResolvedValueOnce({ installed: { [entry.identifier]: { name: 'locked-diagram-name' } } })
      .mockResolvedValue({ installed: {} })

    await removeAtumSkill(entry, 'default')

    expect(hermes.uninstallSkillFromHub).toHaveBeenCalledWith(
      'locked-diagram-name',
      atumSkillTarget('default')
    )
  })
})
