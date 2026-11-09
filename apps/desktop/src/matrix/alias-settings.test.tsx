import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixAgentView } from '../../shared/matrix'
import type {
  MatrixAliasBridge,
  MatrixAliasChange,
  MatrixAliasRequest,
  MatrixAliasResult
} from '../../shared/matrix-aliases'

import { MatrixAliasSettings } from './alias-settings'

afterEach(cleanup)

const noPending = () => Promise.resolve({ ok: true as const, request: null })

const current = (handle: string | null): MatrixAliasResult => ({
  ok: true,
  value: { kind: 'current', alias: handle ? { handle, generation: 1 } : null }
})

const free = (handle: string): MatrixAliasResult => ({
  ok: true,
  value: { kind: 'check', handle, available: true, code: null }
})

const agent = (assistantId: string, name: string) =>
  ({ assistantId, name, userId: `@${assistantId}:atum.test` }) as MatrixAgentView

/** Long enough for the field's pause before it asks the directory. */
const settled = { timeout: 2500 }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void

  const promise = new Promise<T>((next, fail) => {
    resolve = next
    reject = fail
  })

  return { promise, reject, resolve }
}

/** A directory that answers every check as free and every change as done. */
function directory(
  start: Record<string, string | null> = {},
  answer?: (input: MatrixAliasChange) => MatrixAliasResult | Promise<MatrixAliasResult>
) {
  const held = new Map(Object.entries(start))
  const requests: MatrixAliasRequest[] = []

  const bridge: MatrixAliasBridge = {
    pending: noPending,
    request: vi.fn(async input => {
      requests.push(input)

      if (input.action === 'current') {
        return current(held.get(input.assistantId ?? '') ?? null)
      }

      if (input.action === 'check') {
        return free(input.handle.replace(/^@/, '').toLowerCase())
      }

      if (input.action === 'claim' || input.action === 'rename') {
        if (answer) {
          return answer(input)
        }

        const previous = held.get(input.assistantId ?? '') ?? null
        held.set(input.assistantId ?? '', input.handle)

        return input.action === 'rename' && previous
          ? { ok: true as const, value: { kind: 'rename' as const, handle: input.handle, generation: 1, previous } }
          : { ok: true as const, value: { kind: 'claim' as const, handle: input.handle, generation: 1 } }
      }

      return { ok: false as const, error: 'unavailable' as const }
    })
  }

  return { bridge, requests }
}

/** One keystroke at a time, each appended to what the field holds after the last render. */
function typeInto(input: HTMLInputElement, text: string) {
  for (const char of text) {
    fireEvent.change(input, { target: { value: `${input.value}${char}` } })
  }
}

function renderSettings(props: Partial<ComponentProps<typeof MatrixAliasSettings>> = {}) {
  return render(
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixAliasSettings accountKey="account-a" agents={[]} bridge={directory().bridge} {...props} />
    </I18nProvider>
  )
}

async function typeAvailable(handle: string, open = 'Choose a handle') {
  if (!screen.queryByLabelText('Handle')) {
    fireEvent.click(await screen.findByRole('button', { name: open }))
  }

  fireEvent.change(screen.getByLabelText('Handle'), { target: { value: handle } })
  await screen.findByText(`@${handle.replace(/^@/, '').toLowerCase()} is available.`, undefined, settled)
}

describe('MatrixAliasSettings', () => {
  it('asks whose handle only when there are assistants to choose from', async () => {
    const view = renderSettings()
    expect(await screen.findByText('No handle yet')).toBeTruthy()
    expect(screen.queryByLabelText('For')).toBeNull()

    view.unmount()
    renderSettings({ agents: [agent('assistant-a', 'Alpha')] })
    const target = await screen.findByLabelText('For')
    expect([...(target as HTMLSelectElement).options].map(option => option.textContent)).toEqual(['Me', 'Alpha'])
  })

  // Preserve user-visible identity, state and recovery behavior across connection changes.
  // invites them to choose it.
  it('invites the person without a handle to choose one, and never claims one for them', async () => {
    const { bridge, requests } = directory()

    render(
      <I18nProvider configClient={null} initialLocale="vi">
        <MatrixAliasSettings accountKey="account-a" agents={[]} bridge={bridge} />
      </I18nProvider>
    )

    expect(await screen.findByText('Chưa có tên công khai')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Chọn tên công khai' })).toBeTruthy()
    expect(requests.map(each => each.action)).toEqual(['current'])
  })

  it('shows an unavailable current lookup as an error, never as no handle', async () => {
    const bridge: MatrixAliasBridge = {
      pending: noPending,
      request: vi.fn(async () => ({ ok: false as const, error: 'unavailable' as const }))
    }

    renderSettings({ bridge })
    expect(await screen.findByText('Couldn’t reach handles. Try again.')).toBeTruthy()
    expect(screen.queryByText('No handle yet')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Choose a handle' })).toBeNull()
  })

  it('checks only a well-formed handle, once typing pauses, and says what is wrong without asking', async () => {
    const { bridge, requests } = directory()
    renderSettings({ bridge })
    fireEvent.click(await screen.findByRole('button', { name: 'Choose a handle' }))
    const field = screen.getByLabelText('Handle')
    fireEvent.change(field, { target: { value: 'ab' } })
    expect(screen.getByText('Use 3–32 letters, numbers or underscores, starting with a letter.')).toBeTruthy()
    fireEvent.change(field, { target: { value: 'lan_bot' } })
    expect(screen.getByText('The _bot ending is for assistants.')).toBeTruthy()
    fireEvent.change(field, { target: { value: '@Lan_' } })
    fireEvent.change(field, { target: { value: '@Lan_Nguyen' } })
    await screen.findByText('@lan_nguyen is available.', undefined, settled)
    expect(requests.filter(request => request.action === 'check')).toEqual([{ action: 'check', handle: 'lan_nguyen' }])
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(false)
  })

  it('names a taken or reserved handle, and never offers to save it', async () => {
    const bridge: MatrixAliasBridge = {
      pending: noPending,
      request: vi.fn(async input => {
        if (input.action === 'current') {
          return current(null)
        }

        const handle = input.action === 'check' ? input.handle : ''

        return {
          ok: true as const,
          value: {
            kind: 'check' as const,
            handle,
            available: false,
            code: handle === 'moon' ? 'alias_reserved' : 'alias_unavailable'
          }
        }
      })
    }

    renderSettings({ bridge })
    fireEvent.click(await screen.findByRole('button', { name: 'Choose a handle' }))
    fireEvent.change(screen.getByLabelText('Handle'), { target: { value: 'moon' } })
    await screen.findByText('This handle is reserved.', undefined, settled)
    fireEvent.change(screen.getByLabelText('Handle'), { target: { value: 'lan' } })
    await screen.findByText('This handle is taken.', undefined, settled)
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true)
  })

  it('says when the check budget is spent, and stops saying it is checking', async () => {
    const bridge: MatrixAliasBridge = {
      pending: noPending,
      request: vi.fn(async input =>
        input.action === 'current'
          ? current(null)
          : { ok: false as const, error: 'limit' as const, retryAfterSeconds: 60 }
      )
    }

    renderSettings({ bridge })
    fireEvent.click(await screen.findByRole('button', { name: 'Choose a handle' }))
    fireEvent.change(screen.getByLabelText('Handle'), { target: { value: 'busy_person' } })
    expect(screen.getByText('Checking…')).toBeTruthy()
    await screen.findByText('Too many checks. Try again in a minute.', undefined, settled)
    expect(screen.queryByText('Checking…')).toBeNull()
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true)
  })

  it('requires explicit confirmation before sending a claim', async () => {
    const { bridge, requests } = directory()
    renderSettings({ bridge })
    await typeAvailable('public_handle')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    const dialog = await screen.findByRole('dialog')
    expect(
      within(dialog).getByText('@public_handle becomes your handle. You can change it once every 30 days.')
    ).toBeTruthy()
    expect(requests.filter(request => request.action === 'claim')).toHaveLength(0)

    fireEvent.click(within(dialog).getByRole('button', { name: 'Use handle' }))
    await waitFor(() => expect(requests.filter(request => request.action === 'claim')).toHaveLength(1))
    expect(await screen.findByText('@public_handle')).toBeTruthy()
    expect(screen.getByText('Saved.')).toBeTruthy()
  })

  it('keeps a saving dialog open and sends its change only once', async () => {
    const saving = deferred<MatrixAliasResult>()
    const { bridge, requests } = directory({}, () => saving.promise)
    renderSettings({ bridge })
    await typeAvailable('wait_for_claim')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Use handle' }))
    await waitFor(() => expect(requests.filter(request => request.action === 'claim')).toHaveLength(1))

    const savingDialog = screen.getByRole('dialog')
    const cancel = within(savingDialog).getByRole('button', { name: 'Cancel' })
    const confirm = within(savingDialog).getByRole('button', { name: 'Loading…' })
    expect(cancel.hasAttribute('disabled')).toBe(true)
    expect(confirm.hasAttribute('disabled')).toBe(true)

    fireEvent.click(cancel)
    fireEvent.click(confirm)
    fireEvent.keyDown(savingDialog, { key: 'Escape' })

    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(requests.filter(request => request.action === 'claim')).toHaveLength(1)
  })

  it('recovers an unknown claim from the native pending intent with its original UUID', async () => {
    const requests: MatrixAliasRequest[] = []
    let nativePending: MatrixAliasChange | null = null
    let attempts = 0

    const bridge: MatrixAliasBridge = {
      pending: vi.fn(async () => ({ ok: true as const, request: nativePending })),
      request: vi.fn(async input => {
        requests.push(input)

        if (input.action === 'current') {
          return current(null)
        }

        if (input.action === 'check') {
          return free(input.handle)
        }

        nativePending = input as MatrixAliasChange

        if (++attempts === 1) {
          return { ok: false as const, error: 'unavailable' as const }
        }

        return {
          ok: true as const,
          value: { kind: 'claim' as const, handle: input.action === 'claim' ? input.handle : '', generation: 1 }
        }
      })
    }

    renderSettings({ bridge })
    await typeAvailable('recover_me')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Use handle' }))
    await within(dialog).findByText('Couldn’t reach handles. Try again.')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Check earlier change' }))
    await waitFor(() => expect(attempts).toBe(2))

    const claims = requests.filter((request): request is MatrixAliasChange => request.action === 'claim')

    expect(claims).toHaveLength(2)
    expect(claims[1]).toBe(claims[0])
    expect(claims[1]?.requestId).toBe(claims[0]?.requestId)
    expect(bridge.pending).toHaveBeenCalled()
  })

  it('changes an assistant’s handle from the one shown, and says what happens to the old one', async () => {
    const { bridge, requests } = directory({ 'assistant-a': 'alfred_bot' })
    const agents = [agent('assistant-a', 'Alfred')]
    renderSettings({ agents, bridge })
    fireEvent.change(await screen.findByLabelText('For'), { target: { value: 'assistant-a' } })
    expect(await screen.findByText('@alfred_bot')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Change' }))

    // The field starts at the handle held now (the part before the fixed _bot), which is not a
    // change, and says when it may change again.
    expect((screen.getByLabelText('Bot handle') as HTMLInputElement).value).toBe('alfred')
    expect(screen.getByText('This is the current handle.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true)

    fireEvent.change(screen.getByLabelText('Bot handle'), { target: { value: 'alfred_helper' } })
    await screen.findByText('@alfred_helper_bot is available.', undefined, settled)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Change this handle?')).toBeTruthy()
    expect(
      within(dialog).getByText(
        'Alfred’s bot handle becomes @alfred_helper_bot. @alfred_bot stays yours for 30 days, and the next change is possible in 30 days.'
      )
    ).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Change' }))

    await screen.findByText('@alfred_helper_bot')
    const [rename] = requests.filter(request => request.action === 'rename')
    expect(rename).toMatchObject({
      action: 'rename',
      handle: 'alfred_helper_bot',
      from: 'alfred_bot',
      assistantId: 'assistant-a'
    })
    expect(requests.filter(request => request.action === 'claim')).toHaveLength(0)
  })

  it('offers an assistant without a handle one from its name, before the fixed _bot, and asks about it', async () => {
    const { bridge, requests } = directory()
    renderSettings({ agents: [agent('assistant-a', 'Trợ lý Đức')], bridge })
    fireEvent.change(await screen.findByLabelText('For'), { target: { value: 'assistant-a' } })
    expect(await screen.findByText('No bot handle yet')).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: 'Choose a bot handle' }))
    const field = screen.getByLabelText('Bot handle') as HTMLInputElement
    expect(field.value).toBe('tro_ly_duc')
    await screen.findByText('@tro_ly_duc_bot is available.', undefined, settled)
    expect(requests.filter(request => request.action === 'check')).toEqual([
      { action: 'check', handle: 'tro_ly_duc_bot', assistantId: 'assistant-a' }
    ])
    // A first handle has nothing to wait for: no 30-day rule yet.
    expect(screen.queryByText('A handle can change once every 30 days.')).toBeNull()

    // What is typed is read the way a name is, and a typed _bot is not doubled.
    fireEvent.change(field, { target: { value: 'Đức Anh' } })
    fireEvent.blur(field)
    expect(field.value).toBe('duc_anh')
    fireEvent.change(field, { target: { value: '@duc_bot' } })
    fireEvent.blur(field)
    expect(field.value).toBe('duc')
    await screen.findByText('@duc_bot is available.', undefined, settled)
  })

  it.each([
    ['Bếp Trưởng', 'bep_truong'],
    ['tro_ly_botanic', 'tro_ly_botanic']
  ])('keeps an assistant’s bot handle as typed key by key (%s), and asks about %s', async (typed, stem) => {
    const { bridge, requests } = directory()
    renderSettings({ agents: [agent('assistant-a', 'Trợ lý Đức')], bridge })
    fireEvent.change(await screen.findByLabelText('For'), { target: { value: 'assistant-a' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Choose a bot handle' }))
    const field = screen.getByLabelText('Bot handle') as HTMLInputElement
    fireEvent.change(field, { target: { value: '' } })
    typeInto(field, typed)
    expect(field.value).toBe(typed)
    await screen.findByText(`@${stem}_bot is available.`, undefined, settled)
    expect(requests).toContainEqual({ action: 'check', handle: `${stem}_bot`, assistantId: 'assistant-a' })
    fireEvent.blur(field)
    expect(field.value).toBe(stem)
  })

  it('says when the next change is possible after a rename inside 30 days', async () => {
    const { bridge } = directory({ '': 'lan' }, () => ({
      ok: false as const,
      error: 'limit' as const,
      retryAfterSeconds: 10 * 86400
    }))

    renderSettings({ bridge })
    fireEvent.click(await screen.findByRole('button', { name: 'Change' }))
    await typeAvailable('lan_nguyen')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Change' }))
    const date = new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(new Date(Date.now() + 10 * 86400 * 1000))
    await within(dialog).findByText(`This handle changed recently. It can change again on ${date}.`)
  })

  it('does not let a late old target lookup overwrite the newly selected target', async () => {
    const oldTarget = deferred<MatrixAliasResult>()
    const agents = [agent('assistant-a', 'Alpha'), agent('assistant-b', 'Beta')]

    const bridge: MatrixAliasBridge = {
      pending: noPending,
      request: vi.fn(input => {
        if (input.action !== 'current') {
          return Promise.resolve({ ok: false as const, error: 'missing' as const })
        }

        if (input.assistantId === 'assistant-a') {
          return oldTarget.promise
        }

        if (input.assistantId === 'assistant-b') {
          return Promise.resolve(current('beta_bot'))
        }

        return Promise.resolve(current(null))
      })
    }

    renderSettings({ agents, bridge })
    const select = await screen.findByLabelText('For')
    fireEvent.change(select, { target: { value: 'assistant-a' } })
    fireEvent.change(select, { target: { value: 'assistant-b' } })
    await screen.findByText('@beta_bot')
    await act(async () => oldTarget.resolve(current('alpha_bot')))

    expect(screen.queryByText('@alpha_bot')).toBeNull()
    expect(screen.getByText('@beta_bot')).toBeTruthy()
  })

  it('does not let a late old account lookup leak into the replacement account', async () => {
    const oldAccount = deferred<MatrixAliasResult>()

    const oldBridge: MatrixAliasBridge = {
      pending: noPending,
      request: vi.fn(() => oldAccount.promise)
    }

    const newBridge: MatrixAliasBridge = {
      pending: noPending,
      request: vi.fn(async () => current('new_account'))
    }

    const view = renderSettings({ bridge: oldBridge })
    view.rerender(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixAliasSettings accountKey="account-b" agents={[]} bridge={newBridge} />
      </I18nProvider>
    )
    await screen.findByText('@new_account')
    await act(async () => oldAccount.resolve(current('old_account')))

    expect(screen.queryByText('@old_account')).toBeNull()
    expect(screen.getByText('@new_account')).toBeTruthy()
  })

  it('says handles are not open yet, and never presents a successful assignment', async () => {
    const { bridge } = directory({}, () => ({ ok: false as const, error: 'closed' as const }))
    renderSettings({ bridge })
    await typeAvailable('closed_handle')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Use handle' }))
    const closed = 'Handles aren’t open yet. You’ll be able to choose one soon.'
    await within(dialog).findByText(closed)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    expect(screen.getByRole('alert').textContent).toContain(closed)
    expect(screen.queryByText('@closed_handle')).toBeNull()
  })

  it('replays a different target’s pending claim without painting it as the selected target', async () => {
    const pending: MatrixAliasChange = {
      action: 'claim',
      assistantId: 'assistant-b',
      handle: 'beta_bot',
      requestId: 'native-pending-id'
    }

    let nativePending: MatrixAliasChange | null = pending
    const requests: MatrixAliasRequest[] = []

    const bridge: MatrixAliasBridge = {
      pending: vi.fn(async () => ({ ok: true as const, request: nativePending })),
      request: vi.fn(async input => {
        requests.push(input)

        if (input.action === 'current') {
          return current(null)
        }

        if (input.action === 'claim') {
          nativePending = null

          return { ok: true as const, value: { kind: 'claim' as const, handle: input.handle, generation: 1 } }
        }

        return { ok: false as const, error: 'missing' as const }
      })
    }

    renderSettings({ agents: [agent('assistant-a', 'Alpha'), agent('assistant-b', 'Beta')], bridge })
    fireEvent.change(await screen.findByLabelText('For'), { target: { value: 'assistant-a' } })
    await screen.findByText('No bot handle yet')

    expect(screen.getByText('An earlier change needs checking before another one.')).toBeTruthy()
    expect(screen.getByText(/Beta · @beta_bot/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Choose a bot handle' }).hasAttribute('disabled')).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Check earlier change' }))
    await waitFor(() => expect(requests.filter(request => request.action === 'claim')).toEqual([pending]))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Choose a bot handle' }).hasAttribute('disabled')).toBe(false)
    )
    expect(
      requests.filter(request => request.action === 'current' && request.assistantId === 'assistant-a')
    ).toHaveLength(2)
    expect(screen.getByText('No bot handle yet')).toBeTruthy()
    expect(screen.queryByText('Saved.')).toBeNull()
  })
})
