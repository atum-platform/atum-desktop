import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixAgentHomeBridge, MatrixAgentHomeView } from '../../shared/matrix'

import { MatrixAgentHomeRow } from './agent-home-control'
import { agentHomeCopy, agentHomePlace, agentHomeStatus } from './agent-home-copy'

// These cases exercise the dormant Mac moves, which only tests can reach (cloud-only S0 keeps the
// desktop's one switch on; agent-home-cloud-only.test.tsx covers what the app actually offers).
vi.mock('../../shared/agent-home-cloud-only', async original => ({
  ...(await original<Record<string, unknown>>()),
  AGENT_HOMES_CLOUD_ONLY: false
}))

const AGENT = '00000000-0000-4000-8000-bd7662a5eeb4'
const MINI = '00000000-0000-4000-8000-b454f82c5857'
const CHATGPT = {
  connectionRef: 'conn_codexplan00000001',
  source: 'chatgpt_plan' as const,
  providerLabel: 'ChatGPT',
  model: 'gpt-5.6-luna',
  modelLabel: 'GPT-5.6 Luna',
  effort: 'medium' as const,
  efforts: ['low', 'medium', 'high', 'max'] as const,
  available: true
}
const ATUM = {
  connectionRef: 'conn_atummanaged000001',
  source: 'atum' as const,
  providerLabel: 'Atum',
  model: 'nguyet-thuc',
  modelLabel: 'Nguyệt Thực 1.3',
  effort: 'medium' as const,
  efforts: ['low', 'medium', 'high'] as const,
  available: true
}

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
)
Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })

afterEach(cleanup)

const settled = (): MatrixAgentHomeView => ({
  lives: { kind: 'cloud' },
  move: null,
  targets: [{ id: MINI, name: 'Mac mini' }],
  issue: null,
  placement: {
    profile: 'atum.agent-home/2.5',
    moveAvailable: true,
    current: 'cloud',
    reachability: 'reachable',
    currentModel: ATUM,
    modelStatus: 'applied',
    destinations: [
      { id: 'cloud', kind: 'cloud', name: '', thisMac: false, eligibility: 'ready', catalogRevision: 0, models: [ATUM] },
      { id: MINI, kind: 'mac', name: 'Mac mini', thisMac: false, eligibility: 'ready', catalogRevision: 4, models: [CHATGPT] }
    ]
  }
})

function row(
  view: MatrixAgentHomeView | null = settled(),
  options: { locale?: 'en' | 'vi'; bridge?: Partial<MatrixAgentHomeBridge>; display?: 'icon' | 'row' } = {}
) {
  const bridge: MatrixAgentHomeBridge = {
    read: vi.fn(async () => view ?? undefined),
    preflight: vi.fn(async () => ({
      ok: true as const,
      preflightId: '00000000-0000-4000-8000-303617b97302',
      target: MINI,
      featureLosses: ['cloud_browser_session'],
      lastCheckpointAtPlatform: 1_800_000_000_000,
      checkpointLossRequired: false
    })),
    move: vi.fn(async () => ({ ok: true as const })),
    cancel: vi.fn(async () => ({ ok: true })),
    model: vi.fn(async () => ({ status: 'saved' as const })),
    prepare: vi.fn(async () => ({ ok: true })),
    ...options.bridge
  }
  const element = (next: MatrixAgentHomeView | null) => (
    <I18nProvider configClient={null} initialLocale={options.locale ?? 'en'}>
      <MatrixAgentHomeRow
        agentName="Luna"
        agentPrincipal={AGENT}
        bridge={bridge}
        display={options.display}
        view={next ?? undefined}
      />
    </I18nProvider>
  )
  const { rerender } = render(element(view))

  return { bridge, show: (next: MatrixAgentHomeView | null) => rerender(element(next)) }
}

const page = (view: MatrixAgentHomeView | null = settled(), options: Parameters<typeof row>[1] = {}) =>
  row(view, options).bridge

const openPopover = async () => {
  fireEvent.click(document.querySelector('[data-assistant-card-home]')!)
  return (await waitFor(() => {
    const found = document.querySelector<HTMLElement>('[data-agent-home-popover]')
    expect(found).toBeTruthy()
    return found!
  }))!
}

it('shows the authoritative home and opens a popover, never a side sheet', async () => {
  const bridge = page()
  expect(document.querySelector('[data-agent-home-value]')!.textContent).toBe('The cloud')
  const popover = await openPopover()
  await waitFor(() => expect(bridge.read).toHaveBeenCalledWith(AGENT))

  expect(within(popover).getByText('Lives on')).toBeTruthy()
  expect(popover.querySelector('[data-agent-home-current]')!.textContent).toBe('The cloud')
  expect(popover.querySelector('[data-agent-home-readiness]')!.textContent).toBe('Ready')
  expect(popover.querySelector('[data-agent-home-pill]')!.getAttribute('data-agent-home-pill')).toBe('ready')
  // One short line under the place, the honest D1 promise: one home, moved by hand.
  expect(popover.querySelector('[data-agent-home-line]')!.textContent).toBe('Home · moves are manual')
  expect(popover.textContent).not.toContain('Atum skips offline places')
  expect(within(popover).queryByRole('switch')).toBeNull()
  expect(document.querySelector('[data-slot="sheet-content"]')).toBeNull()
  expect(document.querySelector('[data-agent-home-sheet]')).toBeNull()
  expect(within(popover).queryByRole('button', { name: /^Model/ })).toBeNull()
})

it('lets the owner pick the chosen Mac’s own model before confirming the move', async () => {
  const SOL = {
    connectionRef: 'conn_codexplan00000002',
    source: 'chatgpt_plan' as const,
    providerLabel: 'ChatGPT',
    model: 'gpt-5.6-sol',
    modelLabel: 'GPT-5.6 Sol',
    effort: 'medium' as const,
    efforts: ['low', 'medium', 'high', 'max'] as const,
    available: true
  }
  const view = settled()
  const bridge = page(
    {
      ...view,
      placement: {
        ...view.placement!,
        destinations: [
          view.placement!.destinations[0]!,
          { ...view.placement!.destinations[1]!, models: [CHATGPT, SOL] }
        ]
      }
    }
  )
  const popover = await openPopover()

  // Choosing the Mac only chooses it: its catalog fills the model row, and nothing moves yet.
  fireEvent.click(within(popover).getByRole('button', { name: 'Move to Mac mini' }))
  const model = await within(popover).findByRole('button', { name: /^Model/ })
  expect(bridge.preflight).not.toHaveBeenCalled()
  expect(popover.querySelector('[data-agent-home-chosen]')?.getAttribute('data-agent-home-destination')).toBe(MINI)

  // The shared model card: the destination's providers in the rail, one click on a row.
  fireEvent.click(model)
  const card = await screen.findByRole('dialog', { name: 'Model' })
  expect(card.querySelector('[data-matrix-model-rail-item="openai-codex"]')).toBeTruthy()
  fireEvent.click(within(card).getByRole('button', { name: /^GPT-5\.6 Sol, ChatGPT/ }))
  fireEvent.click(within(popover).getByRole('button', { name: 'Review move' }))

  await waitFor(() => expect(bridge.preflight).toHaveBeenCalledWith(AGENT, MINI, SOL))
  await waitFor(() =>
    expect(bridge.move).toHaveBeenCalledWith(AGENT, '00000000-0000-4000-8000-303617b97302', false)
  )
  // The move is done; the model row goes back to the destination rows.
  await waitFor(() => expect(popover.querySelector('[data-agent-home-model-choice]')).toBeNull())
})

it('asks only when the move would lose work since the last checkpoint', async () => {
  const FORCED = {
    ok: true as const,
    preflightId: '00000000-0000-4000-8000-00f765af1c54',
    target: MINI,
    featureLosses: ['changes_since_last_checkpoint_lost'],
    lastCheckpointAtPlatform: 1_799_998_200_000,
    checkpointLossRequired: true
  }
  const bridge = page(settled(), { bridge: { preflight: vi.fn(async () => FORCED) } })
  const popover = await openPopover()
  fireEvent.click(within(popover).getByRole('button', { name: 'Move to Mac mini' }))
  fireEvent.click(within(popover).getByRole('button', { name: 'Review move' }))

  const losses = await waitFor(() => {
    const found = popover.querySelector<HTMLElement>('[data-agent-home-losses]')
    expect(found).toBeTruthy()
    return found!
  })
  expect(bridge.move).not.toHaveBeenCalled()
  expect(within(losses).getByText(agentHomeCopy('en').actualLosses)).toBeTruthy()

  const expected = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(FORCED.lastCheckpointAtPlatform)
  )
  const info = within(losses).getAllByRole('button', { name: 'More info' })
  fireEvent.pointerMove(info[1]!)
  expect((await screen.findByRole('tooltip')).textContent).toBe(`Last checkpoint: ${expected}`)

  const accept = losses.querySelector('[data-agent-home-accept-checkpoint-loss]') as HTMLElement
  expect(accept.getAttribute('aria-checked')).toBe('false')
  const move = within(losses).getByRole('button', { name: 'Move Luna' }) as HTMLButtonElement
  expect(move.disabled).toBe(true)

  fireEvent.click(accept)
  await waitFor(() => expect((within(losses).getByRole('button', { name: 'Move Luna' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(within(losses).getByRole('button', { name: 'Move Luna' }))

  await waitFor(() => expect(bridge.move).toHaveBeenCalledWith(AGENT, FORCED.preflightId, true))
})

it('does not carry an acceptance over to the next review', async () => {
  const preflight = vi
    .fn()
    .mockResolvedValueOnce({
      ok: true,
      preflightId: '00000000-0000-4000-8000-00f765af1c54',
      target: MINI,
      featureLosses: [],
      lastCheckpointAtPlatform: null,
      checkpointLossRequired: true
    })
    .mockResolvedValueOnce({
      ok: true,
      preflightId: '00000000-0000-4000-8000-50d86b120e98',
      target: MINI,
      featureLosses: [],
      lastCheckpointAtPlatform: null,
      checkpointLossRequired: true
    })
  page(settled(), { bridge: { preflight } })
  const popover = await openPopover()
  fireEvent.click(within(popover).getByRole('button', { name: 'Move to Mac mini' }))
  const target = () => within(popover).getByRole('button', { name: 'Review move' })

  fireEvent.click(target())
  const accept = await waitFor(() => {
    const found = popover.querySelector('[data-agent-home-accept-checkpoint-loss]')
    expect(found).toBeTruthy()
    return found!
  })
  fireEvent.click(accept)
  await waitFor(() => expect(accept.getAttribute('aria-checked')).toBe('true'))

  // Asking again makes a new review that starts unaccepted.
  fireEvent.click(target())
  await waitFor(() => expect(preflight).toHaveBeenCalledTimes(2))
  await waitFor(() =>
    expect(popover.querySelector('[data-agent-home-accept-checkpoint-loss]')!.getAttribute('aria-checked')).toBe('false')
  )
})

it('lists only what will really not move, with no generic line about what stays behind', async () => {
  page(settled(), {
    bridge: {
      preflight: vi.fn(async () => ({
        ok: true as const,
        preflightId: '00000000-0000-4000-8000-6cc9b1298c8f',
        target: MINI,
        featureLosses: ['cloud_browser_session'],
        lastCheckpointAtPlatform: 1_800_000_000_000,
        checkpointLossRequired: true
      }))
    }
  })
  const popover = await openPopover()
  fireEvent.click(within(popover).getByRole('button', { name: 'Move to Mac mini' }))
  fireEvent.click(within(popover).getByRole('button', { name: 'Review move' }))

  const losses = await waitFor(() => {
    const found = popover.querySelector<HTMLElement>('[data-agent-home-losses]')
    expect(found).toBeTruthy()
    return found!
  })
  expect(popover.textContent).not.toMatch(/Sign-ins, browser data|workspace stay/i)
  expect(losses.querySelectorAll('li')).toHaveLength(0)
  fireEvent.pointerMove(within(losses).getAllByRole('button', { name: 'More info' })[0]!)
  expect((await screen.findByRole('tooltip')).textContent).toBe('Cloud browser sessions')
})

it('offers retry without disabled Mac choices when placement cannot be read', async () => {
  page(
    {
      lives: { kind: 'cloud' },
      move: null,
      targets: [
        { id: MINI, name: 'Mac mini', thisMac: true },
        { id: '00000000-0000-4000-8000-f6222a1106ee', name: 'MacBook Air M2' }
      ],
      issue: null
    },
    { locale: 'vi' }
  )

  // The card's value stands alone, so the cloud reads as a place: "Đám mây", not "đám mây".
  expect(document.querySelector('[data-agent-home-value]')!.textContent).toBe('Đám mây')

  const popover = await openPopover()
  expect(popover.querySelector('[data-agent-home-legacy-target]')).toBeNull()
  expect(within(popover).getByRole('button', { name: 'Thử lại' })).toBeTruthy()
  expect(popover.querySelector('[data-agent-home-owner-route-off]')!.textContent).toBe('Hiện chưa kết nối được Atum. Hãy thử lại sau một lát.')
  expect(popover.querySelector('[data-agent-home-current]')!.textContent).toBe('Đám mây')
})

it('says in plain words why a move was refused', async () => {
  const bridge = page(settled(), {
    bridge: { move: vi.fn(async () => ({ ok: false as const, reason: 'preflight_expired' })) }
  })
  const popover = await openPopover()
  fireEvent.click(within(popover).getByRole('button', { name: 'Move to Mac mini' }))
  fireEvent.click(within(popover).getByRole('button', { name: 'Review move' }))

  const alert = await waitFor(() => {
    const found = popover.querySelector<HTMLElement>('[data-agent-home-failure]')
    expect(found).toBeTruthy()
    return found!
  })
  expect(alert.textContent).toBe(agentHomeCopy('en').refusals.preflight_expired)
  expect(bridge.move).toHaveBeenCalledTimes(1)
  // The place rows come back, so the move can be tried again.
  expect(within(popover).getByRole('button', { name: 'Move to Mac mini' })).toBeTruthy()
  expect(popover.querySelector('[data-agent-home-losses]')).toBeNull()
})

it('says why a cancel did not work, and falls back to the usual words for a reason it does not know', async () => {
  const moving: MatrixAgentHomeView = {
    ...settled(),
    move: { step: 'saving', to: { kind: 'mac', name: 'Mac mini', thisMac: false }, role: 'other' }
  }
  const cancel = vi
    .fn()
    .mockResolvedValueOnce({ ok: false, reason: 'committed_epoch_preserved' })
    .mockResolvedValueOnce({ ok: false, reason: 'something_new' })
  page(moving, { bridge: { cancel } })
  const popover = await openPopover()

  fireEvent.click(within(popover).getByRole('button', { name: 'Cancel move' }))
  let alert = await waitFor(() => {
    const found = popover.querySelector<HTMLElement>('[data-agent-home-failure]')
    expect(found).toBeTruthy()
    return found!
  })
  expect(alert.textContent).toBe(agentHomeCopy('en').refusals.committed_epoch_preserved)

  fireEvent.click(within(popover).getByRole('button', { name: 'Cancel move' }))
  await waitFor(() => expect(cancel).toHaveBeenCalledTimes(2))
  alert = popover.querySelector<HTMLElement>('[data-agent-home-failure]')!
  expect(alert.textContent).toBe(agentHomeCopy('en').cancelFailed)
})

it('renders truthful monotonic progress and an offline Mac wait, never a paid fallback', () => {
  page({
    ...settled(),
    lives: { kind: 'mac', name: 'Mac mini', thisMac: false },
    placement: {
      ...settled().placement!,
      current: MINI,
      reachability: 'offline',
      currentModel: CHATGPT,
      modelStatus: 'pending',
      progress: { state: 'waiting_for_destination', sequence: 3, reason: 'destination_not_serving' }
    }
  })

  expect(document.querySelector('[data-agent-home-value]')!.textContent).toBe('Waiting for Mac mini')
  expect(document.body.textContent).not.toMatch(/fallback|Atum model/i)
})

it('uses five-locale copy and keeps the forced-loss disclosure explicit', () => {
  page(settled(), { locale: 'vi' })
  expect(document.querySelector('[data-assistant-card-home]')!.textContent).toContain('Đang ở trên')
  expect(agentHomeCopy('ja').progress.finishing_current_work('')).toBe('現在の作業を終えています')
  expect(agentHomeCopy('zh').waitingForMac('Mac mini')).toContain('Mac mini')
  expect(agentHomeCopy('zh-hant').losses.changes_since_last_checkpoint_lost).toContain('檢查點')
  expect(agentHomeCopy('vi').livesWhere).toBe('Đang ở trên')
  expect(agentHomeCopy('vi').homeLine).toBe('Nơi chính · chuyển thủ công')
  for (const locale of ['vi', 'ja', 'zh', 'zh-hant'] as const) {
    const words = agentHomeCopy(locale)
    expect(words.homeLine, locale).not.toBe(agentHomeCopy('en').homeLine)
    expect(words.moveSection, locale).not.toBe(agentHomeCopy('en').moveSection)
    for (const reason of Object.keys(agentHomeCopy('en').unavailableReasons) as Array<keyof typeof words.unavailableReasons>) {
      expect(words.unavailableReasons[reason], `${locale} ${reason}`).toBeTruthy()
    }
  }
})

it('keeps the row, quietly saying it is finding out, while the platform has not answered', async () => {
  const read = vi.fn(async () => undefined)
  page(null, { bridge: { read } })

  const row = document.querySelector<HTMLElement>('[data-assistant-card-home]')!
  expect(row.getAttribute('data-agent-home-row')).toBe('pending')
  expect(row.textContent).toContain('Finding where it lives…')

  const popover = await openPopover()
  await waitFor(() => expect(read).toHaveBeenCalled())
  expect(popover.querySelector('[data-agent-home-current]')!.textContent).toBe(agentHomeCopy('en').unknownPlace)
  expect(within(popover).getByRole('button', { name: 'Try again' })).toBeTruthy()
})

const LAPTOP = '00000000-0000-4000-8000-f6222a1106ee'

/** The assistant lives in the cloud; the window is on a MacBook that holds nothing of it, so it is not yet a place to move to. */
const unprepared = (setUp: 'needed' | 'connect' = 'needed'): MatrixAgentHomeView => {
  const base = settled()

  return {
    ...base,
    placement: {
      ...base.placement!,
      destinations: [
        ...base.placement!.destinations,
        {
          id: LAPTOP,
          kind: 'mac',
          name: 'MacBook',
          thisMac: true,
          eligibility: 'unavailable',
          reason: 'catalog_unavailable',
          setUp,
          catalogRevision: 0,
          models: []
        }
      ]
    }
  }
}

it('sets this Mac up as soon as it is chosen, fills its model row from its own catalog, then moves', async () => {
  const ready: MatrixAgentHomeView = {
    ...settled(),
    placement: {
      ...settled().placement!,
      destinations: [
        ...settled().placement!.destinations,
        { id: LAPTOP, kind: 'mac', name: 'MacBook', thisMac: true, eligibility: 'ready', catalogRevision: 7, models: [CHATGPT] }
      ]
    }
  }
  const read = vi.fn().mockResolvedValueOnce(unprepared()).mockResolvedValue(ready)
  let release!: (result: { ok: true }) => void
  const prepare = vi.fn(() => new Promise<{ ok: true }>(resolve => (release = resolve)))
  const bridge = page(unprepared(), { bridge: { prepare, read } })
  const popover = await openPopover()
  await waitFor(() => expect(read).toHaveBeenCalledTimes(1))

  // No separate set-up button: choosing this Mac runs it, and there is one short status line.
  expect(within(popover).queryByRole('button', { name: 'Set this Mac up for Luna' })).toBeNull()
  fireEvent.click(within(popover).getByRole('button', { name: 'Move to this Mac (MacBook)' }))

  await waitFor(() => expect(bridge.prepare).toHaveBeenCalledWith(AGENT))
  expect(within(popover).queryByText('Setting up MacBook…')).toBeTruthy()
  release({ ok: true })

  // The window reads again; the chosen Mac keeps its models from the fresh catalog.
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2))
  expect(await within(popover).findByRole('button', { name: /^Model/ })).toBeTruthy()
  fireEvent.click(within(popover).getByRole('button', { name: 'Review move' }))
  await waitFor(() => expect(bridge.preflight).toHaveBeenCalledWith(AGENT, LAPTOP, CHATGPT))
})

it.each([
  ['target_not_prepared', 'That Mac isn\'t set up for this assistant yet. Set it up first, then try again.'],
  ['setup_busy', 'Atum is busy with this assistant on this Mac. Try again in a moment.'],
  ['another_move_in_progress', 'Another move is still going.'],
  ['connect_model', 'No model is connected on this Mac yet. Connect one, then try again.']
])('says in plain words why the automatic set-up did not work (%s)', async (reason, words) => {
  const bridge = page(unprepared(), { bridge: { prepare: vi.fn(async () => ({ ok: false, reason })) } })
  const popover = await openPopover()
  fireEvent.click(within(popover).getByRole('button', { name: 'Move to this Mac (MacBook)' }))

  const alert = await waitFor(() => {
    const found = popover.querySelector<HTMLElement>('[data-agent-home-failure]')
    expect(found).toBeTruthy()
    return found!
  })
  expect(alert.textContent).toBe(words)
  expect(bridge.prepare).toHaveBeenCalledTimes(1)
  // Review is still there to finish the set-up and try the move again.
  expect((within(popover).getByRole('button', { name: 'Review move' }) as HTMLButtonElement).disabled).toBe(false)
})

it('keeps a setup refusal after Review instead of claiming connected models are missing', async () => {
  const stale = unprepared()
  stale.placement!.destinations.find(each => each.id === LAPTOP)!.models = [{ ...ATUM, available: false }]
  const bridge = page(stale, { bridge: { prepare: vi.fn(async () => ({ ok: false, reason: 'not_ready' })) } })
  const popover = await openPopover()
  fireEvent.click(within(popover).getByRole('button', { name: 'Move to this Mac (MacBook)' }))
  const failure = () => popover.querySelector('[data-agent-home-failure]')?.textContent
  await waitFor(() => expect(failure()).toBe(agentHomeCopy('en').refusals.not_ready))

  fireEvent.click(within(popover).getByRole('button', { name: 'Review move' }))
  await waitFor(() => expect(bridge.prepare).toHaveBeenCalledTimes(2))
  await waitFor(() => expect((within(popover).getByRole('button', { name: 'Review move' }) as HTMLButtonElement).disabled).toBe(false))
  expect(failure()).toBe(agentHomeCopy('en').refusals.not_ready)
  expect(bridge.preflight).not.toHaveBeenCalled()
})

it('reviews with a fresh available model after retrying setup against a stale catalog', async () => {
  const stale = unprepared()
  stale.placement!.destinations.find(each => each.id === LAPTOP)!.models = [{ ...ATUM, available: false }]
  const ready = unprepared()
  Object.assign(ready.placement!.destinations.find(each => each.id === LAPTOP)!, {
    eligibility: 'ready', setUp: undefined, models: [{ ...ATUM, available: false }, CHATGPT]
  })
  const read = vi.fn().mockResolvedValueOnce(stale).mockResolvedValueOnce(stale).mockResolvedValue(ready)
  const prepare = vi.fn().mockResolvedValueOnce({ ok: false, reason: 'not_ready' }).mockResolvedValue({ ok: true })
  const bridge = page(stale, { bridge: { read, prepare } })
  const popover = await openPopover()
  fireEvent.click(within(popover).getByRole('button', { name: 'Move to this Mac (MacBook)' }))
  await waitFor(() => expect(popover.querySelector('[data-agent-home-failure]')?.textContent).toBe(agentHomeCopy('en').refusals.not_ready))

  fireEvent.click(within(popover).getByRole('button', { name: 'Review move' }))
  await waitFor(() => expect(bridge.preflight).toHaveBeenCalledWith(AGENT, LAPTOP, CHATGPT))
  await waitFor(() => expect(bridge.move).toHaveBeenCalled())
})

it('keeps a refresh failure after setup instead of claiming models are missing', async () => {
  const read = vi.fn().mockResolvedValueOnce(unprepared()).mockRejectedValue(new Error('offline'))
  const bridge = page(unprepared(), { bridge: { read } })
  const popover = await openPopover()
  fireEvent.click(within(popover).getByRole('button', { name: 'Move to this Mac (MacBook)' }))
  await waitFor(() => expect(popover.querySelector('[data-agent-home-failure]')?.textContent).toBe(agentHomeCopy('en').refusals.unavailable))
  expect(bridge.preflight).not.toHaveBeenCalled()
})

it('selects an available model when refresh leaves the old selection unavailable', async () => {
  const initial = settled()
  initial.placement!.destinations[1]!.models = [ATUM, CHATGPT]
  const { bridge, show } = row(initial)
  const popover = await openPopover()
  fireEvent.click(within(popover).getByRole('button', { name: 'Move to Mac mini' }))
  await waitFor(() => expect(within(popover).getByRole('button', { name: /^Model/ }).textContent).toContain(ATUM.modelLabel))

  const refreshed = settled()
  refreshed.placement!.destinations[1]!.models = [{ ...ATUM, available: false }, CHATGPT]
  show(refreshed)
  await waitFor(() => expect(within(popover).getByRole('button', { name: /^Model/ }).textContent).toContain(CHATGPT.modelLabel))
  fireEvent.click(within(popover).getByRole('button', { name: 'Review move' }))
  await waitFor(() => expect(bridge.preflight).toHaveBeenCalledWith(AGENT, MINI, CHATGPT))
})

it('does not set up a Mac that is already set up and only lacks a connected model', async () => {
  const bridge = page(unprepared('connect'))
  const popover = await openPopover()
  fireEvent.click(within(popover).getByRole('button', { name: 'Move to this Mac (MacBook)' }))

  await waitFor(() =>
    expect(popover.querySelector('[data-agent-home-no-models]')!.textContent).toBe(
      'No model is connected on MacBook yet.'
    )
  )
  expect(bridge.prepare).not.toHaveBeenCalled()
  expect(within(popover).queryByRole('button', { name: 'Set this Mac up for Luna' })).toBeNull()
  expect((within(popover).getByRole('button', { name: 'Review move' }) as HTMLButtonElement).disabled).toBe(true)
})

it('says the automatic set-up in the owner’s language', async () => {
  let release!: (result: { ok: true }) => void
  const prepare = vi.fn(() => new Promise<{ ok: true }>(resolve => (release = resolve)))
  const bridge = page(unprepared(), { bridge: { prepare }, locale: 'vi' })
  const popover = await openPopover()

  fireEvent.click(within(popover).getByRole('button', { name: 'Chuyển về máy này (MacBook)' }))
  await waitFor(() => expect(bridge.prepare).toHaveBeenCalledWith(AGENT))
  expect(within(popover).queryByText('Đang thiết lập MacBook…')).toBeTruthy()
  release({ ok: true })
})

/** The assistant lives on the Mac mini, which is not answering: the platform offers no move. */
const waiting = (over: Partial<NonNullable<MatrixAgentHomeView['placement']>> = {}): MatrixAgentHomeView => {
  const base = settled()

  return {
    ...base,
    lives: { kind: 'mac', name: 'Mac mini', thisMac: false },
    placement: {
      ...base.placement!,
      moveAvailable: false,
      waitingForHome: true,
      current: MINI,
      reachability: 'offline',
      currentModel: CHATGPT,
      destinations: [
        base.placement!.destinations[0]!,
        { ...base.placement!.destinations[1]!, models: [{ ...CHATGPT, available: false }] },
        { id: LAPTOP, kind: 'mac', name: 'MacBook', thisMac: true, eligibility: 'ready', catalogRevision: 7, models: [CHATGPT] }
      ],
      ...over
    }
  }
}

it('waits for a Mac that is not answering: says so and offers only the disclosed move to the cloud', async () => {
  const bridge = page(waiting(), { bridge: { preflight: vi.fn(async () => ({ ...FORCED, target: 'cloud' })) } })
  const popover = await openPopover()

  expect(document.querySelector('[data-agent-home-value]')!.textContent).toBe('Waiting for Mac mini')
  expect(popover.querySelector('[data-agent-home-waiting]')!.textContent).toBe('Mac mini is offline; wait or move to cloud.')

  // The cloud, and no other Mac while the owner waits for that one.
  const options = [...popover.querySelectorAll<HTMLButtonElement>('[data-agent-home-destination]')]
  expect(options.map(option => option.getAttribute('aria-label'))).toEqual(['Move to the cloud'])
  expect(options[0]!.disabled).toBe(false)

  fireEvent.click(options[0]!)
  await waitFor(() => expect(bridge.preflight).toHaveBeenCalledWith(AGENT, 'cloud', ATUM))
  const losses = await waitFor(() => {
    const found = popover.querySelector<HTMLElement>('[data-agent-home-losses]')
    expect(found).toBeTruthy()
    return found!
  })
  fireEvent.click(losses.querySelector('[data-agent-home-accept-checkpoint-loss]')!)
  await waitFor(() =>
    expect((within(losses).getByRole('button', { name: 'Move Luna' }) as HTMLButtonElement).disabled).toBe(false)
  )
  fireEvent.click(within(losses).getByRole('button', { name: 'Move Luna' }))
  await waitFor(() => expect(bridge.move).toHaveBeenCalledWith(AGENT, FORCED.preflightId, true))
})

const FORCED = {
  ok: true as const,
  preflightId: '00000000-0000-4000-8000-0bb5de138389',
  target: MINI,
  featureLosses: ['changes_since_last_checkpoint_lost'],
  lastCheckpointAtPlatform: 1_799_998_200_000,
  checkpointLossRequired: true
}

it('moves the offered places back to none when the home Mac stops answering', async () => {
  const base = settled()
  const three: MatrixAgentHomeView = {
    ...base,
    placement: {
      ...base.placement!,
      destinations: [
        ...base.placement!.destinations,
        { id: LAPTOP, kind: 'mac', name: 'MacBook', thisMac: true, eligibility: 'ready', catalogRevision: 7, models: [CHATGPT] }
      ]
    }
  }
  const { show } = row(three)
  const popover = await openPopover()
  expect(within(popover).getByRole('button', { name: 'Move to this Mac (MacBook)' })).toBeTruthy()

  // The home Mac stops answering: another Mac is not offered any more, so neither is the row.
  show(waiting())
  await waitFor(() =>
    expect(within(popover).queryByRole('button', { name: 'Move to this Mac (MacBook)' })).toBeNull()
  )
  expect(popover.querySelector('[data-agent-home-no-place]')).toBeNull()
})

it('keeps Cancel reachable for a move under way while the Mac is not answering', async () => {
  const moving: MatrixAgentHomeView = {
    ...waiting({ progress: { state: 'finishing_current_work', sequence: 2, reason: null } }),
    move: { step: 'saving', to: { kind: 'cloud' }, role: 'other' }
  }
  const bridge = page(moving)
  const popover = await openPopover()

  fireEvent.click(await within(popover).findByRole('button', { name: 'Cancel move' }))
  await waitFor(() => expect(bridge.cancel).toHaveBeenCalledWith(AGENT))
})

it('says the wait for the Mac in every language', () => {
  for (const locale of ['en', 'vi', 'ja', 'zh', 'zh-hant'] as const) {
    const copy = agentHomeCopy(locale)

    expect(copy.waitingForCurrentMac('Mac mini'), locale).toContain('Mac mini')
    expect(copy.preparing('Mac mini'), locale).toContain('Mac mini')
    expect(copy.refusals.connect_model, locale).toBeTruthy()
    expect(copy.finding.length, locale).toBeGreaterThan(2)
  }
})


it('gives the cloud a sentence-case name when it stands alone, and keeps it lowercase mid-sentence', () => {
  for (const locale of ['en', 'vi', 'ja', 'zh', 'zh-hant'] as const) {
    const copy = agentHomeCopy(locale)
    const place = agentHomePlace(copy, { kind: 'cloud' })
    const status = agentHomeStatus(copy, { step: 'asking', to: { kind: 'cloud' }, role: 'other' })

    expect(place, locale).toBe(place.charAt(0).toUpperCase() + place.slice(1))
    expect(status, locale).toContain(copy.cloud)
  }

  expect(agentHomePlace(agentHomeCopy('vi'), { kind: 'cloud' })).toBe('Đám mây')
  expect(agentHomePlace(agentHomeCopy('en'), { kind: 'cloud' })).toBe('The cloud')
  // A move's progress line still reads as a sentence: "Đang bắt đầu chuyển sang đám mây…".
  expect(agentHomeStatus(agentHomeCopy('vi'), { step: 'asking', to: { kind: 'cloud' }, role: 'other' })).toContain(
    'sang đám mây'
  )
})

describe('the title bar icon', () => {
  const trigger = () => document.querySelector<HTMLButtonElement>('[data-matrix-agent-home]')!

  it('is a cloud while the assistant answers from the cloud', () => {
    page(settled(), { display: 'icon', locale: 'vi' })

    expect(trigger().getAttribute('data-agent-home-place')).toBe('cloud')
    expect(trigger().querySelector('.atum-icon-cloud')).toBeTruthy()
    expect(trigger().querySelector('.atum-icon-desktop')).toBeNull()
    expect(trigger().getAttribute('aria-label')).toBe('Đang ở trên: Đám mây · Sẵn sàng')
  })

  it('is a computer while the assistant answers from a Mac, and follows a move once it lands', () => {
    const onMac: MatrixAgentHomeView = {
      ...settled(),
      lives: { kind: 'mac', name: 'Mac mini', thisMac: false },
      placement: { ...settled().placement!, current: MINI, currentModel: CHATGPT }
    }
    const { show } = row(onMac, { display: 'icon' })

    expect(trigger().getAttribute('data-agent-home-place')).toBe('mac')
    expect(trigger().querySelector('.atum-icon-desktop')).toBeTruthy()
    expect(trigger().getAttribute('aria-label')).toBe('Lives on: Mac mini · Ready')

    show(settled())
    expect(trigger().getAttribute('data-agent-home-place')).toBe('cloud')
  })

  it('still names the Mac it answers from while a move is under way, with the moving mark', () => {
    page(
      {
        ...settled(),
        lives: { kind: 'mac', name: 'Mac mini', thisMac: false },
        move: { step: 'saving', to: { kind: 'cloud' }, role: 'other' },
        placement: { ...settled().placement!, current: MINI }
      },
      { display: 'icon' }
    )

    expect(trigger().getAttribute('data-agent-home-place')).toBe('mac')
    expect(trigger().querySelector('[data-agent-home-moving]')).toBeTruthy()
    expect(trigger().getAttribute('aria-label')).toBe('Lives on: Mac mini · Moving…')
  })

  it('opens the same popover as the card row', async () => {
    page(settled(), { display: 'icon' })
    fireEvent.click(trigger())

    const popover = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-agent-home-popover]')
      expect(found).toBeTruthy()
      return found!
    })
    expect(popover.querySelector('[data-agent-home-here] .atum-icon-cloud')).toBeTruthy()
    expect(within(popover).getByRole('button', { name: 'Move to Mac mini' })).toBeTruthy()
  })
})

it('lists move targets as menu rows with their device icon, this Mac marked, and why a place is off', async () => {
  const base = settled()
  page(
    {
      ...base,
      placement: {
        ...base.placement!,
        destinations: [
          ...base.placement!.destinations,
          { id: LAPTOP, kind: 'mac', name: 'MacBook', thisMac: true, eligibility: 'ready', catalogRevision: 7, models: [CHATGPT] },
          {
            id: '00000000-0000-4000-8000-f1d11edf5c5c',
            kind: 'mac',
            name: 'iMac',
            thisMac: false,
            eligibility: 'unavailable',
            reason: 'offline',
            catalogRevision: 2,
            models: []
          }
        ]
      }
    },
    { locale: 'vi' }
  )
  const popover = await openPopover()

  expect(within(popover).getByText('Chuyển sang')).toBeTruthy()
  const rows = [...popover.querySelectorAll<HTMLButtonElement>('[data-agent-home-destination]')]
  // The current place is the header, not a row; every row says the place by name with its icon.
  expect(rows.map(each => each.querySelector('.min-w-0')!.textContent)).toEqual(['Mac mini', 'MacBook', 'iMac'])
  expect(rows.every(each => each.querySelector('.atum-icon-desktop'))).toBe(true)

  const here = within(popover).getByRole('button', { name: 'Chuyển về máy này (MacBook)' }) as HTMLButtonElement
  expect(here.querySelector('[data-agent-home-tag]')!.textContent).toBe('Máy này')
  expect(here.disabled).toBe(false)

  const off = within(popover).getByRole('button', { name: 'Chuyển sang iMac' }) as HTMLButtonElement
  expect(off.disabled).toBe(true)
  expect(off.querySelector('[data-agent-home-tag]')!.textContent).toBe('Ngoại tuyến')

  // Choosing a Mac marks it, in place of its trailing word.
  fireEvent.click(here)
  await waitFor(() => expect(here.getAttribute('aria-pressed')).toBe('true'))
  expect(here.querySelector('[data-agent-home-tag]')).toBeNull()
  expect(popover.querySelector('[data-agent-home-model-choice]')).toBeTruthy()
})

it('shows the cloud as a move target with the cloud icon when the assistant lives on a Mac', async () => {
  page({
    ...settled(),
    lives: { kind: 'mac', name: 'Mac mini', thisMac: false },
    placement: { ...settled().placement!, current: MINI, currentModel: CHATGPT }
  })
  const popover = await openPopover()

  expect(popover.querySelector('[data-agent-home-current]')!.textContent).toBe('Mac mini')
  expect(popover.querySelector('[data-agent-home-here] .atum-icon-desktop')).toBeTruthy()
  const cloud = within(popover).getByRole('button', { name: 'Move to the cloud' })
  expect(cloud.querySelector('.atum-icon-cloud')).toBeTruthy()
  expect(cloud.textContent).toBe('The cloud')
})

it('retries a failed owner read on online and clears the failure after recovery', async () => {
  const bridge = page()
  vi.mocked(bridge.read).mockRejectedValueOnce(new Error('unreachable'))
  const popover = await openPopover()
  await waitFor(() => expect(popover.querySelector('[data-agent-home-failure]')).toBeTruthy())
  fireEvent(window, new Event('online'))
  await waitFor(() => expect(bridge.read).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(popover.querySelector('[data-agent-home-failure]')).toBeNull())
})
