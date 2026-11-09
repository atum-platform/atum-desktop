import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { en } from '@/i18n/en'

import { awarenessFixture } from './fixtures'
import { AwarenessPanel } from './panel'
import type { AwarenessPanelProps, AwarenessSnapshot } from './types'

const copy = en.atum.awareness
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function panel(snapshot: AwarenessSnapshot, extra: Partial<AwarenessPanelProps> = {}) {
  return (
    <I18nProvider initialLocale="en">
      <AwarenessPanel currentScopeKey={snapshot.scopeKey} data={{ state: 'ready', snapshot }} {...extra} />
    </I18nProvider>
  )
}

describe('private owner awareness presentation', () => {
  it('shows all coverage states, reasons, times and evidence epistemic types without raw identifiers', () => {
    const snapshot = awarenessFixture(Date.now())
    render(panel(snapshot))

    for (const source of snapshot.sources) {
      expect(screen.getByText(copy.states[source.state])).toBeTruthy()

      for (const reason of source.reasons) {
        expect(screen.getByText(copy.reasons[reason])).toBeTruthy()
      }
    }

    for (const evidence of snapshot.evidence) {
      expect(screen.getByText(evidence.content)).toBeTruthy()
      expect(screen.getByText(copy.epistemic[evidence.epistemic])).toBeTruthy()
    }

    expect(screen.getByText(copy.fileVersion('7'))).toBeTruthy()
    expect(screen.getByText(copy.memoryRevision('3'))).toBeTruthy()
    expect(globalThis.document.body.textContent).not.toContain('!synthetic:example.invalid')
    expect(globalThis.document.body.textContent).not.toContain('$synthetic-edit-2')
    expect(globalThis.document.body.textContent).not.toContain('00000000-0000')
    expect(globalThis.document.body.textContent).not.toContain(snapshot.scopeKey)
    expect(globalThis.document.querySelector('a')).toBeNull()
  })

  it('opens exact citations only on explicit user action, forwarding no invented URLs', async () => {
    const snapshot = awarenessFixture(Date.now())
    const open = vi.fn(async () => {})
    render(panel(snapshot, { onOpenCitation: open }))
    expect(open).not.toHaveBeenCalled()

    for (const [index, evidence] of snapshot.evidence.entries()) {
      fireEvent.click(screen.getAllByRole('button')[index]!)
      await waitFor(() =>
        expect(open).toHaveBeenCalledWith({
          scopeKey: snapshot.scopeKey,
          snapshotId: snapshot.snapshotId,
          evidenceId: evidence.evidenceId,
          citation: evidence.citation
        })
      )
    }
  })

  it('keeps unavailable distinct from an empty result and preserves coverage reasons', () => {
    const snapshot = { ...awarenessFixture(Date.now()), status: 'unavailable' as const }
    render(panel(snapshot))
    expect(screen.getByText(copy.unavailable)).toBeTruthy()
    expect(screen.getAllByText(copy.unavailableDescription)).toHaveLength(1)
    expect(screen.queryByText(copy.noEvidence)).toBeNull()
    expect(screen.getByText(copy.reasons.keys_missing)).toBeTruthy()
    expect(screen.queryByText(snapshot.evidence[0]!.content)).toBeNull()
  })

  it('labels empty coverage as not supplied, not as all sources disconnected', () => {
    const snapshot = { ...awarenessFixture(Date.now()), sources: [], evidence: [] }
    render(panel(snapshot))
    expect(screen.getByText(copy.noSourcesDescription)).toBeTruthy()
    expect(screen.getByText(copy.noEvidenceDescription)).toBeTruthy()
    expect(screen.queryByText(copy.unavailable)).toBeNull()
  })

  it('labels stale evidence as last known and disables citation opening', () => {
    const snapshot = { ...awarenessFixture(Date.now()), freshness: 'stale' as const }
    const open = vi.fn(async () => {})
    render(panel(snapshot, { onOpenCitation: open }))
    expect(screen.getByText(copy.stale)).toBeTruthy()
    expect(screen.getByText(snapshot.evidence[0]!.content)).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
    expect(open).not.toHaveBeenCalled()
  })

  it('evicts source labels and evidence immediately when the active account/profile/audience generation changes', () => {
    const snapshot = awarenessFixture(Date.now())
    const { rerender } = render(panel(snapshot))
    rerender(panel(snapshot, { currentScopeKey: 'new-scope' }))
    expect(screen.queryByText(snapshot.evidence[0]!.content)).toBeNull()
    expect(screen.queryByText('Launch notes')).toBeNull()
    expect(screen.getByText(copy.unavailable)).toBeTruthy()
    rerender(panel(snapshot, { currentScopeKey: null }))
    expect(screen.queryByText(snapshot.evidence[1]!.content)).toBeNull()
  })

  it('does not revive old scope errors when an in-flight citation fails after a replacement', async () => {
    const first = awarenessFixture(Date.now())
    let reject!: (error: Error) => void

    const open = vi.fn(
      () =>
        new Promise<void>((_resolve, failure) => {
          reject = failure
        })
    )

    const { rerender } = render(panel(first, { onOpenCitation: open }))
    fireEvent.click(screen.getAllByRole('button')[0]!)
    const next = { ...first, scopeKey: 'new-scope', snapshotId: 'new-snapshot', evidence: [] }
    rerender(panel(next, { onOpenCitation: open }))
    await act(async () => {
      reject(new Error('sensitive native error'))
      await Promise.resolve()
    })
    expect(screen.queryByText(copy.citationFailed)).toBeNull()
    expect(globalThis.document.body.textContent).not.toContain('sensitive native error')
  })

  it('shows a localized recoverable error without raw native details and guards double clicks', async () => {
    const snapshot = awarenessFixture(Date.now())
    let reject!: (error: Error) => void

    const open = vi.fn(
      () =>
        new Promise<void>((_resolve, failure) => {
          reject = failure
        })
    )

    render(panel(snapshot, { onOpenCitation: open }))
    const button = screen.getAllByRole('button')[0]!
    fireEvent.click(button)
    fireEvent.click(button)
    expect(open).toHaveBeenCalledTimes(1)
    await act(async () => {
      reject(new Error('native secret path'))
      await Promise.resolve()
    })
    expect(screen.getByRole('status').textContent).toBe(copy.citationFailed)
    expect(globalThis.document.body.textContent).not.toContain('native secret path')
    expect((button as HTMLButtonElement).disabled).toBe(false)
  })

  it('removes expired evidence on time without a new snapshot and retains current evidence', () => {
    vi.useFakeTimers()
    const now = Date.now()
    const snapshot = awarenessFixture(now)
    snapshot.evidence = [{ ...snapshot.evidence[0]!, expiresAt: now + 1000 }, snapshot.evidence[1]!]
    render(panel(snapshot))
    expect(screen.getByText(snapshot.evidence[0]!.content)).toBeTruthy()
    act(() => vi.advanceTimersByTime(1000))
    expect(screen.queryByText(snapshot.evidence[0]!.content)).toBeNull()
    expect(screen.getByText(snapshot.evidence[1]!.content)).toBeTruthy()
  })

  it('renders injection-like evidence as plain source text, never HTML or navigation', () => {
    const snapshot = awarenessFixture(Date.now())
    snapshot.evidence = [
      { ...snapshot.evidence[0]!, content: '<img src=x onerror=alert(1)> [publish](https://evil.invalid)' }
    ]
    render(panel(snapshot))
    const evidence = within(screen.getByRole('region', { name: copy.evidence }))
    expect(evidence.getByText(snapshot.evidence[0]!.content)).toBeTruthy()
    expect(globalThis.document.querySelector('img, a')).toBeNull()
  })
})
