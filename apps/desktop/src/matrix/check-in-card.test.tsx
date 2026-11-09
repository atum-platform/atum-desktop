import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixSnapshot, MatrixUiBridge } from '../../shared/matrix'
import {
  defaultMatrixCheckInSettings,
  emptyMatrixCheckInLedger,
  matrixCheckInCost,
  type MatrixCheckInNudge,
  type MatrixCheckInsSnapshot
} from '../../shared/matrix-check-ins'

import { MatrixCheckInCard, MatrixCheckInsNotice, matrixCheckInsNotice } from './check-in-card'
import { matrixCheckInClock, matrixCheckInsCopy } from './check-ins-copy'

const identity = { userId: '@alice:test', deviceId: 'ONE' }
const copy = matrixCheckInsCopy.en

const nudge: MatrixCheckInNudge = {
  kind: 'deadline',
  key: 'quote-lan',
  text: "Lan's quote is due at 5 pm today. Want me to draft the email to her?",
  source: 'files',
  ref: 'quote-lan.md',
  action: 'draft'
}

function records(change: Partial<MatrixCheckInsSnapshot> = {}): MatrixCheckInsSnapshot {
  return {
    settings: { ...defaultMatrixCheckInSettings(), introducedAt: 1 },
    feedback: { muted: [], snoozed: [], ackAt: 0 },
    ledger: emptyMatrixCheckInLedger(),
    writable: true,
    ...change
  }
}

function snapshot(checkIns: MatrixCheckInsSnapshot = records(), extra: Partial<MatrixSnapshot> = {}): MatrixSnapshot {
  return { state: 'ready', identity, error: null, rooms: [], roomId: null, messages: [], checkIns, ...extra }
}

function bridge(current: MatrixSnapshot = snapshot()) {
  const command = vi.fn(async () => null)

  window.atumMatrix = {
    command,
    snapshot: async () => current,
    subscribe: () => () => {}
  } as unknown as MatrixUiBridge

  return command
}

const wrap = (node: React.ReactNode) => (
  <StrictMode>
    <I18nProvider configClient={null} initialLocale="en">
      {node}
    </I18nProvider>
  </StrictMode>
)

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'atumMatrix')
})

describe('a check-in in the chat', () => {
  it('shows its line, where it came from, and one offer that asks the assistant as the owner', async () => {
    bridge()
    const onAct = vi.fn()
    render(wrap(<MatrixCheckInCard nudge={nudge} onAct={onAct} />))

    expect(screen.getByRole('group', { name: copy.cardLabel }).textContent).toContain(nudge.text)
    expect(screen.getByText('Files · quote-lan.md')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Draft it' }))
    expect(onAct).toHaveBeenCalledWith(`Draft this for me: ${nudge.text}`)
  })

  it('cannot act while the assistant cannot answer', () => {
    bridge()
    render(wrap(<MatrixCheckInCard nudge={nudge} />))

    expect((screen.getByRole('button', { name: 'Draft it' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('takes "Less like this" and "Snooze" as answers, and says what will happen', async () => {
    const command = bridge()
    render(wrap(<MatrixCheckInCard nudge={nudge} onAct={() => {}} />))
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Less like this' }) as HTMLButtonElement).disabled).toBe(false)
    )

    fireEvent.click(screen.getByRole('button', { name: 'Less like this' }))
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith({
        kind: 'checkInsFeedback',
        identity,
        feedback: { kind: 'less', nudge: 'deadline' }
      })
    )
    await screen.findByText(copy.lessDone)

    cleanup()
    const again = bridge()
    render(wrap(<MatrixCheckInCard nudge={nudge} onAct={() => {}} />))
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Snooze' }) as HTMLButtonElement).disabled).toBe(false)
    )
    fireEvent.click(screen.getByRole('button', { name: 'Snooze' }))
    await waitFor(() => expect(again).toHaveBeenCalledTimes(1))

    const [{ feedback }] = again.mock.calls[0] as unknown as [
      { feedback: { kind: string; until: number; nudge: MatrixCheckInNudge } }
    ]
    expect(feedback.kind).toBe('snooze')
    expect(feedback.nudge).toEqual(nudge)
    expect(feedback.until).toBeGreaterThan(Date.now())
    await screen.findByRole('status')
  })

  it('turns the morning brief off when the brief itself is not wanted', async () => {
    const command = bridge()
    render(
      wrap(<MatrixCheckInCard nudge={{ ...nudge, kind: 'brief', key: 'brief-1', action: 'review' }} onAct={() => {}} />)
    )
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Less like this' }) as HTMLButtonElement).disabled).toBe(false)
    )

    fireEvent.click(screen.getByRole('button', { name: 'Less like this' }))
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith({
        kind: 'checkInsChange',
        identity,
        change: { field: 'brief', value: null }
      })
    )
  })

  it('says when a snoozed item comes back, and offers its buttons again on the post that brought it back', async () => {
    const until = Date.now() - 60_000
    bridge(snapshot(records({ feedback: { muted: [], snoozed: [{ key: nudge.key, until, nudge }], ackAt: 0 } })))

    render(wrap(<MatrixCheckInCard nudge={nudge} onAct={() => {}} postedAt={until - 3 * 60 * 60_000} />))
    await screen.findByText(copy.snoozed(matrixCheckInClock(until, 'en')))
    expect(screen.queryByRole('button', { name: 'Draft it' })).toBeNull()

    cleanup()
    render(wrap(<MatrixCheckInCard nudge={nudge} onAct={() => {}} postedAt={until + 30_000} />))
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Snooze' }) as HTMLButtonElement).disabled).toBe(false)
    )
    expect(screen.getByRole('button', { name: 'Draft it' })).toBeTruthy()
  })

  it('remembers an earlier answer from the synced records, on any device', async () => {
    bridge(snapshot(records({ feedback: { muted: ['deadline'], snoozed: [], ackAt: 5 } })))
    render(wrap(<MatrixCheckInCard nudge={nudge} onAct={() => {}} />))

    await screen.findByText(copy.lessDone)
    expect(screen.queryByRole('button', { name: 'Draft it' })).toBeNull()
  })
})

describe("the assistant's chat, above the message box", () => {
  it('mentions check-ins once, with the brief time and the cost, and closing it is remembered', async () => {
    const command = bridge()
    const fresh = records({ settings: defaultMatrixCheckInSettings() })
    render(wrap(<MatrixCheckInsNotice onOpenSettings={() => {}} snapshot={snapshot(fresh)} />))

    const cost = matrixCheckInCost()
    expect(screen.getByText(copy.intro('8:00 AM'))).toBeTruthy()
    expect(screen.getByText(copy.cost(String(cost.perDay), cost.atMost.toLocaleString('en')))).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: copy.introDismiss }))
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith({ kind: 'checkInsChange', identity, change: { field: 'introduced' } })
    )
  })

  it('waits with the first mention until the assistant has spoken in the chat', () => {
    bridge()
    const fresh = records({ settings: defaultMatrixCheckInSettings() })
    render(wrap(<MatrixCheckInsNotice introReady={false} snapshot={snapshot(fresh)} />))

    expect(screen.queryByText(copy.intro('8:00 AM'))).toBeNull()
  })

  it('asks "Keep these coming?" after unanswered nudges, and keeping them is an answer', async () => {
    const command = bridge()
    const asking = records({
      ledger: { ...emptyMatrixCheckInLedger(), ignored: 5, lastNudgeAt: 10 },
      feedback: { muted: [], snoozed: [], ackAt: 1 }
    })
    render(wrap(<MatrixCheckInsNotice snapshot={snapshot(asking)} />))

    fireEvent.click(screen.getByRole('button', { name: copy.askKeep }))
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith({ kind: 'checkInsFeedback', identity, feedback: { kind: 'ack' } })
    )
  })

  it('confirms "stop checking in", with the way back', async () => {
    const command = bridge()
    const off = records({
      settings: { enabled: false, brief: '08:00', offAt: Date.now() - 1000, offBy: 'asked', introducedAt: 1 }
    })
    render(wrap(<MatrixCheckInsNotice snapshot={snapshot(off)} />))

    expect(screen.getByText(copy.offNotice)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: copy.turnOn }))
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith({
        kind: 'checkInsChange',
        identity,
        change: { field: 'enabled', value: true }
      })
    )
  })

  it('shows one line at a time, and nothing once everything is said', () => {
    const now = Date.now()

    expect(matrixCheckInsNotice(records(), now)).toBeNull()
    expect(matrixCheckInsNotice(records({ settings: defaultMatrixCheckInSettings() }), now)).toBe('intro')
    // Asking wins over the first mention.
    expect(
      matrixCheckInsNotice(
        records({
          settings: defaultMatrixCheckInSettings(),
          ledger: { ...emptyMatrixCheckInLedger(), ignored: 5, lastNudgeAt: 2 }
        }),
        now
      )
    ).toBe('asking')
    // Turned off in Settings is not news; turned off by asking is, for a day.
    expect(
      matrixCheckInsNotice(records({ settings: { enabled: false, brief: null, offAt: now, offBy: 'settings' } }), now)
    ).toBeNull()
    expect(
      matrixCheckInsNotice(
        records({ settings: { enabled: false, brief: null, offAt: now - 2 * 86_400_000, offBy: 'asked' } }),
        now
      )
    ).toBeNull()
    expect(matrixCheckInsNotice(records({ writable: false, settings: defaultMatrixCheckInSettings() }), now)).toBeNull()
  })
})
