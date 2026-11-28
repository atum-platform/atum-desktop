import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixAgentView, MatrixRoom, MatrixSnapshot } from '../../../shared/matrix'
import { matrixAgentScreenText } from '../../../shared/matrix-agent-screen-copy'
import { MatrixWorkbench } from '../workbench'

import { $matrixScreenContinue } from './continue'
import { mockAgentScreenTransport } from './transport'

const copy = matrixAgentScreenText('en')
const ROOM = '!luna:test'

const luna: MatrixAgentView = {
  principal: 'agent-luna',
  userId: '@luna:test',
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

const snapshot: MatrixSnapshot = {
  state: 'ready',
  identity: { userId: '@owner:test', deviceId: 'DEVICE' },
  assistant: { userId: '@luna:test', deviceId: 'LUNA' },
  roomId: ROOM,
  rooms: [lunaRoom],
  agents: [luna],
  messages: [],
  error: null,
  linkedDocument: null
}

beforeEach(() => {
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
      openLink: vi.fn(async () => {})
    }
  })
  $matrixScreenContinue.set(null)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(window, 'atumMatrix')
})

function panel(screenRequest?: number) {
  return (
    <I18nProvider configClient={null} initialLocale="en">
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
        screenRequest={screenRequest}
        snapshot={snapshot}
        windowControls={null}
      />
    </I18nProvider>
  )
}

const screenTab = () => screen.queryAllByRole('tab').find(tab => tab.textContent?.includes(copy.tab))

describe('the Screen tab', () => {
  it('never appears where this build cannot reach the agent’s screen', () => {
    const view = render(panel())
    view.rerender(panel(1))

    expect(screenTab()).toBeUndefined()
  })

  it('opens beside the agent’s tab on request and hands back the carry-on to its chat', async () => {
    const transport = mockAgentScreenTransport()
    Object.assign(window.atumMatrix, { agentScreen: transport })

    const view = render(panel())
    expect(screenTab()).toBeUndefined()

    view.rerender(panel(1))
    await waitFor(() => expect(screenTab()?.getAttribute('aria-selected')).toBe('true'))

    const tabs = screen.getAllByRole('tab')
    expect(tabs[0]?.textContent).toContain('Luna')
    expect(tabs[1]).toBe(screenTab())

    const takeOver = await screen.findByRole('button', { name: copy.takeOver })
    await waitFor(() => expect((takeOver as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(takeOver)
    fireEvent.click(await screen.findByRole('button', { name: copy.handBackContinue }))

    await waitFor(() => expect($matrixScreenContinue.get()).toMatchObject({ roomId: ROOM, text: copy.continueMessage }))
  })

  it('closing the tab (which hands back on the stream) never writes a message', async () => {
    const transport = mockAgentScreenTransport()
    Object.assign(window.atumMatrix, { agentScreen: transport })
    const view = render(panel())
    view.rerender(panel(1))

    const takeOver = await screen.findByRole('button', { name: copy.takeOver })
    await waitFor(() => expect((takeOver as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(takeOver)
    await screen.findByRole('button', { name: copy.handBackContinue })

    fireEvent.click(within(screenTab()!.parentElement!).getByRole('button', { name: /close/i }))

    await waitFor(() => expect(screenTab()).toBeUndefined())
    expect($matrixScreenContinue.get()).toBeNull()
  })
})
