// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixVoiceSettingsClient, MatrixVoiceSettingsSnapshot } from '../../shared/matrix-voice-settings'
import {
  matrixVoiceFieldLabel,
  matrixVoiceSettingsConfirmationCopy,
  matrixVoiceSettingsCopy
} from '../../shared/matrix-voice-settings-copy'

import { MatrixVoiceSettings } from './voice-settings'

function fixture() {
  const state: MatrixVoiceSettingsSnapshot = {
    fields: [
      { key: 'stt.enabled', type: 'boolean', value: true },
      { key: 'stt.provider', type: 'select', value: 'local', options: ['local', 'openai'] },
      { key: 'tts.provider', type: 'select', value: 'openai', options: ['openai', 'xai'] },
      { key: 'voice.max_recording_seconds', type: 'number', value: 120, min: 1, max: 120, integer: true },
      { key: 'stt.local.language', type: 'string', value: '' },
      { key: 'stt.openai.model', type: 'string', value: 'whisper-1' },
      { key: 'tts.openai.voice', type: 'string', value: 'alloy' },
      { key: 'tts.xai.speed', type: 'number', value: 1, min: 0.7, max: 1.5 }
    ]
  }

  const client: MatrixVoiceSettingsClient = {
    snapshot: vi.fn(async () => structuredClone(state)),
    set: vi.fn(async (field, value) => {
      state.fields.find(row => row.key === field)!.value = value

      return { status: 'applied' as const, field, value }
    })
  }

  return { state, client }
}

function draw(client: MatrixVoiceSettingsClient, agent = 'Ada') {
  return (
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixVoiceSettings agentName={agent} client={client} />
    </I18nProvider>
  )
}

function deferred<T>() {
  let resolve!: (value: T) => void

  const promise = new Promise<T>(done => {
    resolve = done
  })

  return { promise, resolve }
}

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => {} })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('keeps drafts local until Apply, updates only one field and preserves another draft', async () => {
  const f = fixture()
  render(draw(f.client))
  fireEvent.change(await screen.findByRole('textbox', { name: 'OpenAI · Voice' }), { target: { value: 'nova' } })
  fireEvent.change(screen.getByRole('textbox', { name: 'Local · Language' }), { target: { value: 'vi' } })
  expect(f.client.set).not.toHaveBeenCalled()
  expect(screen.getByText('Saved: alloy')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Apply: OpenAI · Voice' }))
  await screen.findByText('Voice setting updated.')
  expect(f.client.set).toHaveBeenCalledExactlyOnceWith('tts.openai.voice', 'nova')
  expect(screen.getByText('Saved: nova')).toBeTruthy()
  expect((screen.getByRole('textbox', { name: 'Local · Language' }) as HTMLInputElement).value).toBe('vi')
  expect((screen.getByRole('button', { name: 'Apply: Local · Language' }) as HTMLButtonElement).disabled).toBe(false)
})
it('requires integer recording duration in the native range and sends a number', async () => {
  const f = fixture()
  render(draw(f.client))
  const input = await screen.findByRole('textbox', { name: 'Maximum recording seconds' })
  const button = screen.getByRole('button', { name: 'Apply: Maximum recording seconds' }) as HTMLButtonElement

  for (const value of ['', '0', '121', '2.5', 'invalid']) {
    fireEvent.change(input, { target: { value } })
    expect(button.disabled).toBe(true)
  }

  fireEvent.change(input, { target: { value: '30' } })
  fireEvent.click(button)
  await screen.findByText('Voice setting updated.')
  expect(f.client.set).toHaveBeenCalledExactlyOnceWith('voice.max_recording_seconds', 30)
})
it('shows the selected provider’s fields without saving the provider draft automatically', async () => {
  const f = fixture()
  render(draw(f.client))
  expect(await screen.findByRole('textbox', { name: 'OpenAI · Voice' })).toBeTruthy()
  fireEvent.click(screen.getByRole('combobox', { name: 'Read-aloud provider' }))
  fireEvent.click(await screen.findByRole('option', { name: 'xai' }))
  expect(screen.queryByRole('textbox', { name: 'OpenAI · Voice' })).toBeNull()
  expect(screen.getByRole('textbox', { name: 'xAI · Speed' })).toBeTruthy()
  expect(f.client.set).not.toHaveBeenCalled()
  expect(screen.getByText('Saved: openai')).toBeTruthy()
  fireEvent.change(screen.getByRole('textbox', { name: 'xAI · Speed' }), { target: { value: '1.6' } })
  expect((screen.getByRole('button', { name: 'Apply: xAI · Speed' }) as HTMLButtonElement).disabled).toBe(true)
})
it('keeps saved truth and the draft after native cancellation', async () => {
  const f = fixture()
  vi.mocked(f.client.set).mockResolvedValue({ status: 'cancelled' })
  render(draw(f.client))
  fireEvent.click(await screen.findByRole('switch', { name: 'Enable dictation' }))
  fireEvent.click(screen.getByRole('button', { name: 'Apply: Enable dictation' }))
  await screen.findByText('Change cancelled.')
  expect(f.client.set).toHaveBeenCalledExactlyOnceWith('stt.enabled', false)
  expect(f.client.snapshot).toHaveBeenCalledOnce()
  expect(screen.queryByText('Voice setting updated.')).toBeNull()
})
it('waits for a verified save and refresh before success and disables concurrent writes', async () => {
  const f = fixture()
  const waiting = deferred<Awaited<ReturnType<MatrixVoiceSettingsClient['set']>>>()
  vi.mocked(f.client.set).mockReturnValue(waiting.promise)
  render(draw(f.client))
  fireEvent.change(await screen.findByRole('textbox', { name: 'OpenAI · Voice' }), { target: { value: 'nova' } })
  fireEvent.click(screen.getByRole('button', { name: 'Apply: OpenAI · Voice' }))
  expect(screen.queryByText('Voice setting updated.')).toBeNull()
  expect((screen.getByRole('button', { name: 'Apply: OpenAI · Voice' }) as HTMLButtonElement).disabled).toBe(true)
  f.state.fields.find(row => row.key === 'tts.openai.voice')!.value = 'nova'
  await act(async () => {
    waiting.resolve({ status: 'applied', field: 'tts.openai.voice', value: 'nova' })
  })
  await screen.findByText('Voice setting updated.')
  expect(f.client.snapshot).toHaveBeenCalledTimes(2)
})
it('retires late writes and reads when the selected agent changes', async () => {
  const first = fixture()
  const waiting = deferred<Awaited<ReturnType<MatrixVoiceSettingsClient['set']>>>()
  vi.mocked(first.client.set).mockReturnValue(waiting.promise)
  const view = render(draw(first.client))
  fireEvent.change(await screen.findByRole('textbox', { name: 'OpenAI · Voice' }), { target: { value: 'nova' } })
  fireEvent.click(screen.getByRole('button', { name: 'Apply: OpenAI · Voice' }))
  const next = fixture()
  next.state.fields.find(row => row.key === 'tts.openai.voice')!.value = 'echo'
  view.rerender(draw(next.client, 'Babbage'))
  await screen.findByText('Saved: echo')
  await act(async () => {
    waiting.resolve({ status: 'applied', field: 'tts.openai.voice', value: 'nova' })
  })
  expect(first.client.snapshot).toHaveBeenCalledOnce()
  expect(screen.queryByText('Voice setting updated.')).toBeNull()
  expect(screen.getByText('Saved: echo')).toBeTruthy()
})
it.each(['write', 'refresh', 'mismatch'])(
  'clears unverifiable values and hides upstream errors on %s failure',
  async kind => {
    const f = fixture()

    if (kind === 'write') {vi.mocked(f.client.set).mockRejectedValue(new Error('https://private?api_key=secret'))}

    if (kind === 'refresh')
      {vi.mocked(f.client.snapshot)
        .mockResolvedValueOnce(structuredClone(f.state))
        .mockRejectedValueOnce(new Error('private'))}

    if (kind === 'mismatch')
      {vi.mocked(f.client.set).mockResolvedValue({ status: 'applied', field: 'stt.enabled', value: false })}

    render(draw(f.client))
    fireEvent.change(await screen.findByRole('textbox', { name: 'OpenAI · Voice' }), { target: { value: 'nova' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply: OpenAI · Voice' }))
    await screen.findByRole('alert')
    expect(globalThis.document.body.textContent).not.toMatch(/private|api_key|secret/)
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByText('Voice setting updated.')).toBeNull()
  }
)
it.each(Object.keys(matrixVoiceSettingsCopy) as (keyof typeof matrixVoiceSettingsCopy)[])(
  'localizes controls and native confirmation in %s',
  async locale => {
    const f = fixture()
    render(
      <I18nProvider configClient={null} initialLocale={locale}>
        <MatrixVoiceSettings agentName="Ada" client={f.client} />
      </I18nProvider>
    )
    const label = matrixVoiceFieldLabel(locale, 'stt.enabled')
    expect(await screen.findByRole('switch', { name: label })).toBeTruthy()
    const copy = matrixVoiceSettingsConfirmationCopy(locale, 'Ada', { field: 'stt.enabled', value: false })
    expect(copy.title).toBe(matrixVoiceSettingsCopy[locale].confirm)
    expect(copy.detail).toContain(label)
    expect(copy.detail).toContain('Ada')
  }
)
