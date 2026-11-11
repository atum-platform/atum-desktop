import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  AgentMemoryBridge,
  AgentMemoryBrowse,
  AgentMemoryForgetResult,
  AgentMemoryStatus
} from '../../../shared/agent-memory'

import { agentMemoryCopies } from './memory-copy'
import { AGENT_MEMORY_PENDING_RETRY_MS, AgentMemoryRow } from './memory-row'

const copy = agentMemoryCopies.en
const PRINCIPAL = '00000000-0000-4000-8000-6a1f0c3e9b21'
const SCOPE = 'scope-aaaaaaaaaaaaaaaa'
const NEXT_SCOPE = 'scope-bbbbbbbbbbbbbbbb'
const FACT = 'fact-aaaaaaaaaaaaaaaaaa'
const FACT_2 = 'fact-bbbbbbbbbbbbbbbbbb'
const SOURCE = 'source-aaaaaaaaaaaaaaaa'

const on = (scope = SCOPE, revision = 2): AgentMemoryStatus => ({ available: true, scope, state: 'on', revision })

const listing = (scope = SCOPE, extra: Partial<AgentMemoryBrowse> = {}): AgentMemoryBrowse => ({
  scope,
  coverage: 'complete',
  more: false,
  sources: [
    {
      handle: SOURCE,
      kind: 'human_dm',
      label: 'Linh',
      coverage: 'complete',
      facts: [
        { handle: FACT, text: 'Linh prefers tea.', learnedAt: Date.UTC(2026, 10, 1), canOpen: true },
        { handle: FACT_2, text: 'Linh works on the Hanoi launch.', learnedAt: Date.UTC(2026, 10, 2), canOpen: false }
      ]
    }
  ],
  receipts: [],
  ...extra
})

function bridge(overrides: Partial<AgentMemoryBridge> = {}): AgentMemoryBridge {
  return {
    status: vi.fn(async () => ({ ok: true as const, status: on() })),
    setEnabled: vi.fn(async (_p, input) => ({
      ok: true as const,
      status: { available: true as const, scope: input.scope, state: input.enabled ? ('on' as const) : ('off' as const), revision: input.revision + 1 }
    })),
    browse: vi.fn(async (_p, input) => ({ ok: true as const, browse: listing(input.scope) })),
    forget: vi.fn(async () => ({ ok: true as const, cleanup: { state: 'hidden' as const }, status: on() })),
    correct: vi.fn(async (_p, input) => ({
      ok: true as const,
      outcome: 'done' as const,
      fact: { handle: input.handle, text: input.text, learnedAt: Date.UTC(2026, 10, 3), canOpen: true },
      status: on()
    })),
    openSource: vi.fn(async () => ({ ok: true as const })),
    ...overrides
  }
}

async function openPanel(memory: AgentMemoryBridge) {
  const view = render(<AgentMemoryRow agentName="Mây" agentPrincipal={PRINCIPAL} bridge={memory} />)
  const row = await screen.findByRole('button', { name: /Memory/ })
  await waitFor(() => expect(row.textContent).toContain(copy.on))
  fireEvent.click(row)
  await screen.findByText('Linh prefers tea.')

  return view
}

async function forgetFact(text: string) {
  const item = screen.getByText(text).closest('li') as HTMLElement
  const trigger = within(item).getByRole('button', { name: copy.actions })
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
  fireEvent.click(await screen.findByRole('menuitem', { name: copy.forget }))
}

afterEach(() => {
  vi.useRealTimers()
})

describe('AgentMemoryRow', () => {
  it('stays off the card while memory is not available for this assistant', async () => {
    const memory = bridge({ status: vi.fn(async () => ({ ok: true as const, status: { available: false as const } })) })
    const { container } = render(<AgentMemoryRow agentName="Mây" agentPrincipal={PRINCIPAL} bridge={memory} />)

    await waitFor(() => expect(memory.status).toHaveBeenCalled())
    await waitFor(() => expect(container.innerHTML).toBe(''))
  })

  it('lists what it remembers grouped by source, without any handle in the page', async () => {
    const memory = bridge()
    const { container } = await openPanel(memory)

    const group = screen.getByRole('region', { name: 'Linh' })
    expect(within(group).getByText('Linh prefers tea.')).toBeTruthy()
    expect(within(group).getByText('Linh works on the Hanoi launch.')).toBeTruthy()
    expect(screen.getByText(copy.onHelp('Mây'))).toBeTruthy()
    expect(container.textContent).not.toMatch(/scope-|fact-|source-/)
  })

  it('turns memory off and keeps browse, correct and forget working while off', async () => {
    const memory = bridge()
    await openPanel(memory)

    fireEvent.click(screen.getByRole('switch', { name: copy.remembers }))

    await screen.findByText(copy.offHelp('Mây'))
    expect(memory.setEnabled).toHaveBeenCalledWith(PRINCIPAL, expect.objectContaining({ scope: SCOPE, enabled: false, revision: 2 }))
    expect(screen.getByText('Linh prefers tea.')).toBeTruthy()

    await forgetFact('Linh prefers tea.')
    await screen.findByText(copy.hidden)
    expect(screen.queryByText('Linh prefers tea.')).toBeNull()
  })

  it('tells pending, hidden, cleaned and backup-expiry apart', async () => {
    const results: AgentMemoryForgetResult[] = [
      { ok: true, cleanup: { state: 'cleaned', backupExpiresAt: Date.UTC(2026, 11, 20) }, status: on() },
      { ok: true, cleanup: { state: 'cleaned' }, status: on() }
    ]

    const memory = bridge({
      forget: vi.fn(async () => results.shift() as AgentMemoryForgetResult),
      browse: vi.fn(async () => ({
        ok: true as const,
        browse: listing(SCOPE, {
          receipts: [
            { key: 'receipt-aaaaaaaaaaaaaaa', target: 'source', sourceKind: 'human_group', sourceLabel: 'Team', cleanup: { state: 'hidden' } },
            { key: 'receipt-bbbbbbbbbbbbbbb', target: 'fact', sourceKind: 'drive_file', cleanup: { state: 'pending' } }
          ]
        })
      }))
    })

    await openPanel(memory)

    const forgottenList = screen.getByRole('region', { name: copy.forgotten })
    expect(within(forgottenList).getByText(copy.forgottenSource('Team'))).toBeTruthy()
    expect(within(forgottenList).getByText(copy.hidden)).toBeTruthy()
    expect(within(forgottenList).getByText(copy.forgetting)).toBeTruthy()

    await forgetFact('Linh prefers tea.')
    await screen.findByText(new RegExp(copy.backupUntil('')))

    await forgetFact('Linh works on the Hanoi launch.')
    await screen.findByText(copy.cleaned)
  })

  it('retries an accepted-but-pending forget with the same operation ID until it lands', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })

    const forget = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, cleanup: { state: 'pending' }, status: on() })
      .mockResolvedValueOnce({ ok: true, cleanup: { state: 'pending' }, status: on() })
      .mockResolvedValue({ ok: true, cleanup: { state: 'hidden' }, status: on() })

    const memory = bridge({ forget })
    await openPanel(memory)

    await forgetFact('Linh prefers tea.')
    await screen.findByText(copy.forgetting)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(AGENT_MEMORY_PENDING_RETRY_MS[0]! + AGENT_MEMORY_PENDING_RETRY_MS[1]!)
    })

    await screen.findByText(copy.hidden)
    const ids = forget.mock.calls.map(call => call[1].operationId)
    expect(ids).toHaveLength(3)
    expect(new Set(ids).size).toBe(1)
  })

  it('offers Retry when offline and retries with the same operation ID', async () => {
    const forget = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: 'offline' })
      .mockResolvedValue({ ok: true, cleanup: { state: 'hidden' }, status: on() })

    const memory = bridge({ forget })
    await openPanel(memory)

    await forgetFact('Linh prefers tea.')
    const item = (await screen.findByText(copy.forgetFailed, { exact: false })).closest('li') as HTMLElement
    fireEvent.click(within(item).getByRole('button', { name: copy.retry }))

    await screen.findByText(copy.hidden)
    expect(forget.mock.calls[0]![1].operationId).toBe(forget.mock.calls[1]![1].operationId)
  })

  it('shows a calm notice with Retry when memory cannot be reached, and nothing else breaks', async () => {
    const browse = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: 'offline' })
      .mockImplementation(async (_p, input) => ({ ok: true, browse: listing(input.scope) }))

    const memory = bridge({ browse })
    render(<AgentMemoryRow agentName="Mây" agentPrincipal={PRINCIPAL} bridge={memory} />)
    const row = await screen.findByRole('button', { name: /Memory/ })
    await waitFor(() => expect(row.textContent).toContain(copy.on))
    fireEvent.click(row)

    fireEvent.click(await screen.findByRole('button', { name: copy.retry }))
    await screen.findByText('Linh prefers tea.')
  })

  it('reads again after a stale scope (an account switch) and drops the old handles', async () => {
    const status = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: on(SCOPE) })
      .mockResolvedValue({ ok: true, status: on(NEXT_SCOPE) })

    const forget = vi.fn(async () => ({ ok: false as const, reason: 'stale' as const }))
    const memory = bridge({ status, forget })
    await openPanel(memory)

    await forgetFact('Linh prefers tea.')

    await waitFor(() => expect(memory.browse).toHaveBeenLastCalledWith(PRINCIPAL, { scope: NEXT_SCOPE }))
    await screen.findByText('Linh prefers tea.')
    expect(screen.queryByText(copy.forgetFailed, { exact: false })).toBeNull()
  })

  it('forgets everything from one source only after a confirm', async () => {
    const memory = bridge({ forget: vi.fn(async () => ({ ok: true as const, cleanup: { state: 'hidden' as const }, status: on() })) })
    await openPanel(memory)

    fireEvent.click(screen.getByRole('button', { name: copy.forgetAll }))
    expect(memory.forget).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: copy.forget }))

    await screen.findByText(copy.forgottenSource('Linh'))
    expect(memory.forget).toHaveBeenCalledWith(PRINCIPAL, expect.objectContaining({ target: { kind: 'source', handle: SOURCE } }))
    expect(screen.queryByText('Linh prefers tea.')).toBeNull()
  })

  it('corrects one fact and shows the corrected words', async () => {
    const memory = bridge()
    await openPanel(memory)

    const item = screen.getByText('Linh prefers tea.').closest('li') as HTMLElement
    fireEvent.pointerDown(within(item).getByRole('button', { name: copy.actions }), { button: 0, ctrlKey: false })
    fireEvent.click(await screen.findByRole('menuitem', { name: copy.correct }))
    const field = screen.getByRole('textbox', { name: copy.correct })
    fireEvent.change(field, { target: { value: 'Linh prefers green tea.' } })
    fireEvent.click(screen.getByRole('button', { name: copy.save }))

    await screen.findByText('Linh prefers green tea.')
    expect(memory.correct).toHaveBeenCalledWith(PRINCIPAL, expect.objectContaining({ handle: FACT, text: 'Linh prefers green tea.' }))
  })

  it('asks main to revalidate a citation on every open, and says so when it is gone', async () => {
    const openSource = vi
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, reason: 'offline' })

    const memory = bridge({ openSource })
    await openPanel(memory)

    // Only facts whose source can be opened offer Open.
    expect(screen.getAllByRole('button', { name: copy.open })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: copy.open }))
    await waitFor(() => expect(openSource).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: copy.open }))

    await screen.findByText(copy.openFailed, { exact: false })
    expect(openSource).toHaveBeenNthCalledWith(2, PRINCIPAL, { scope: SCOPE, handle: FACT })
  })

  it('says when the list is incomplete', async () => {
    const memory = bridge({ browse: vi.fn(async () => ({ ok: true as const, browse: listing(SCOPE, { coverage: 'partial' }) })) })
    await openPanel(memory)

    expect(screen.getByText(copy.partial)).toBeTruthy()
  })
})
