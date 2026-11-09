// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixToolSettingsClient, MatrixToolSettingsSnapshot } from '../../shared/matrix-tool-settings'
import { matrixToolSettingsConfirmationCopy, matrixToolSettingsCopy } from '../../shared/matrix-tool-settings-copy'

import { MatrixToolSettings } from './tool-settings'

function fixture() {
  const state: MatrixToolSettingsSnapshot = {
    configuredBackend: 'local',
    backends: [
      { id: 'local', status: 'ready' },
      { id: 'docker', status: 'needs_setup' }
    ],
    capture: { maxImageDimension: 1456, mode: 'som', dimensionEditable: true, modeEditable: true }
  }

  const client: MatrixToolSettingsClient = {
    snapshot: vi.fn(async () => structuredClone(state)),
    set: vi.fn(async (field, value) => {
      if (field === 'terminal.backend') {state.configuredBackend = value as 'docker'}

      if (field === 'computer_use.max_image_dimension') {state.capture.maxImageDimension = value as number}

      if (field === 'computer_use.capture_after_mode') {state.capture.mode = value as 'ax'}

      return { status: 'applied' as const, field, value }
    })
  }

  return { state, client }
}

function draw(client: MatrixToolSettingsClient, agent = 'Ada') {
  return (
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixToolSettings agentName={agent} client={client} />
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

async function chooseDocker() {
  fireEvent.click(await screen.findByRole('combobox', { name: 'Terminal backend' }))
  fireEvent.click(await screen.findByRole('option', { name: 'Docker · Needs setup' }))
}

it('shows configured status and runtime-start effects, drafts do not switch an executing backend', async () => {
  const f = fixture()
  render(draw(f.client))
  await chooseDocker()
  expect(f.client.set).not.toHaveBeenCalled()
  expect(globalThis.document.body.textContent).toContain('Applies the next time this agent’s runtime starts.')
  expect(globalThis.document.body.textContent).not.toMatch(/In use|telemetry|overlay|Restart/)
  fireEvent.click(screen.getByRole('button', { name: 'Apply: Terminal backend' }))
  await screen.findByText('Tool setting saved.')
  expect(f.client.set).toHaveBeenCalledExactlyOnceWith('terminal.backend', 'docker')
  expect(f.client.snapshot).toHaveBeenCalledTimes(2)
})
it('validates cap and sends numeric zero without modifying another draft', async () => {
  const f = fixture()
  render(draw(f.client))
  await chooseDocker()
  const input = screen.getByRole('textbox', { name: 'Screenshot longest edge' })
  const button = screen.getByRole('button', { name: 'Apply: Screenshot longest edge' }) as HTMLButtonElement

  for (const value of ['', '-1', '0.5', '4097', 'invalid']) {
    fireEvent.change(input, { target: { value } })
    expect(button.disabled).toBe(true)
  }

  fireEvent.change(input, { target: { value: '0' } })
  fireEvent.click(button)
  await screen.findByText('Tool setting saved.')
  expect(f.client.set).toHaveBeenCalledExactlyOnceWith('computer_use.max_image_dimension', 0)
  expect((screen.getByRole('button', { name: 'Apply: Terminal backend' }) as HTMLButtonElement).disabled).toBe(false)
})
it('keeps configuration truth after cancellation', async () => {
  const f = fixture()
  vi.mocked(f.client.set).mockResolvedValue({ status: 'cancelled' })
  render(draw(f.client))
  await chooseDocker()
  fireEvent.click(screen.getByRole('button', { name: 'Apply: Terminal backend' }))
  await screen.findByText('Change cancelled.')
  expect(f.state.configuredBackend).toBe('local')
  expect(f.client.snapshot).toHaveBeenCalledOnce()
})
it.each(['write', 'readback'])('does not report success or upstream text after %s failure', async kind => {
  const f = fixture()

  if (kind === 'write') {vi.mocked(f.client.set).mockRejectedValue(new Error('https://private?api_key=secret'))}
  else
    {vi.mocked(f.client.snapshot)
      .mockResolvedValueOnce(structuredClone(f.state))
      .mockRejectedValueOnce(new Error('private'))}

  render(draw(f.client))
  await chooseDocker()
  fireEvent.click(screen.getByRole('button', { name: 'Apply: Terminal backend' }))
  await screen.findByRole('alert')
  expect(globalThis.document.body.textContent).not.toMatch(/private|api_key|secret/)
  expect(screen.queryByRole('combobox')).toBeNull()
  expect(screen.queryByText('Tool setting saved.')).toBeNull()
})
it('retires late write/readback when the selected agent changes', async () => {
  const first = fixture()
  const waiting = deferred<Awaited<ReturnType<MatrixToolSettingsClient['set']>>>()
  vi.mocked(first.client.set).mockReturnValue(waiting.promise)
  const view = render(draw(first.client))
  await chooseDocker()
  fireEvent.click(screen.getByRole('button', { name: 'Apply: Terminal backend' }))
  const next = fixture()
  view.rerender(draw(next.client, 'Babbage'))
  await screen.findByRole('combobox', { name: 'Terminal backend' })
  await act(async () => {
    waiting.resolve({ status: 'applied', field: 'terminal.backend', value: 'docker' })
  })
  expect(first.client.snapshot).toHaveBeenCalledOnce()
  expect(screen.queryByText('Tool setting saved.')).toBeNull()
})
it.each(Object.keys(matrixToolSettingsCopy) as (keyof typeof matrixToolSettingsCopy)[])(
  'localizes effects and native Allow in %s',
  async locale => {
    const f = fixture()
    render(
      <I18nProvider configClient={null} initialLocale={locale}>
        <MatrixToolSettings agentName="Ada" client={f.client} />
      </I18nProvider>
    )
    const copy = matrixToolSettingsCopy[locale]
    expect(await screen.findByRole('combobox', { name: copy.backend })).toBeTruthy()

    const confirmation = matrixToolSettingsConfirmationCopy(locale, 'Ada', {
      field: 'terminal.backend',
      value: 'docker'
    })

    expect(confirmation.allow).toBe(copy.allow)
    expect(confirmation.detail).toContain(copy.backendEffect)
  }
)
