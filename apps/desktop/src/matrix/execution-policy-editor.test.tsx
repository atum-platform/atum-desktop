import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { ExecutionPolicySnapshot, ExecutionPolicyUpdate } from '../../shared/execution-policy'
import { parseExecutionPolicySnapshot, parseExecutionStatusSnapshot } from '../../shared/execution-policy'
import savedPolicyFixture from '../../shared/execution-policy/fixtures/execution-policy/v1/fixtures/policy-saved.response.json'
import workingStatusFixture from '../../shared/execution-policy/fixtures/execution-policy/v1/fixtures/status-working.response.json'

import type { MatrixExecutionPolicyEditorProps, MatrixExecutionPolicySaveResult } from './execution-policy-editor'
import { MatrixExecutionPolicyEditor } from './execution-policy-editor'
import { executionPolicyEditorCopy, executionPolicyStatusAge } from './execution-policy-editor-copy'

// These cases exercise the dormant Mac moves, which only tests can reach (cloud-only S0 keeps the
// desktop's one switch on; agent-home-cloud-only.test.tsx covers what the app actually offers).
vi.mock('../../shared/agent-home-cloud-only', async original => ({
  ...(await original<Record<string, unknown>>()),
  AGENT_HOMES_CLOUD_ONLY: false
}))

const policy = parseExecutionPolicySnapshot(savedPolicyFixture)!
const status = parseExecutionStatusSnapshot(workingStatusFixture)!

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => {} })
})

beforeEach(() => {
  // Keyboard moves are measured from row rects; jsdom has no layout, so rows are stacked.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const row = this.closest('li[data-destination-kind]')
    const index = row?.parentElement ? Array.from(row.parentElement.children).indexOf(row) : 0
    const top = Math.max(index, 0) * 40

    return {
      bottom: top + 36,
      height: 36,
      left: 0,
      right: 320,
      top,
      width: 320,
      x: 0,
      y: top,
      toJSON: () => ({})
    } as DOMRect
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

/** Let the debounced write timer run out and its promise settle before asserting. */
async function settleSave(ms = 1_000) {
  await act(async () => {
    vi.advanceTimersByTime(ms)
  })
}

/** dnd-kit's keyboard drag: Space picks the row up, arrows move it, Space drops it. */
async function keyboardMove(grip: HTMLElement, moves: Array<'ArrowDown' | 'ArrowUp'>) {
  const ownerDocument = grip.ownerDocument

  fireEvent.keyDown(grip, { code: 'Space', key: ' ' })
  await act(async () => {
    vi.advanceTimersByTime(0)
  })

  for (const code of moves) {
    fireEvent.keyDown(ownerDocument, { code, key: code })
    await act(async () => {})
  }

  fireEvent.keyDown(ownerDocument, { code: 'Space', key: ' ' })
}

function accepted(update: ExecutionPolicyUpdate, revision = update.expectedRevision + 1): ExecutionPolicySnapshot {
  return {
    profile: 'atum.execution-policy/1',
    agentPrincipal: policy.agentPrincipal,
    revision,
    source: 'saved',
    order: [...update.order],
    disabled: [...update.disabled]
  }
}

function page(
  props: Partial<MatrixExecutionPolicyEditorProps> = {},
  locale: 'en' | 'vi' | 'ja' | 'zh' | 'zh-hant' = 'en'
) {
  const save: MatrixExecutionPolicyEditorProps['save'] =
    props.save ??
    vi.fn(
      async (update: ExecutionPolicyUpdate): Promise<MatrixExecutionPolicySaveResult> => ({
        ok: true,
        value: accepted(update)
      })
    )

  const onRefresh = props.onRefresh ?? vi.fn()
  const selectedPolicy = props.policy ?? policy
  const selectedStatus = Object.hasOwn(props, 'status') ? props.status : status

  return (
    <I18nProvider configClient={null} initialLocale={locale}>
      <MatrixExecutionPolicyEditor
        {...props}
        onRefresh={onRefresh}
        policy={selectedPolicy}
        save={save}
        status={selectedStatus}
      />
    </I18nProvider>
  )
}

describe('execution policy editor', () => {
  it('shows authoritative order and state without exposing device-service ids', () => {
    const view = render(page())
    const rows = screen.getAllByRole('listitem')

    expect(rows).toHaveLength(3)
    expect(within(rows[0]).getByText('Mac 1')).toBeTruthy()
    expect(within(rows[0]).getByText('Working')).toBeTruthy()
    expect(within(rows[1]).getByText('Cloud')).toBeTruthy()
    expect(within(rows[1]).getByText('Ready')).toBeTruthy()
    expect(within(rows[2]).getByText('Mac 2')).toBeTruthy()
    expect(within(rows[2]).getByText('Turned off')).toBeTruthy()
    expect(view.container.querySelector('[data-execution-policy-freshness]')).toBeTruthy()
    expect(view.container.innerHTML).not.toContain('22222222-2222')
    // A clean draft has nothing to save and nowhere to save it: the write is the drop or toggle.
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reset' })).toBeNull()
    expect(screen.getAllByRole('switch').every(control => !(control as HTMLButtonElement).disabled)).toBe(true)
  })

  it('speaks the owner’s real Mac names in its rows, this Mac marked and possessives stripped', () => {
    const MAC_A = 'mac:00000000-0000-4000-8000-b454f82c5857'
    const MAC_B = 'mac:00000000-0000-4000-8000-f6222a1106ee'

    render(
      page(
        {
          deviceNames: {
            [MAC_A.slice('mac:'.length)]: { displayName: "Example's MacBook Air", model: 'MacBook Air', thisMac: true },
            [MAC_B.slice('mac:'.length)]: { displayName: "Owner's Mac mini", thisMac: false }
          }
        },
        'vi'
      )
    )

    const rows = screen.getAllByRole('listitem')

    expect(within(rows[0]).getByText('MacBook Air (máy này)')).toBeTruthy()
    expect(within(rows[2]).getByText('Mac mini')).toBeTruthy()
    expect(screen.getByRole('switch', { name: 'Tắt MacBook Air (máy này)' })).toBeTruthy()
    expect(screen.getByRole('switch', { name: 'Bật Mac mini' })).toBeTruthy()
  })

  it('reports bounded relative status freshness in the selected locale', () => {
    expect(executionPolicyStatusAge('en', 99_995_000, 100_000_000)).toBe('5 seconds ago')
    expect(executionPolicyStatusAge('en', 100_005_000, 100_000_000)).toBe('now')
    expect(executionPolicyStatusAge('vi', 99_880_000, 100_000_000)).toContain('2 phút')
  })

  it('writes one complete policy a second after the last change, and rereads status after acceptance', async () => {
    const onAccepted = vi.fn()
    const onRefresh = vi.fn()

    const save = vi.fn(
      async (update: ExecutionPolicyUpdate): Promise<MatrixExecutionPolicySaveResult> => ({
        ok: true,
        value: accepted(update)
      })
    )

    vi.useFakeTimers()
    render(page({ onAccepted, onRefresh, save }))

    await keyboardMove(screen.getByRole('button', { name: 'Reorder Cloud' }), ['ArrowUp'])
    await settleSave(999)
    expect(save).not.toHaveBeenCalled()
    await settleSave(1)

    expect(save).toHaveBeenCalledTimes(1)
    const update = save.mock.calls[0][0]
    expect(update.expectedRevision).toBe(2)
    expect(update.order).toEqual([
      'cloud',
      'mac:00000000-0000-4000-8000-b454f82c5857',
      'mac:00000000-0000-4000-8000-f6222a1106ee'
    ])
    expect(update.disabled).toEqual(['mac:00000000-0000-4000-8000-f6222a1106ee'])
    expect(update.requestId).toMatch(/^[0-9a-f-]{36}$/u)
    expect(onAccepted).toHaveBeenCalledTimes(1)
    // A save's accepted policy has no status yet; the editor asks for one right away.
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('coalesces two quick changes into one write of the final draft', async () => {
    const save = vi.fn(
      async (update: ExecutionPolicyUpdate): Promise<MatrixExecutionPolicySaveResult> => ({
        ok: true,
        value: accepted(update)
      })
    )

    vi.useFakeTimers()
    render(page({ save }))

    await keyboardMove(screen.getByRole('button', { name: 'Reorder Cloud' }), ['ArrowUp'])
    await settleSave(500)
    fireEvent.click(screen.getByRole('switch', { name: 'Turn on Mac 2' }))
    await settleSave(999)
    expect(save).not.toHaveBeenCalled()
    await settleSave(1)

    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0][0].order).toEqual([
      'cloud',
      'mac:00000000-0000-4000-8000-b454f82c5857',
      'mac:00000000-0000-4000-8000-f6222a1106ee'
    ])
    expect(save.mock.calls[0][0].disabled).toEqual([])
  })

  it('keeps a change made while a write is in flight and writes it next, never reverting it', async () => {
    let resolve!: (result: MatrixExecutionPolicySaveResult) => void
    let edited = false

    const save = vi.fn<(update: ExecutionPolicyUpdate) => Promise<MatrixExecutionPolicySaveResult>>(update => {
      if (!edited) {
        edited = true
        // The person toggles a row as the timer starts the write, before the rows paint as disabled.
        fireEvent.click(screen.getByRole('switch', { name: 'Turn on Mac 2' }))

        return new Promise(done => {
          resolve = done
        })
      }

      return Promise.resolve({ ok: true, value: accepted(update) })
    })

    vi.useFakeTimers()
    render(page({ save }))

    await keyboardMove(screen.getByRole('button', { name: 'Reorder Cloud' }), ['ArrowUp'])
    await settleSave()

    expect(save).toHaveBeenCalledTimes(1)
    const first = save.mock.calls[0][0]
    expect(first.order).toEqual([
      'cloud',
      'mac:00000000-0000-4000-8000-b454f82c5857',
      'mac:00000000-0000-4000-8000-f6222a1106ee'
    ])
    expect(first.disabled).toEqual(['mac:00000000-0000-4000-8000-f6222a1106ee'])
    // The newer toggle is what the rows show while the first write is still on the wire.
    expect(screen.getByRole('switch', { name: 'Turn off Mac 2' }).getAttribute('aria-checked')).toBe('true')

    await act(async () => resolve({ ok: true, value: accepted(first) }))

    // The first answer is not allowed to revert the newer toggle…
    expect(within(screen.getAllByRole('listitem')[0]).getByText('Cloud')).toBeTruthy()
    expect(screen.getByRole('switch', { name: 'Turn off Mac 2' }).getAttribute('aria-checked')).toBe('true')

    // …and the debounce writes it against the revision the first answer accepted.
    await settleSave()
    expect(save).toHaveBeenCalledTimes(2)
    const second = save.mock.calls[1][0]
    expect(second.expectedRevision).toBe(3)
    expect(second.order).toEqual(first.order)
    expect(second.disabled).toEqual([])
  })

  it('reorders by keyboard (Space, ArrowDown, Space) and saves the moved order once', async () => {
    const save = vi.fn(
      async (update: ExecutionPolicyUpdate): Promise<MatrixExecutionPolicySaveResult> => ({
        ok: true,
        value: accepted(update)
      })
    )

    vi.useFakeTimers()
    render(page({ save }))

    await keyboardMove(screen.getByRole('button', { name: 'Reorder Mac 1' }), ['ArrowDown'])

    const rows = screen.getAllByRole('listitem')
    expect(within(rows[0]).getByText('Cloud')).toBeTruthy()
    expect(within(rows[1]).getByText('Mac 1')).toBeTruthy()
    expect(save).not.toHaveBeenCalled()

    await settleSave()
    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0][0].order).toEqual([
      'cloud',
      'mac:00000000-0000-4000-8000-b454f82c5857',
      'mac:00000000-0000-4000-8000-f6222a1106ee'
    ])
  })

  it('writes a toggle a second after it lands, with no button to press', async () => {
    const save = vi.fn(
      async (update: ExecutionPolicyUpdate): Promise<MatrixExecutionPolicySaveResult> => ({
        ok: true,
        value: accepted(update)
      })
    )

    vi.useFakeTimers()
    render(page({ save }))

    fireEvent.click(screen.getByRole('switch', { name: 'Turn on Mac 2' }))
    await settleSave(999)
    expect(save).not.toHaveBeenCalled()
    await settleSave(1)

    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0][0].disabled).toEqual([])
    expect(save.mock.calls[0][0].expectedRevision).toBe(2)
  })

  it('disables the rows while a write is in flight', async () => {
    let resolve!: (result: MatrixExecutionPolicySaveResult) => void

    const save = vi.fn<(update: ExecutionPolicyUpdate) => Promise<MatrixExecutionPolicySaveResult>>(
      _update =>
        new Promise(done => {
          resolve = done
        })
    )

    vi.useFakeTimers()
    render(page({ save }))

    fireEvent.click(screen.getByRole('switch', { name: 'Turn on Mac 2' }))
    await settleSave()

    expect(save).toHaveBeenCalledTimes(1)
    expect(screen.getAllByRole('switch').every(control => (control as HTMLButtonElement).disabled)).toBe(true)
    expect((screen.getByRole('button', { name: 'Reorder Cloud' }) as HTMLButtonElement).disabled).toBe(true)

    await act(async () => resolve({ ok: true, value: accepted(save.mock.calls[0][0]) }))
    expect(screen.getAllByRole('switch').every(control => !(control as HTMLButtonElement).disabled)).toBe(true)
  })

  it('allows an explicit all-disabled pause and explains a draining active turn', async () => {
    const onAccepted = vi.fn()

    const save = vi.fn(
      async (update: ExecutionPolicyUpdate): Promise<MatrixExecutionPolicySaveResult> => ({
        ok: true,
        value: { ...accepted(update), disabled: [...update.disabled].reverse() }
      })
    )

    vi.useFakeTimers()
    render(page({ onAccepted, save }))

    fireEvent.click(screen.getByRole('switch', { name: 'Turn off Mac 1' }))
    expect(screen.getByText('Its current reply can finish before this location turns off.')).toBeTruthy()
    fireEvent.click(screen.getByRole('switch', { name: 'Turn off Cloud' }))
    expect(screen.getByText('This assistant will pause until you turn a location back on.')).toBeTruthy()
    expect(screen.getAllByRole('switch').every(control => control.getAttribute('aria-checked') === 'false')).toBe(true)
    await settleSave()

    expect(onAccepted).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0][0].disabled).toHaveLength(3)
  })

  it('keeps the draft on an unavailable outcome and replays the exact same request from Try again', async () => {
    const save = vi
      .fn<(update: ExecutionPolicyUpdate) => Promise<MatrixExecutionPolicySaveResult>>()
      .mockResolvedValueOnce({ ok: false, error: { error: 'matrix_503', details: { reason: 'unavailable' } } })
      .mockImplementationOnce(async update => ({ ok: true, value: accepted(update) }))

    vi.useFakeTimers()
    render(page({ save }))

    fireEvent.click(screen.getByRole('switch', { name: 'Turn on Mac 2' }))
    await settleSave()

    expect(save).toHaveBeenCalledTimes(1)
    // The choice stays visible, but a failed write never becomes a background retry loop.
    expect(screen.getByRole('switch', { name: 'Turn off Mac 2' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('alert').textContent).toContain('Could not reach Atum. Your choices are still here.')
    await settleSave(5_000)
    expect(save).toHaveBeenCalledTimes(1)
    const failedBody = save.mock.calls[0][0]

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

    // Immediate, not a second debounce: the unknown outcome is retried as the same body at once.
    expect(save).toHaveBeenCalledTimes(2)
    expect(save.mock.calls[1][0]).toEqual(failedBody)
  })

  it.each([
    [
      'invalid',
      { error: 'matrix_400', details: { reason: 'invalid' } } as const,
      'Atum could not save these choices. Check them and try again.'
    ],
    [
      'request_conflict',
      { error: 'matrix_409', details: { reason: 'request_conflict' } } as const,
      'This save could not be replayed safely. Try again.'
    ],
    [
      'queue_busy',
      { error: 'matrix_409', details: { reason: 'queue_busy' } } as const,
      'A reply is in progress. Try again when it finishes.'
    ],
    [
      'invalid_response',
      { error: 'matrix_client', details: { reason: 'invalid_response' } } as const,
      'Atum returned an invalid policy. Your choices are still here.'
    ]
  ])('keeps the draft and shows the closed %s refusal', async (_reason, error, message) => {
    const save = vi.fn(async (): Promise<MatrixExecutionPolicySaveResult> => ({ ok: false, error }))

    vi.useFakeTimers()
    render(page({ save }))

    fireEvent.click(screen.getByRole('switch', { name: 'Turn on Mac 2' }))
    await settleSave()

    expect(screen.getByRole('switch', { name: 'Turn off Mac 2' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('alert').textContent).toContain(message)
    await settleSave(5_000)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('rotates the request id when a new draft is saved after a failed one', async () => {
    const save = vi
      .fn<(update: ExecutionPolicyUpdate) => Promise<MatrixExecutionPolicySaveResult>>()
      .mockResolvedValue({ ok: false, error: { error: 'matrix_503', details: { reason: 'unavailable' } } })

    vi.useFakeTimers()
    render(page({ save }))

    fireEvent.click(screen.getByRole('switch', { name: 'Turn on Mac 2' }))
    await settleSave()
    expect(save).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('switch', { name: 'Turn off Mac 1' }))
    await settleSave()
    expect(save).toHaveBeenCalledTimes(2)
    expect(save.mock.calls[1][0].requestId).not.toBe(save.mock.calls[0][0].requestId)
  })

  it.each([
    ['revision_conflict', 'changed elsewhere'],
    ['inventory_changed', 'available locations changed']
  ] as const)('holds %s closed until authoritative refresh', async (reason, message) => {
    const onRefresh = vi.fn()

    const save = vi.fn(
      async (): Promise<MatrixExecutionPolicySaveResult> => ({
        ok: false,
        error: { error: 'matrix_409', details: { reason }, revision: 3 }
      })
    )

    vi.useFakeTimers()
    render(page({ onRefresh, save }))

    await keyboardMove(screen.getByRole('button', { name: 'Reorder Cloud' }), ['ArrowUp'])
    await settleSave()

    expect(screen.getByRole('alert').textContent).toContain(message)
    // A conflict keeps the draft, closes the rows, and offers reload — not a same-body retry.
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    expect(screen.getAllByRole('switch').every(control => (control as HTMLButtonElement).disabled)).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('rejects a mismatched success response instead of painting it as authoritative', async () => {
    const onAccepted = vi.fn()

    const save = vi.fn(
      async (update: ExecutionPolicyUpdate): Promise<MatrixExecutionPolicySaveResult> => ({
        ok: true,
        value: { ...accepted(update), order: [...update.order].reverse() }
      })
    )

    vi.useFakeTimers()
    render(page({ onAccepted, save }))

    await keyboardMove(screen.getByRole('button', { name: 'Reorder Cloud' }), ['ArrowUp'])
    await settleSave()

    expect(screen.getByRole('alert').textContent).toContain(
      'Atum returned an invalid policy. Your choices are still here.'
    )
    expect(onAccepted).not.toHaveBeenCalled()
    // The rejected success cannot become authoritative, but the person's attempted order remains visible.
    expect(within(screen.getAllByRole('listitem')[0]).getByText('Cloud')).toBeTruthy()
  })

  it('does not combine status from another policy revision with the current editor', () => {
    render(page({ status: { ...status, policyRevision: 1 } }))
    expect(screen.getAllByText('Updating status…')).toHaveLength(3)
    expect(screen.queryByText('Working')).toBeNull()
  })

  it('distinguishes absent status from a stale status snapshot', () => {
    render(page({ status: undefined }))
    expect(screen.getAllByText('Status unavailable')).toHaveLength(3)
    expect(screen.queryByText('Updating status…')).toBeNull()
  })

  it('does not reset an unsaved draft when only disabled wire order changes', async () => {
    const allDisabled = parseExecutionPolicySnapshot({
      ...policy,
      revision: 3,
      disabled: [...policy.order]
    })!

    const save = vi.fn(
      async (update: ExecutionPolicyUpdate): Promise<MatrixExecutionPolicySaveResult> => ({
        ok: true,
        value: accepted(update)
      })
    )

    vi.useFakeTimers()
    const view = render(page({ policy: allDisabled, save, status: undefined }))
    fireEvent.click(screen.getByRole('switch', { name: 'Turn on Mac 1' }))

    view.rerender(
      page({ policy: { ...allDisabled, disabled: [...allDisabled.disabled].reverse() }, save, status: undefined })
    )
    expect(screen.getByRole('switch', { name: 'Turn off Mac 1' })).toBeTruthy()
    await settleSave()

    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0][0].disabled).toEqual(['cloud', 'mac:00000000-0000-4000-8000-f6222a1106ee'])
  })

  it('drops a late save result after a newer authoritative policy arrives', async () => {
    let resolve!: (result: MatrixExecutionPolicySaveResult) => void
    const onAccepted = vi.fn()

    const save = vi.fn<(update: ExecutionPolicyUpdate) => Promise<MatrixExecutionPolicySaveResult>>(
      _update =>
        new Promise<MatrixExecutionPolicySaveResult>(done => {
          resolve = done
        })
    )

    vi.useFakeTimers()
    const view = render(page({ onAccepted, save }))

    fireEvent.click(screen.getByRole('switch', { name: 'Turn on Mac 2' }))
    await settleSave()
    const update = save.mock.calls[0][0]
    const newer = { ...accepted(update, 4), disabled: [] }
    view.rerender(page({ onAccepted, policy: newer, save, status: undefined }))

    // The newer authoritative policy wins; the late answer is dropped and schedules no write.
    await settleSave(2_000)
    expect(save).toHaveBeenCalledTimes(1)

    await act(async () => resolve({ ok: true, value: accepted(update, 3) }))
    expect(onAccepted).not.toHaveBeenCalled()
  })

  it('keeps a failed reorder after an exception and waits for the person before retrying', async () => {
    const save = vi.fn(async (): Promise<MatrixExecutionPolicySaveResult> => {
      throw new Error('raw transport failure must never reach copy')
    })

    vi.useFakeTimers()
    render(page({ save }))

    await keyboardMove(screen.getByRole('button', { name: 'Reorder Cloud' }), ['ArrowUp'])
    await settleSave()

    expect(within(screen.getAllByRole('listitem')[0]).getByText('Cloud')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('Could not reach Atum.')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
    await settleSave(5_000)
    expect(save).toHaveBeenCalledTimes(1)
  })

  const dragHandles = {
    en: 'Reorder Mac 1',
    vi: 'Đổi thứ tự Máy Mac 1',
    ja: 'Mac 1 を並べ替え',
    zh: '调整Mac 1的顺序',
    'zh-hant': '調整Mac 1的順序'
  } as const

  it.each([
    ['en', 'Where this assistant answers', 'Turn off Mac 1'],
    ['vi', 'Nơi trợ lý này trả lời', 'Tắt Máy Mac 1'],
    ['ja', 'このアシスタントが応答する場所', 'Mac 1をオフ'],
    ['zh', '此助手的回复位置', '关闭Mac 1'],
    ['zh-hant', '此助理的回覆位置', '關閉Mac 1']
  ] as const)('provides exact editor controls in %s', (locale, title, toggle) => {
    render(page({}, locale))
    expect(screen.getByRole('heading', { name: title })).toBeTruthy()
    expect(screen.getByRole('switch', { name: toggle })).toBeTruthy()
    expect(screen.getByRole('button', { name: dragHandles[locale] })).toBeTruthy()
  })

  it('announces a keyboard move in all five languages', () => {
    const en = executionPolicyEditorCopy('en')

    expect(en.reorderStart('Mac 1')).toBe(
      'Picked up Mac 1. Use the arrow keys to move it, Space to drop, Escape to cancel.'
    )
    expect(en.reorderOver('Mac 1', 2, 3)).toBe('Mac 1 is at position 2 of 3.')
    expect(en.reorderEnd('Mac 1', 2, 3)).toBe('Mac 1 dropped at position 2 of 3.')
    expect(en.reorderCancel('Mac 1', 2)).toBe('Move cancelled. Mac 1 is back at position 2.')
    expect(en.reorderInstructions).toBe('To reorder, press Space on a row, use the arrow keys, then press Space again.')

    const vi = executionPolicyEditorCopy('vi')

    expect(vi.reorderStart('Máy Mac 1')).toBe(
      'Đã chọn Máy Mac 1. Dùng phím mũi tên để di chuyển, phím cách để thả, Esc để huỷ.'
    )
    expect(vi.reorderOver('Máy Mac 1', 2, 3)).toBe('Máy Mac 1 đang ở vị trí 2/3.')
    expect(vi.reorderEnd('Máy Mac 1', 2, 3)).toBe('Đã đặt Máy Mac 1 ở vị trí 2/3.')
    expect(vi.reorderCancel('Máy Mac 1', 2)).toBe('Đã huỷ di chuyển. Máy Mac 1 về lại vị trí 2.')
    expect(vi.reorderInstructions).toBe(
      'Để đổi thứ tự, nhấn phím cách trên một dòng, dùng phím mũi tên, rồi nhấn phím cách lần nữa.'
    )

    for (const locale of ['ja', 'zh', 'zh-hant'] as const) {
      const words = executionPolicyEditorCopy(locale)

      expect(words.reorderInstructions).not.toBe(en.reorderInstructions)
      expect(words.reorderInstructions.length).toBeGreaterThan(10)
      expect(words.reorderStart('Mac 1')).not.toBe(en.reorderStart('Mac 1'))
    }
  })
})

describe('execution policy editor: a plan lapse, memory, and the per-agent off switch (R5)', () => {
  const MAC_A = 'mac:00000000-0000-4000-8000-b454f82c5857'
  const MAC_B = 'mac:00000000-0000-4000-8000-f6222a1106ee'
  const cloudFirst: ExecutionPolicySnapshot = { ...policy, order: ['cloud', MAC_A, MAC_B], disabled: [MAC_B] }

  const lapsed = parseExecutionStatusSnapshot({
    ...workingStatusFixture,
    state: 'unavailable',
    current: null,
    desired: null,
    order: ['cloud', MAC_A, MAC_B],
    destinations: {
      cloud: { state: 'degraded', reason: 'entitlement_required', observedAt: 1791876998000 },
      [MAC_A]: { state: 'degraded', reason: 'entitlement_required', observedAt: 1791876999000 },
      [MAC_B]: { state: 'disabled', reason: 'owner_disabled', observedAt: 1791876997000 }
    }
  })!

  it('says a Mac is waiting for the plan and what to do, in every shipped locale', () => {
    const view = render(page({ policy: cloudFirst, status: lapsed }))
    const rows = screen.getAllByRole('listitem')

    expect(within(rows[0]).getByText('Plan required')).toBeTruthy()
    expect(within(rows[1]).getByText('Waiting for the plan')).toBeTruthy()
    expect(view.container.querySelector('[data-execution-policy-plan-lapsed]')?.textContent).toBe(
      'Your cloud plan has ended, so this assistant waits instead of moving to a Mac on its own. Add Protons to resume, or turn the cloud off here to answer from a Mac now.'
    )
    cleanup()

    const expected: Record<'vi' | 'ja' | 'zh' | 'zh-hant', [string, string]> = {
      vi: ['Đang chờ gói dịch vụ', 'Nạp thêm Proton'],
      ja: ['プランの更新待ち', 'Proton を追加'],
      zh: ['等待套餐恢复', '充值 Proton'],
      'zh-hant': ['等待方案恢復', '儲值 Proton']
    }

    for (const [locale, [label, remedy]] of Object.entries(expected) as Array<[keyof typeof expected, [string, string]]>) {
      const localized = render(page({ policy: cloudFirst, status: lapsed }, locale))
      expect(localized.container.textContent).toContain(label)
      expect(localized.container.querySelector('[data-execution-policy-plan-lapsed]')?.textContent).toContain(remedy)
      cleanup()
    }
  })

  it('says nothing about a plan while the Macs are simply working or offline', () => {
    const view = render(page())

    expect(view.container.querySelector('[data-execution-policy-plan-lapsed]')).toBeNull()
  })

  it('says this Mac answers without the cloud’s recent memory only when told so', () => {
    const quiet = render(page())
    expect(quiet.container.querySelector('[data-execution-policy-memory-note]')).toBeNull()
    cleanup()

    const noted = render(page({ memoryNote: 'without_recent' }))
    expect(noted.container.querySelector('[data-execution-policy-memory-note]')?.textContent).toBe(
      'This Mac is answering without the cloud’s recent memory, so it may not know the latest.'
    )
    cleanup()

    // The cloud's copy replaced memory this Mac had changed: said as that, with where the old copy is.
    const saved = render(page({ memoryNote: 'local_saved' }))
    expect(saved.container.querySelector('[data-execution-policy-memory-note]')?.textContent).toBe(
      'The cloud’s copy replaced some of what this Mac had remembered. The earlier versions are saved on this Mac.'
    )
  })

  it('says the same thing in every language', () => {
    for (const locale of ['vi', 'ja', 'zh', 'zh-hant'] as const) {
      expect(executionPolicyEditorCopy(locale).memoryLocalSaved, locale).not.toBe(
        executionPolicyEditorCopy('en').memoryLocalSaved
      )
      expect(executionPolicyEditorCopy(locale).memoryLocalSaved.length, locale).toBeGreaterThan(10)
    }
  })

  it('offers the off switch only when the platform answers it, and asks before turning off', async () => {
    const quiet = render(page())
    expect(quiet.container.querySelector('[data-execution-policy-off]')).toBeNull()
    cleanup()

    const turnOff = vi.fn(async (): Promise<MatrixExecutionPolicySaveResult> => ({
      ok: true,
      value: parseExecutionPolicySnapshot({
        profile: 'atum.execution-policy/1',
        agentPrincipal: policy.agentPrincipal,
        revision: 0,
        source: 'default',
        order: ['cloud'],
        disabled: []
      })!
    }))

    const onAccepted = vi.fn()
    render(page({ turnOff, onAccepted }))

    expect(turnOff).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Turn off failover' }))
    expect(turnOff).not.toHaveBeenCalled()
    expect(screen.getByText(/answers only on your Macs again/u)).toBeTruthy()

    // Keep goes back without asking the platform anything.
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }))
    expect(screen.queryByText(/answers only on your Macs again/u)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Turn off failover' }))
    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }))
    await waitFor(() => expect(turnOff).toHaveBeenCalledTimes(1))
    const off = (turnOff.mock.calls[0] as unknown as [{ requestId: string; expectedRevision: number }])[0]
    expect(off.expectedRevision).toBe(2)
    expect(off.requestId).toMatch(/^[0-9a-f-]{36}$/u)
    expect(Object.keys(off).sort()).toEqual(['expectedRevision', 'requestId'])
    await waitFor(() => expect(onAccepted).toHaveBeenCalledTimes(1))
    expect(onAccepted.mock.calls[0][0]).toMatchObject({ source: 'default', revision: 0 })
  })

  it('has no off switch for a policy nobody saved', () => {
    const defaultPolicy: ExecutionPolicySnapshot = { ...policy, source: 'default', revision: 0, order: ['cloud'], disabled: [] }
    const view = render(page({ policy: defaultPolicy, status: undefined, turnOff: vi.fn() }))

    expect(view.container.querySelector('[data-execution-policy-off]')).toBeNull()
  })

  it('says a reply is in progress, keeps the same request for a retry, and never claims success on a bad answer', async () => {
    const turnOff = vi
      .fn<(off: { requestId: string; expectedRevision: number }) => Promise<MatrixExecutionPolicySaveResult>>()
      .mockResolvedValueOnce({ ok: false, error: { error: 'matrix_409', details: { reason: 'queue_busy' } } })
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ ok: true, value: policy })

    const onAccepted = vi.fn()
    render(page({ turnOff, onAccepted }))

    fireEvent.click(screen.getByRole('button', { name: 'Turn off failover' }))
    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }))
    expect(await screen.findByText('A reply is in progress. Try again when it finishes.')).toBeTruthy()

    // The platform could not be reached: the outcome is unknown, so the very same request is retried.
    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }))
    expect(await screen.findByText('Could not reach Atum. Your choices are still here.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }))
    expect(await screen.findByText('Atum returned an invalid policy. Your choices are still here.')).toBeTruthy()
    expect(onAccepted).not.toHaveBeenCalled()

    const [busy, offline, wrong] = turnOff.mock.calls.map(([off]) => off)
    // A refused request is new next time; an unknown outcome is retried as the same request.
    expect(busy.requestId).not.toBe(offline.requestId)
    expect(wrong.requestId).toBe(offline.requestId)
  })
})
