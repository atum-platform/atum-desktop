import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixAgentView, MatrixRoom, MatrixUiBridge } from '../../../shared/matrix'
import { matrixAgentDeskCopy } from '../../../shared/matrix-agent-desk-copy'
import { MatrixAgentDeskFiles, type MatrixAgentDeskState } from '../agent-desk'

import { AssistantCardControls } from './agent-controls'

const en = matrixAgentDeskCopy.en

const luna: MatrixAgentView = {
  principal: 'agent-luna',
  userId: '@luna:test',
  name: 'Luna',
  isDefault: false,
  ready: true,
  hermes: 'ready',
  atumModel: true,
  answering: 'cloud',
  runtime: 'hermes'
}

const room: MatrixRoom = { id: '!luna:test', name: 'Luna', membership: 'join', encrypted: true, assistant: true, agentPrincipal: 'agent-luna' }
const desk = { devices: [], sent: [] } as unknown as MatrixAgentDeskState

const job = { id: 'brief', name: 'Morning brief', kind: 'cron', display: '0 8 * * *', timezone: null, state: 'scheduled', nextRunAt: null, lastRunAt: null, lastStatus: null, expr: null, minutes: null, runAt: null, pausedReason: null }
const schedule = (jobs: unknown[]) => ({ read: 'schedule', observedAt: 1, jobs, truncated: false })
const files = (rows: unknown[]) => ({ read: 'files', root: 'home', path: '', rows, truncated: false })

type Answer = unknown | Error

/** The host desk route: each read takes the next answer in its queue (an Error rejects). */
function hostDesk(answers: { schedule?: Answer[]; files?: Answer[] }) {
  const read = vi.fn(async (_principal: string, request: { read: 'schedule' | 'files' }) => {
    const answer = answers[request.read]?.shift()

    if (answer === undefined || answer instanceof Error) {
      throw answer ?? new Error('matrix_host_desk_refused')
    }

    return answer
  })

  const control = vi.fn(async () => ({ action: 'pause', changed: 1 }))
  window.atumMatrix = { command: vi.fn(async () => null), agentDesk: { read, control } } as unknown as MatrixUiBridge

  return { control, read }
}

function show(agent: MatrixAgentView = luna) {
  return render(
    <I18nProvider configClient={null} initialLocale="en">
      <AssistantCardControls active agent={agent} desk={desk} room={room} />
      <MatrixAgentDeskFiles active agent={agent} desk={desk} roomId={room.id} />
    </I18nProvider>
  )
}

const pauseRow = () => window.document.querySelector<HTMLElement>('[data-assistant-card-pause]')

beforeEach(() => {
  window.atumMatrix = { command: vi.fn(async () => null) } as unknown as MatrixUiBridge
})

afterEach(() => cleanup())

// Owner 2026-11-27: "agent card don't see pause and files". Both were hidden while a cloud agent had no
// routine and no file yet, and when a read failed, so the panel looked like it had lost them.
describe('the agent panel keeps Pause and Files for a cloud agent the host serves', () => {
  it('keeps Pause with nothing to pause, saying so, with the switch waiting', async () => {
    hostDesk({ schedule: [schedule([])], files: [files([])] })
    show()

    await waitFor(() => expect(pauseRow()?.dataset.assistantCardPause).toBe('empty'))
    expect(within(pauseRow()!).getByText(en.nothingScheduled)).toBeTruthy()
    expect(within(pauseRow()!).getByRole('switch', { name: en.pause }).hasAttribute('disabled')).toBe(true)
  })

  it('says when its schedule could not be read, reads again on Try again, then pauses for real', async () => {
    const { control, read } = hostDesk({ schedule: [new Error('matrix_host_desk_refused'), schedule([job])], files: [files([])] })
    show()

    await waitFor(() => expect(pauseRow()?.dataset.assistantCardPause).toBe('failed'))
    expect(within(pauseRow()!).getByText(en.scheduleUnavailable)).toBeTruthy()

    await act(async () => {
      fireEvent.click(within(pauseRow()!).getByRole('button', { name: en.tryAgain }))
    })

    await waitFor(() => expect(pauseRow()?.dataset.assistantCardPause).toBe('running'))
    expect(read.mock.calls.filter(([, request]) => request.read === 'schedule')).toHaveLength(2)

    await act(async () => {
      fireEvent.click(within(pauseRow()!).getByRole('switch', { name: en.pause }))
    })

    expect(control).toHaveBeenCalledWith('agent-luna', { action: 'pause' })
    expect(pauseRow()?.dataset.assistantCardPause).toBe('paused')
  })

  it('keeps Files with nothing in it, saying so', async () => {
    hostDesk({ schedule: [schedule([])], files: [files([])] })
    show()

    const section = await waitFor(() => {
      const found = window.document.querySelector<HTMLElement>('[data-agent-desk-files]')
      expect(found?.dataset.agentDeskFiles).toBe('ready')

      return found!
    })

    expect(within(section).getByRole('heading', { name: en.files })).toBeTruthy()
    expect(within(section).getByText(en.noFiles)).toBeTruthy()
  })

  it('says when its files could not be read, and lists them after Try again', async () => {
    hostDesk({
      schedule: [schedule([])],
      files: [new Error('matrix_host_desk_refused'), files([{ name: 'notes.md', kind: 'file', size: 900, modifiedAt: 1 }])]
    })
    show()

    const section = await waitFor(() => {
      const found = window.document.querySelector<HTMLElement>('[data-agent-desk-files]')
      expect(found?.dataset.agentDeskFiles).toBe('failed')

      return found!
    })

    expect(within(section).getByText(en.filesUnavailable)).toBeTruthy()

    await act(async () => {
      fireEvent.click(within(section).getByRole('button', { name: en.tryAgain }))
    })

    await waitFor(() => expect(screen.getByText('notes.md')).toBeTruthy())
    expect(screen.queryByText(en.filesUnavailable)).toBeNull()
  })

  it('shows neither for an agent the host does not serve, since neither could do anything', () => {
    hostDesk({ schedule: [schedule([job])], files: [files([])] })
    show({ ...luna, runtime: undefined })

    expect(pauseRow()).toBeNull()
    expect(window.document.querySelector('[data-agent-desk-files]')).toBeNull()
  })
})
