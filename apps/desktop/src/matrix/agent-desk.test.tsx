import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider, type Locale } from '@/i18n'

import type {
  MatrixAgentView,
  MatrixHermesPrompt,
  MatrixMessage,
  MatrixRoom,
  MatrixSnapshot
} from '../../shared/matrix'
import { matrixAgentDeskCopy } from '../../shared/matrix-agent-desk-copy'
import type { MatrixReachMac } from '../../shared/matrix-agent-sources'

import {
  matrixAgentDeskAgent,
  matrixAgentDeskDevices,
  matrixAgentDeskMinutes,
  matrixAgentDeskNow,
  type MatrixAgentDeskNowInput
} from './agent-desk-model'
import { MatrixWorkbench } from './workbench'

const en = matrixAgentDeskCopy.en
const OWNER = '@owner:test'
const LUNA = '@luna:test'
const ROOM = '!luna:test'

const luna: MatrixAgentView = {
  principal: 'agent-luna',
  userId: LUNA,
  name: 'Luna',
  isDefault: false,
  ready: true,
  hermes: 'ready',
  atumModel: true,
  answering: 'cloud'
}

const lunaRoom: MatrixRoom = {
  id: ROOM,
  name: 'Luna',
  membership: 'join',
  encrypted: true,
  assistant: true,
  agentPrincipal: 'agent-luna'
}

function message(overrides: Partial<MatrixMessage> & Pick<MatrixMessage, 'id' | 'sender'>): MatrixMessage {
  return {
    body: '',
    timestamp: 1_000,
    own: overrides.sender === OWNER,
    encrypted: true,
    decryptionFailed: false,
    pending: false,
    failed: false,
    attachment: false,
    ...overrides
  }
}

/** The agent's working line (agent-turns/1.3 progress notice), as the chat shows it. */
function progressLine(body: string, kind: 'todo' | 'device' | 'heartbeat' = 'todo', device?: string): MatrixMessage {
  return message({
    id: '$line',
    sender: LUNA,
    body,
    notice: true,
    timestamp: 2_000,
    progress: {
      profile: 'atum.agent-turns/1.3',
      scope: 'owner_private',
      phase: 'working',
      kind,
      revision: 1,
      ...(device ? { device } : {})
    }
  })
}

const approval: MatrixHermesPrompt = {
  id: 'prompt-1',
  kind: 'approval',
  command: 'send quote.xlsx',
  description: '',
  allowOnce: true,
  deadlineAt: Date.now() + 10 * 60_000
}

const macBook: MatrixReachMac = { id: 'mac-1', name: 'MacBook Pro', thisMac: true, state: 'ready' }
const studio: MatrixReachMac = { id: 'mac-2', name: 'Mac Studio', thisMac: false, state: 'offline' }

function base(): MatrixSnapshot {
  return {
    state: 'ready',
    identity: { userId: OWNER, deviceId: 'DEVICE' },
    assistant: { userId: LUNA, deviceId: 'LUNA' },
    roomId: ROOM,
    rooms: [lunaRoom],
    agents: [luna],
    messages: [],
    error: null,
    linkedDocument: null
  }
}

function nowInput(overrides: Partial<MatrixAgentDeskNowInput> = {}): MatrixAgentDeskNowInput {
  return { roomId: ROOM, agentId: LUNA, messages: [], ...overrides }
}

describe('the desk model', () => {
  it('is Free when nothing in the chat says it is working', () => {
    expect(matrixAgentDeskNow(nowInput())).toEqual({ state: 'free' })
  })

  it('is Working from typing, with the working line as its line and steps', () => {
    expect(matrixAgentDeskNow(nowInput({ typing: [LUNA] })).state).toBe('working')

    const now = matrixAgentDeskNow(
      nowInput({ messages: [progressLine('Ordering 40 boxes\n✓ Opened Shopee\n• Filling the order form')] })
    )

    expect(now).toEqual({
      state: 'working',
      since: 2_000,
      line: 'Ordering 40 boxes',
      steps: [
        { done: true, text: 'Opened Shopee' },
        { done: false, text: 'Filling the order form' }
      ]
    })
  })

  it('leaves a heartbeat out of the line: the head already says how long', () => {
    const now = matrixAgentDeskNow(nowInput({ messages: [progressLine('Still working · 4 minutes', 'heartbeat')] }))

    expect(now).toMatchObject({ state: 'working', steps: [] })
    expect(now).not.toHaveProperty('line')
  })

  it('dates Working from the question Stop names', () => {
    const ask = message({ id: '$ask', sender: OWNER, body: 'Order boxes', timestamp: 500 })

    expect(matrixAgentDeskNow(nowInput({ messages: [ask], typing: [LUNA], stopTarget: '$ask' }))).toMatchObject({
      state: 'working',
      since: 500
    })
  })

  it('is Waiting for you while it has an open ask, whatever else it does', () => {
    expect(matrixAgentDeskNow(nowInput({ typing: [LUNA], prompts: [approval] }))).toMatchObject({
      state: 'waiting',
      prompts: [approval]
    })
  })

  it('is On your device when its working line names a device, or its shell is open here', () => {
    expect(
      matrixAgentDeskNow(nowInput({ messages: [progressLine('Getting the invoice', 'device', 'MacBook Pro')] }))
    ).toMatchObject({ state: 'device', device: 'MacBook Pro', line: 'Getting the invoice' })

    const shell = matrixAgentDeskNow(nowInput({ typing: [LUNA], terminalOpen: true }))
    expect(shell.state).toBe('device')
    expect(shell).not.toHaveProperty('device')
    // An open shell alone, with nothing running, is not work.
    expect(matrixAgentDeskNow(nowInput({ terminalOpen: true })).state).toBe('free')
  })

  it('counts whole minutes, and nothing under one', () => {
    expect(matrixAgentDeskMinutes(0, 59_000)).toBeUndefined()
    expect(matrixAgentDeskMinutes(0, 4 * 60_000 + 5_000)).toBe(4)
    expect(matrixAgentDeskMinutes(undefined, 10)).toBeUndefined()
  })

  it('lifts the device in use to the top and keeps this Mac before the others', () => {
    const atRest = matrixAgentDeskDevices([studio, macBook], { state: 'free' })
    expect(atRest.map(each => [each.mac.name, each.inUse])).toEqual([
      ['MacBook Pro', false],
      ['Mac Studio', false]
    ])

    const busy = matrixAgentDeskDevices([macBook, studio], { state: 'device', device: 'Mac Studio', steps: [] })
    expect(busy.map(each => [each.mac.name, each.inUse])).toEqual([
      ['Mac Studio', true],
      ['MacBook Pro', false]
    ])

    // An unnamed device is this Mac (its shell is what said so).
    expect(matrixAgentDeskDevices([studio, macBook], { state: 'device', steps: [] })[0]).toEqual({
      mac: macBook,
      inUse: true
    })
  })

  it('finds the desk only in the owner’s own 1:1 chat with an agent', () => {
    const snapshot = base()
    expect(matrixAgentDeskAgent(snapshot, lunaRoom)).toBe(luna)
    expect(matrixAgentDeskAgent(snapshot, { ...lunaRoom, assistant: false })).toBeUndefined()

    expect(
      matrixAgentDeskAgent(snapshot, { ...lunaRoom, companyChannel: { companyId: 'c', channelId: 'ch' } })
    ).toBeUndefined()

    expect(matrixAgentDeskAgent(snapshot, undefined)).toBeUndefined()
  })
})

const stopTurn = vi.fn(async () => ({ state: 'stopped' }))
const respondHermes = vi.fn(async () => {})
const cancelHermes = vi.fn(async () => {})

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  Object.assign(window, {
    atumMatrix: {
      command: vi.fn(async () => {}),
      previewDocument: vi.fn(),
      closeDocumentPreview: vi.fn(async () => {}),
      openLink: vi.fn(async () => {}),
      cloudAgent: stopTurn,
      respondHermes,
      cancelHermes
    }
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(window, 'atumMatrix')
  Reflect.deleteProperty(window, 'atumDevice')
})

function panel(snapshot: MatrixSnapshot, locale: Locale = 'en') {
  return (
    <I18nProvider configClient={null} initialLocale={locale}>
      <MatrixWorkbench
        compact={false}
        expanded={false}
        hidden={false}
        motion={{ phase: 'open', rendered: true, finishExit() {} }}
        obstructed={false}
        onClose={() => {}}
        onExpand={() => {}}
        onPercentChange={() => {}}
        percent={50}
        snapshot={snapshot}
        windowControls={null}
      />
    </I18nProvider>
  )
}

function reachMacs(macs: MatrixReachMac[]) {
  Object.assign(window.atumMatrix, {
    agentSources: { read: vi.fn(async () => ({ gates: {}, sources: [], macs })) }
  })
}

describe('the agent tab', () => {
  it('opens on the agent’s own pinned tab, first, with its name; a plain chat keeps the new tab', () => {
    const { unmount } = render(panel(base()))
    const tabs = screen.getAllByRole('tab')
    expect(tabs[0]?.textContent).toContain('Luna')
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true')
    // Pinned: no close button on it.
    expect(within(tabs[0]!.parentElement!).queryByRole('button', { name: /close/i })).toBeNull()
    expect(screen.getByRole('region', { name: en.desk('Luna') })).toBeTruthy()
    unmount()

    render(panel({ ...base(), rooms: [{ ...lunaRoom, assistant: false, agentPrincipal: undefined }] }))
    expect(screen.queryByRole('region', { name: en.desk('Luna') })).toBeNull()
  })

  it('shows Free and nothing else when the agent has no files, devices or memory to show', async () => {
    render(panel(base()))
    const desk = screen.getByRole('region', { name: en.desk('Luna') })
    expect(desk.querySelector('[data-agent-desk-now="free"]')?.textContent).toBe(en.free)
    await act(async () => {})
    expect(within(desk).queryByText(en.devices)).toBeNull()
    expect(within(desk).queryByText(en.files)).toBeNull()
    expect(desk.querySelector('[data-agent-desk-memory]')).toBeNull()
    expect(within(desk).queryByRole('button', { name: en.stop })).toBeNull()
  })

  it('Stop while working asks the cloud to stop the turn that answers the open question', async () => {
    const ask = message({ id: '$ask', sender: OWNER, body: 'Order 40 boxes', timestamp: Date.now() - 4 * 60_000 })

    render(
      panel({
        ...base(),
        messages: [ask, progressLine('Ordering 40 boxes\n✓ Opened Shopee\n• Filling the form')],
        typing: [LUNA]
      })
    )

    const desk = screen.getByRole('region', { name: en.desk('Luna') })
    expect(within(desk).getByRole('status').textContent).toBe(`${en.working} · ${en.minutes(4)}`)
    expect(within(desk).getByText('Ordering 40 boxes')).toBeTruthy()
    expect(within(desk).getByText('Filling the form')).toBeTruthy()
    // The cloud queues a new message behind the turn: the desk says so, not "type to change it".
    expect(within(desk).getByText(en.queueHint)).toBeTruthy()

    fireEvent.click(within(desk).getByRole('button', { name: en.stop }))
    expect(stopTurn).toHaveBeenCalledWith({ action: 'stopTurn', roomId: ROOM, eventId: '$ask' })
    await waitFor(() =>
      expect((within(desk).getByRole('button', { name: en.stop }) as HTMLButtonElement).disabled).toBe(true)
    )
  })

  it('says a message steers the run when the agent runs here, and Stop cancels that run', () => {
    render(
      panel({
        ...base(),
        agents: [{ ...luna, answering: undefined }],
        hermesActivity: { roomId: ROOM, invocationId: 'inv', state: 'running', text: '', tools: [] }
      })
    )

    const desk = screen.getByRole('region', { name: en.desk('Luna') })
    expect(within(desk).getByText(en.steerHint)).toBeTruthy()
    fireEvent.click(within(desk).getByRole('button', { name: en.stop }))
    expect(cancelHermes).toHaveBeenCalledWith(ROOM)
    expect(stopTurn).not.toHaveBeenCalled()
  })

  it('Waiting for you shows the chat’s own ask with its buttons, and answering it answers the ask', async () => {
    render(panel({ ...base(), typing: [LUNA], agentTurns: [{ roomId: ROOM, prompts: [approval] }] }))
    const desk = screen.getByRole('region', { name: en.desk('Luna') })
    expect(desk.querySelector('[data-agent-desk-now="waiting"]')).toBeTruthy()
    expect(within(desk).getByRole('heading', { name: en.ask('Luna') })).toBeTruthy()

    await act(async () => {
      fireEvent.click(within(desk).getByRole('button', { name: 'Allow' }))
    })

    expect(respondHermes).toHaveBeenCalledWith({ id: 'prompt-1', kind: 'approval', choice: 'once' })
  })

  it('On your device lifts that device under Now with a Stop that also stops this Mac’s device host', async () => {
    const deviceStop = vi.fn(async () => ({ stopped: true }))
    Object.assign(window, { atumDevice: { status: vi.fn(async () => ({ active: true })), stop: deviceStop } })
    reachMacs([studio, macBook])
    const ask = message({ id: '$ask', sender: OWNER, body: 'Get the invoice', timestamp: Date.now() })

    render(
      panel({
        ...base(),
        messages: [ask, progressLine('Getting the invoice', 'device', 'MacBook Pro')],
        typing: [LUNA]
      })
    )

    const desk = screen.getByRole('region', { name: en.desk('Luna') })
    expect(within(desk).getByRole('status').textContent).toBe(en.onDevice('MacBook Pro'))

    const inUse = await waitFor(() => {
      const row = desk.querySelector<HTMLElement>('[data-agent-desk-device="in-use"]')
      expect(row).toBeTruthy()

      return row!
    })

    expect(inUse.textContent).toContain('MacBook Pro')
    expect(inUse.textContent).toContain(en.usingNow)

    // The whole section rises right under Now, the device in use first, the rest after it.
    const sections = [...desk.querySelectorAll('[data-agent-desk-now], [data-agent-desk-devices]')]
    expect(sections).toHaveLength(2)
    const rows = [...sections[1]!.querySelectorAll('[data-agent-desk-device]')]
    expect(rows[0]).toBe(inUse)
    expect(rows[1]?.textContent).toContain('Mac Studio')
    expect(within(desk).getAllByText(en.devices)).toHaveLength(1)

    await act(async () => {
      fireEvent.click(within(inUse).getByRole('button', { name: en.stop }))
    })

    expect(stopTurn).toHaveBeenCalledWith({ action: 'stopTurn', roomId: ROOM, eventId: '$ask' })
    await waitFor(() => expect(deviceStop).toHaveBeenCalledTimes(1))
  })

  it('leaves this Mac’s device host alone when it is not in use', async () => {
    const deviceStop = vi.fn(async () => ({ stopped: true }))
    Object.assign(window, { atumDevice: { status: vi.fn(async () => ({ active: false })), stop: deviceStop } })
    const ask = message({ id: '$ask', sender: OWNER, body: 'Get the invoice', timestamp: Date.now() })

    render(panel({ ...base(), messages: [ask, progressLine('Getting it', 'device', 'MacBook Pro')], typing: [LUNA] }))

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: en.stop }))
    })

    expect(stopTurn).toHaveBeenCalledTimes(1)
    expect(deviceStop).not.toHaveBeenCalled()
  })

  it('lists the devices at rest with their state word and no Stop', async () => {
    reachMacs([studio, macBook])
    render(panel(base()))
    const desk = screen.getByRole('region', { name: en.desk('Luna') })

    const rows = await waitFor(() => {
      const found = desk.querySelectorAll('[data-agent-desk-device]')
      expect(found).toHaveLength(2)

      return found
    })

    expect(rows[0]?.textContent).toContain('MacBook Pro')
    expect(rows[1]?.getAttribute('data-agent-desk-device')).toBe('offline')
    expect(within(desk).queryByRole('button', { name: en.stop })).toBeNull()
  })

  it('says it in Vietnamese', () => {
    render(panel({ ...base(), typing: [LUNA] }, 'vi'))
    const vi_ = matrixAgentDeskCopy.vi
    const desk = screen.getByRole('region', { name: vi_.desk('Luna') })
    expect(within(desk).getByRole('status').textContent).toBe(vi_.working)
    expect(within(desk).getByText(vi_.queueHint)).toBeTruthy()
  })
})
