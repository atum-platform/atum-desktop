import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixSnapshot } from '../../shared/matrix'
import type { MatrixTerminalBridge, MatrixTerminalChunk } from '../../shared/matrix-terminal'

import { MatrixTerminalOffers, MatrixTerminalPane, useMatrixTerminalRead } from './terminal'

const terms = vi.hoisted(() => [] as { output: string; disposed: boolean }[])
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  output = ''
  disposed = false
  rows = 24
  constructor() { terms.push(this) }
  loadAddon() {}
  open() {}
  write(text: string, done?: () => void) { this.output += text; done?.() }
  reset() { this.output = '' }
  dispose() { this.disposed = true }
  get buffer() { return { active: { length: 24, baseY: 0, cursorY: 0, getLine: (i: number) => ({ translateToString: () => i === 0 ? this.output : '' }) } } }
} }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }))

const snapshot: MatrixSnapshot = {
  state: 'ready', identity: { userId: '@alice:test', deviceId: 'A' },
  roomId: '!one:test', rooms: [], messages: [], error: null,
  terminals: [{ id: 'tab-one', ordinal: 1, open: true }]
}

const scope = 'original-scope'
let listener: ((value: MatrixTerminalChunk) => void) | undefined
let bridge: MatrixTerminalBridge

beforeEach(() => {
  terms.length = 0
  bridge = {
    open: vi.fn(async () => {}), close: vi.fn(async () => {}),
    read: vi.fn(async () => ({ id: 'tab-one', scope, sequence: 1, output: 'first' })),
    respond: vi.fn(async () => {}),
    subscribe: fn => { listener = fn;

 return () => { listener = undefined } }
  }
  Object.assign(window, { atumMatrix: { terminals: bridge } })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); Reflect.deleteProperty(window, 'atumMatrix') })

function frame(child: React.ReactNode) {
  return <I18nProvider configClient={null} initialLocale="en">{child}</I18nProvider>
}

it('does not lose chunks arriving while an initial backlog read is in flight', async () => {
  let first!: (value: Awaited<ReturnType<typeof bridge.read>>) => void
  vi.mocked(bridge.read).mockImplementationOnce(() => new Promise(resolve => { first = resolve }))
    .mockResolvedValue({ id: 'tab-one', scope, sequence: 2, output: 'firstlater' })
  render(frame(<MatrixTerminalPane active roomId="!one:test" scope={scope} tab={snapshot.terminals![0]} />))
  act(() => listener?.({ id: 'tab-one', scope, sequence: 2, chunk: 'later' }))
  await act(async () => { first({ id: 'tab-one', scope, sequence: 1, output: 'first' }) })
  await waitFor(() => expect(terms[0].output).toBe('firstlater'))
  expect(bridge.read).toHaveBeenCalledTimes(2)
  act(() => listener?.({ id: 'tab-one', scope: 'foreign', sequence: 3, chunk: 'private' }))
  act(() => listener?.({ id: 'tab-one', scope, sequence: 3, chunk: 'tail' }))
  expect(terms[0].output).toBe('firstlatertail')
})

it('reads only this selected visible xterm and answers unavailable when it is hidden', async () => {
  function View({ visible, request }: { visible: boolean; request: string }) {
    useMatrixTerminalRead({ ...snapshot, terminalRead: { id: request } }, scope, 'tab-one', visible)

    return <MatrixTerminalPane active={visible} roomId="!one:test" scope={scope} tab={snapshot.terminals![0]} />
  }

  const view = render(frame(<View request="first-read" visible />))
  await waitFor(() => expect(terms[0].output).toBe('first'))
  await waitFor(() => expect(bridge.respond).toHaveBeenCalledWith('!one:test', 'first-read', expect.objectContaining({ text: 'first' })))
  view.rerender(frame(<View request="hidden-read" visible={false} />))
  await waitFor(() => expect(bridge.respond).toHaveBeenCalledWith('!one:test', 'hidden-read', null))
})

it('does not answer a pending read with the other tab after a rapid selection change', async () => {
  function Reader({ selected }: { selected: string }) {
    useMatrixTerminalRead({ ...snapshot, terminalRead: { id: 'same-read' } }, scope, selected, true)
    return null
  }
  const view = render(frame(<Reader selected="tab-one" />))
  view.rerender(frame(<Reader selected="tab-two" />))
  await waitFor(() => expect(bridge.respond).toHaveBeenCalledWith('!one:test', 'same-read', null))
  expect(vi.mocked(bridge.respond).mock.calls.every(call => call[2] === null)).toBe(true)
})

it('requires an explicit click and ignores a delayed open after changing rooms', async () => {
  let finish!: () => void
  vi.mocked(bridge.open).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const opened = vi.fn()
  const view = render(frame(<MatrixTerminalOffers onOpened={opened} scope={scope} snapshot={snapshot} />))
  expect(bridge.open).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: /View running task/ }))
  view.rerender(frame(<MatrixTerminalOffers onOpened={opened} scope="new-room" snapshot={{ ...snapshot, roomId: '!two:test' }} />))
  await act(async () => finish())
  expect(opened).not.toHaveBeenCalled()
  expect((screen.getByRole('button', { name: /View running task/ }) as HTMLButtonElement).disabled).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: /View running task/ }))
  await waitFor(() => expect(opened).toHaveBeenCalledWith('tab-one', 'new-room'))
})
