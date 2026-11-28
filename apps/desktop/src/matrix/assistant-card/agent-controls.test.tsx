import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixAgentView, MatrixRoom, MatrixUiBridge } from '../../../shared/matrix'
import { matrixAgentDeskCopy } from '../../../shared/matrix-agent-desk-copy'
import { MatrixAgentDeskFiles, type MatrixAgentDeskState } from '../agent-desk'

import { useAssistantCardControls } from './agent-controls'

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

/** The card's slots in the order the card places them: the Paused notice, then each row. */
function Controls({ agent }: { agent: MatrixAgentView }) {
  const slots = useAssistantCardControls({ active: true, agent, desk, room })

  return (
    <>
      {slots.paused}
      {slots.notifications}
      {slots.devices}
      {slots.pause}
      <span data-routines-paused={slots.routinesPaused ? 'yes' : 'no'} />
    </>
  )
}

function show(agent: MatrixAgentView = luna) {
  return render(
    <I18nProvider configClient={null} initialLocale="en">
      <Controls agent={agent} />
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
  it('keeps Pause with nothing to pause, saying so in its tooltip, with the switch waiting', async () => {
    hostDesk({ schedule: [schedule([])], files: [files([])] })
    show()

    await waitFor(() => expect(pauseRow()?.dataset.assistantCardPause).toBe('empty'))
    // Not a line in the row (revamp 2026-11-28: one line only for a failure); the tooltip says it.
    expect(within(pauseRow()!).queryByText(en.nothingScheduled)).toBeNull()
    expect(pauseRow()!.title).toContain(en.nothingScheduled)
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

describe('Paused: one notice under the header, with Resume', () => {
  const paused = { ...job, state: 'paused', pausedReason: 'owner_pause' }

  it('shows the notice only while its routines are paused, and Resume resumes them', async () => {
    const { control } = hostDesk({ schedule: [schedule([paused])], files: [files([])] })
    show()

    const notice = await waitFor(() => {
      const found = window.document.querySelector<HTMLElement>('[data-assistant-card-paused]')
      expect(found).toBeTruthy()

      return found!
    })

    expect(within(notice).getByText('Paused')).toBeTruthy()
    expect(within(notice).getByText(en.pauseHint)).toBeTruthy()
    expect(window.document.querySelector('[data-routines-paused]')?.getAttribute('data-routines-paused')).toBe('yes')

    await act(async () => {
      fireEvent.click(within(notice).getByRole('button', { name: 'Resume' }))
    })

    expect(control).toHaveBeenCalledWith('agent-luna', { action: 'resume' })
    await waitFor(() => expect(window.document.querySelector('[data-assistant-card-paused]')).toBeNull())
    expect(pauseRow()?.dataset.assistantCardPause).toBe('running')
  })

  it('shows no notice while its routines run', async () => {
    hostDesk({ schedule: [schedule([job])], files: [files([])] })
    show()

    await waitFor(() => expect(pauseRow()?.dataset.assistantCardPause).toBe('running'))
    expect(window.document.querySelector('[data-assistant-card-paused]')).toBeNull()
  })
})

describe('Files on the card: the newest three, then Show all files', () => {
  const now = Date.now()

  const sentFile = (id: string, body: string, minutesAgo: number) =>
    ({ id, body, timestamp: now - minutesAgo * 60_000, attachmentSize: 2_000 }) as unknown as MatrixAgentDeskState['sent'][number]

  const withSent = {
    devices: [],
    sent: [sentFile('$a', 'Weekly plan.docx', 5), sentFile('$b', 'Meeting notes.pdf', 60)]
  } as unknown as MatrixAgentDeskState

  function showFiles() {
    return render(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixAgentDeskFiles active agent={luna} desk={withSent} roomId={room.id} />
      </I18nProvider>
    )
  }

  const rows = [
    { name: 'Reports', kind: 'folder', size: 0, modifiedAt: now - 30 * 60_000 },
    { name: 'old.csv', kind: 'file', size: 10, modifiedAt: now - 3 * 86_400_000 }
  ]

  it('mixes what it sent and what is on its computer, newest first, three at most', async () => {
    hostDesk({ files: [files(rows)] })
    showFiles()

    const list = await waitFor(() => {
      const found = window.document.querySelector<HTMLElement>('[data-agent-card-files]')
      expect(found?.querySelectorAll('.ak-row').length).toBe(4)

      return found!
    })

    const names = [...list.querySelectorAll('.ak-row .truncate')].map(each => each.textContent)
    expect(names).toEqual(['Weekly plan.docx', 'Reports', 'Meeting notes.pdf', 'Show all files'])
    expect(within(list).getAllByText(/^Sent here · /)).toHaveLength(2)
    expect(within(list).getByText('On its computer')).toBeTruthy()
    expect(screen.queryByText('old.csv')).toBeNull()
  })

  it('saves a sent file from its row', async () => {
    hostDesk({ files: [files(rows)] })
    showFiles()

    fireEvent.click(await screen.findByRole('button', { name: en.save('Weekly plan.docx') }))
    expect(window.atumMatrix.command).toHaveBeenCalledWith({ kind: 'download', roomId: room.id, eventId: '$a' })
  })

  it('opens the full lists in place, with Save and folders, and Show less folds them back', async () => {
    hostDesk({ files: [files(rows), files(rows)] })
    showFiles()

    fireEvent.click(await waitFor(() => screen.getByText('Show all files')))
    expect(await screen.findByText('old.csv')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /^Save / }).length).toBe(2)

    fireEvent.click(screen.getByText(en.less))
    await waitFor(() => expect(screen.queryByText('old.csv')).toBeNull())
    expect(screen.getByText('Show all files')).toBeTruthy()
  })

  it('opens a folder from the short list into the full one', async () => {
    const { read } = hostDesk({ files: [files(rows), files([{ name: 'q4.xlsx', kind: 'file', size: 10, modifiedAt: now }])] })
    showFiles()

    fireEvent.click(await screen.findByRole('button', { name: 'Reports' }))
    await waitFor(() =>
      expect(read).toHaveBeenLastCalledWith('agent-luna', { read: 'files', path: 'home/Reports' })
    )
  })
})
