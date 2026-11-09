import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixExecutionPolicyBridge, MatrixExecutionPolicyView } from '../../shared/execution-policy'
import { parseExecutionPolicySnapshot, parseExecutionStatusSnapshot } from '../../shared/execution-policy'
import policyFixture from '../../shared/execution-policy/fixtures/execution-policy/v1/fixtures/policy-saved.response.json'
import statusFixture from '../../shared/execution-policy/fixtures/execution-policy/v1/fixtures/status-working.response.json'

import { MatrixExecutionPolicyControl } from './execution-policy-control'

// These cases exercise the dormant Mac moves, which only tests can reach (cloud-only S0 keeps the
// desktop's one switch on; agent-home-cloud-only.test.tsx covers what the app actually offers).
vi.mock('../../shared/agent-home-cloud-only', async original => ({
  ...(await original<Record<string, unknown>>()),
  AGENT_HOMES_CLOUD_ONLY: false
}))

const AGENT = '00000000-0000-4000-8000-bd7662a5eeb4'
const policy = parseExecutionPolicySnapshot(policyFixture)!
const status = parseExecutionStatusSnapshot(statusFixture)!
const fresh: MatrixExecutionPolicyView = { policy, status, stale: false }

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
)

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function page(
  view = fresh,
  options: {
    display?: 'icon' | 'row'
    turnOff?: boolean
    memoryNote?: 'local_saved' | 'without_recent'
  } = {}
) {
  const bridge: MatrixExecutionPolicyBridge = {
    read: vi.fn(async () => view),
    save: vi.fn<MatrixExecutionPolicyBridge['save']>(async (_agentPrincipal, update) => ({
      ok: true as const,
      value: { ...policy, revision: update.expectedRevision + 1, order: update.order, disabled: update.disabled }
    })),
    ...(options.turnOff
      ? {
          turnOff: vi.fn<NonNullable<MatrixExecutionPolicyBridge['turnOff']>>(async () => ({
            ok: true as const,
            value: { ...policy, revision: 0, source: 'default' as const, order: ['cloud' as const], disabled: [] }
          }))
        }
      : {})
  }

  const content = (nextView: MatrixExecutionPolicyView) => (
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixExecutionPolicyControl
        agentPrincipal={AGENT}
        bridge={bridge}
        display={options.display}
        memoryNote={options.memoryNote}
        view={nextView}
      />
    </I18nProvider>
  )

  const rendered = render(content(view))

  return {
    bridge,
    rendered,
    rerenderView: (nextView: MatrixExecutionPolicyView) => rendered.rerender(content(nextView))
  }
}

it('opens the fresh authoritative policy from the title-bar machine strip', async () => {
  const { bridge, rendered } = page()
  expect(rendered.container.innerHTML).not.toContain('22222222-2222')
  fireEvent.click(screen.getByRole('button', { name: 'Answering on Mac 1' }))

  expect(await screen.findByRole('heading', { name: 'Where this assistant answers' })).toBeTruthy()
  expect(bridge.read).toHaveBeenCalledExactlyOnceWith(AGENT)
  expect(screen.getByRole('switch', { name: 'Turn off Mac 1' })).toBeTruthy()
})

it('closes to the destination answering now, not the first row of the order, with one tooltip', async () => {
  const MAC_A = 'mac:00000000-0000-4000-8000-b454f82c5857'
  const MAC_B = 'mac:00000000-0000-4000-8000-f6222a1106ee'
  const cloudFirst = parseExecutionPolicySnapshot({ ...policy, order: ['cloud', MAC_A, MAC_B], disabled: [] })!

  const answering = parseExecutionStatusSnapshot({
    ...statusFixture,
    current: MAC_A,
    desired: MAC_A,
    order: ['cloud', MAC_A, MAC_B],
    disabled: [],
    destinations: {
      cloud: { state: 'offline', reason: 'not_present', observedAt: 1791876998000 },
      [MAC_A]: { state: 'working', observedAt: 1791876999000 },
      [MAC_B]: { state: 'ready', observedAt: 1791876997000 }
    }
  })!

  const { rendered } = page({ policy: cloudFirst, status: answering, stale: false })
  const trigger = rendered.container.querySelector<HTMLElement>('[data-matrix-execution-policy]')!

  expect(trigger.querySelector('[data-destination-kind="mac"]')).toBeTruthy()
  expect(trigger.querySelectorAll('[role="img"]')).toHaveLength(1)

  fireEvent.pointerMove(trigger, { pointerType: 'mouse' })
  expect((await screen.findByRole('tooltip')).textContent).toBe('Answering on Mac 1')
})

it('shows the owner’s pause glyph when every destination is off, and one neutral mark while stale', async () => {
  const MAC_A = 'mac:00000000-0000-4000-8000-b454f82c5857'
  const allOff = parseExecutionPolicySnapshot({ ...policy, order: ['cloud', MAC_A], disabled: ['cloud', MAC_A] })!

  const paused = parseExecutionStatusSnapshot({
    ...statusFixture,
    state: 'paused',
    current: null,
    desired: null,
    order: ['cloud', MAC_A],
    disabled: ['cloud', MAC_A],
    destinations: {
      cloud: { state: 'disabled', reason: 'owner_disabled', observedAt: 1791876998000 },
      [MAC_A]: { state: 'disabled', reason: 'owner_disabled', observedAt: 1791876999000 }
    }
  })!

  const { rendered } = page({ policy: allOff, status: paused, stale: false })
  const trigger = rendered.container.querySelector<HTMLElement>('[data-matrix-execution-policy]')!
  const glyph = trigger.querySelector<HTMLElement>('[data-execution-policy-trigger="paused"]')!

  expect(glyph.getAttribute('data-execution-policy-mark')).toBe('pause')
  expect(glyph.querySelectorAll('svg')).toHaveLength(1)
  expect(trigger.querySelectorAll('[data-destination-kind]')).toHaveLength(0)

  fireEvent.pointerMove(trigger, { pointerType: 'mouse' })
  expect((await screen.findByRole('tooltip')).textContent).toBe('Paused')
  cleanup()

  const stale = page({ ...fresh, stale: true })
  const muted = stale.rendered.container.querySelector<HTMLElement>('[data-execution-policy-trigger="loading"]')!

  // A stale view is not "the cloud is offline": the mark is neutral, never a cloud.
  expect(muted.getAttribute('data-execution-policy-mark')).toBe('neutral')
  expect(muted.querySelectorAll('svg')).toHaveLength(1)
  expect(muted.querySelectorAll('[data-destination-kind]')).toHaveLength(0)
  expect(muted.querySelector('[data-execution-policy-mark="cloud"]')).toBeNull()
})

it('speaks its tooltip through the button’s accessible name, memory note included', async () => {
  const { rendered } = page()
  const trigger = rendered.container.querySelector<HTMLElement>('[data-matrix-execution-policy]')!

  expect(trigger.closest('button')?.getAttribute('aria-label')).toBe('Answering on Mac 1')
  cleanup()

  const noted = page(fresh, { memoryNote: 'without_recent' })
  const named = noted.rendered.container.querySelector<HTMLElement>('[data-matrix-execution-policy]')!
  const answerOnMac = 'Answering on Mac 1 · '

  expect(named.closest('button')?.getAttribute('aria-label')).toContain(answerOnMac)
  expect(named.closest('button')?.getAttribute('aria-label')).toContain('without the cloud’s recent memory')

  fireEvent.pointerMove(named, { pointerType: 'mouse' })
  expect((await screen.findByRole('tooltip')).textContent).toBe(named.closest('button')?.getAttribute('aria-label'))
})

it('keeps the memory note as the one tooltip’s suffix', async () => {
  const { rendered } = page(fresh, { memoryNote: 'without_recent' })

  fireEvent.pointerMove(rendered.container.querySelector('[data-matrix-execution-policy]')!, { pointerType: 'mouse' })
  const tip = await screen.findByRole('tooltip')
  expect(tip.textContent).toContain('Answering on Mac 1 · ')
  expect(tip.textContent).toContain('without the cloud’s recent memory')
})

it('never edits a stale cache and offers an explicit strict reread', async () => {
  const { bridge } = page({ ...fresh, stale: true })
  fireEvent.click(screen.getByRole('button', { name: 'Where this assistant answers' }))

  expect(await screen.findByText('Could not refresh these choices. Reload to try again.')).toBeTruthy()
  expect(screen.queryByRole('switch')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
  await waitFor(() => expect(bridge.read).toHaveBeenCalledTimes(2))
})

it('keeps an attempted draft visible when its failed save makes the controller stale', async () => {
  vi.useFakeTimers()
  const { bridge, rerenderView } = page()
  vi.mocked(bridge.save).mockResolvedValueOnce({
    ok: false,
    error: { error: 'matrix_503', details: { reason: 'unavailable' } }
  })

  fireEvent.click(screen.getByRole('button', { name: 'Answering on Mac 1' }))
  await act(async () => {})
  fireEvent.click(screen.getByRole('switch', { name: 'Turn on Mac 2' }))
  await act(async () => {
    vi.advanceTimersByTime(1_000)
  })

  expect(screen.getByRole('switch', { name: 'Turn off Mac 2' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()

  rerenderView({ ...fresh, stale: true })

  // Main's stale publication cannot unmount the editor and discard its draft. It closes the rows
  // and replaces same-body retry with the strict read the controller requires.
  expect(screen.getByRole('switch', { name: 'Turn off Mac 2' })).toBeTruthy()
  expect(screen.getAllByRole('switch').every(control => (control as HTMLButtonElement).disabled)).toBe(true)
  expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
  await act(async () => {})
  rerenderView(fresh)

  expect(screen.getByRole('switch', { name: 'Turn off Mac 2' })).toBeTruthy()
  expect(screen.getAllByRole('switch').every(control => !(control as HTMLButtonElement).disabled)).toBe(true)
  expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
})

it('shows Reload when an open fresh editor becomes stale without a save failure', async () => {
  const { rerenderView } = page()

  fireEvent.click(screen.getByRole('button', { name: 'Answering on Mac 1' }))
  await act(async () => {})
  rerenderView({ ...fresh, stale: true })

  expect(screen.getByRole('heading', { name: 'Where this assistant answers' })).toBeTruthy()
  expect(screen.getByText('Could not refresh these choices. Reload to try again.')).toBeTruthy()
  expect(screen.getAllByRole('switch').every(control => (control as HTMLButtonElement).disabled)).toBe(true)
  expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy()
})

it('sends one complete editor update through the narrow bridge a second after the change', async () => {
  vi.useFakeTimers()
  const { bridge } = page()
  fireEvent.click(screen.getByRole('button', { name: 'Answering on Mac 1' }))
  screen.getByRole('heading', { name: 'Where this assistant answers' })
  // Let the popover's own open-read settle so the post-save reread is not coalesced behind it.
  await act(async () => {})
  fireEvent.click(screen.getByRole('switch', { name: 'Turn on Mac 2' }))
  await act(async () => {
    vi.advanceTimersByTime(1_000)
  })

  expect(bridge.save).toHaveBeenCalledTimes(1)
  expect(vi.mocked(bridge.save).mock.calls[0][0]).toBe(AGENT)
  expect(vi.mocked(bridge.save).mock.calls[0][1]).toMatchObject({
    expectedRevision: 2,
    order: ['mac:00000000-0000-4000-8000-b454f82c5857', 'cloud', 'mac:00000000-0000-4000-8000-f6222a1106ee'],
    disabled: []
  })
  // A successful save asks for fresh status right away.
  await act(async () => {})
  expect(bridge.read).toHaveBeenCalledTimes(2)
})

it('turns failover off through the bridge, fenced on the revision shown, only when the platform allows it', async () => {
  const { bridge } = page({ ...fresh, off: true }, { turnOff: true })
  fireEvent.click(screen.getByRole('button', { name: 'Answering on Mac 1' }))
  await screen.findByRole('heading', { name: 'Where this assistant answers' })

  fireEvent.click(screen.getByRole('button', { name: 'Turn off failover' }))
  expect(bridge.turnOff).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Turn off' }))

  await waitFor(() => expect(bridge.turnOff).toHaveBeenCalledTimes(1))
  expect(vi.mocked(bridge.turnOff!).mock.calls[0][0]).toBe(AGENT)
  expect(vi.mocked(bridge.turnOff!).mock.calls[0][1]).toMatchObject({ expectedRevision: 2 })
})

it('hides the off switch while the platform does not answer it, or the build has no such call', async () => {
  const unsupported = page(fresh, { turnOff: true })
  fireEvent.click(screen.getByRole('button', { name: 'Answering on Mac 1' }))
  await screen.findByRole('heading', { name: 'Where this assistant answers' })
  expect(screen.queryByRole('button', { name: 'Turn off failover' })).toBeNull()
  expect(unsupported.bridge.turnOff).not.toHaveBeenCalled()
  cleanup()

  page({ ...fresh, off: true })
  fireEvent.click(screen.getByRole('button', { name: 'Answering on Mac 1' }))
  await screen.findByRole('heading', { name: 'Where this assistant answers' })
  expect(screen.queryByRole('button', { name: 'Turn off failover' })).toBeNull()
})

it('says in the title bar and the popover that this Mac answers without the cloud’s recent memory', async () => {
  const { rendered } = page(fresh, { memoryNote: 'without_recent' })
  const trigger = rendered.container.querySelector('[data-matrix-execution-policy]')!
  expect(trigger.getAttribute('data-matrix-execution-memory-note')).toBe('without_recent')

  fireEvent.click(screen.getByRole('button', { name: /^Answering on Mac 1/u }))
  expect(await screen.findByText(/answering without the cloud’s recent memory/u)).toBeTruthy()
  cleanup()

  const quiet = page(fresh)
  expect(quiet.rendered.container.querySelector('[data-matrix-execution-memory-note]')).toBeNull()
})

it('says in the title bar and the popover that the cloud’s copy replaced memory this Mac had changed, and where it is saved', async () => {
  const { rendered } = page(fresh, { memoryNote: 'local_saved' })
  const trigger = rendered.container.querySelector('[data-matrix-execution-policy]')!
  expect(trigger.getAttribute('data-matrix-execution-memory-note')).toBe('local_saved')

  fireEvent.click(screen.getByRole('button', { name: /^Answering on Mac 1/u }))
  expect(await screen.findByText(/earlier versions are saved on this Mac/u)).toBeTruthy()
  // It is not the "without recent memory" note: that one means the opposite.
  expect(screen.queryByText(/answering without the cloud’s recent memory/u)).toBeNull()
})

it('shows the assistant card’s “Nơi trả lời” row as the same summary, opening the same editor', async () => {
  const { rendered } = page(fresh, { display: 'row' })
  const row = rendered.container.querySelector<HTMLElement>('[data-assistant-card-answer-where]')!

  expect(row.getAttribute('data-execution-policy-row')).toBe('destination')
  expect(row.textContent).toContain('Where it answers')
  expect(row.textContent).toBe('Where it answersMac 1')
  // A row, not a second title-bar icon.
  expect(rendered.container.querySelector('[data-matrix-execution-policy]')).toBeNull()

  fireEvent.click(row)
  expect(await screen.findByRole('heading', { name: 'Where this assistant answers' })).toBeTruthy()
})

it('gives the card row the policy’s own pause and unknown words, never a made-up destination', () => {
  const MAC_A = 'mac:00000000-0000-4000-8000-b454f82c5857'
  const allOff = parseExecutionPolicySnapshot({ ...policy, order: ['cloud', MAC_A], disabled: ['cloud', MAC_A] })!

  const pausedStatus = parseExecutionStatusSnapshot({
    ...statusFixture,
    state: 'paused',
    current: null,
    desired: null,
    order: ['cloud', MAC_A],
    disabled: ['cloud', MAC_A],
    destinations: {
      cloud: { state: 'disabled', reason: 'owner_disabled', observedAt: 1791876998000 },
      [MAC_A]: { state: 'disabled', reason: 'owner_disabled', observedAt: 1791876999000 }
    }
  })!

  const paused = page({ policy: allOff, status: pausedStatus, stale: false }, { display: 'row' })
  const pausedRow = paused.rendered.container.querySelector<HTMLElement>('[data-assistant-card-answer-where]')!
  expect(pausedRow.getAttribute('data-execution-policy-row')).toBe('paused')
  expect(pausedRow.textContent).toContain('Paused')
  cleanup()

  const stale = page({ ...fresh, stale: true }, { display: 'row' })
  const staleRow = stale.rendered.container.querySelector<HTMLElement>('[data-assistant-card-answer-where]')!
  expect(staleRow.getAttribute('data-execution-policy-row')).toBe('unavailable')
  expect(staleRow.textContent).toContain('Status unavailable')
})

it('keeps a very long Mac name whole in the card row, so ellipsizing never loses it', () => {
  const LONG = 'MacBook Pro 16 inch ở phòng làm việc tầng hai, dùng để thiết kế đồ họa'
  const named = { ...fresh, deviceNames: { '00000000-0000-4000-8000-b454f82c5857': { displayName: LONG, thisMac: false } } }
  const { rendered } = page(named, { display: 'row' })
  const row = rendered.container.querySelector<HTMLElement>('[data-assistant-card-answer-where]')!

  expect(row.textContent).toBe(`Where it answers${LONG}`)
  expect(row.querySelector('[title]')?.getAttribute('title')).toBe(LONG)
})
