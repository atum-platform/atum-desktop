// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import { matrixAuxiliaryCopy } from '../../shared/matrix-auxiliary-copy'
import { MATRIX_AUXILIARY_TASKS } from '../../shared/matrix-auxiliary-settings'
import type { MatrixAuxiliaryClient, MatrixAuxiliarySnapshot, MatrixAuxiliaryTask } from '../../shared/matrix-auxiliary-settings'

import { MatrixAuxiliarySettings } from './auxiliary-settings'

function facts(): MatrixAuxiliarySnapshot {
  return {
    tasks: MATRIX_AUXILIARY_TASKS.map(task => ({
      task,
      provider: task === 'vision' ? 'openrouter' : 'auto',
      model: task === 'vision' ? 'old-model' : ''
    })),
    providers: [{ id: 'openrouter', models: ['old-model', 'new-model'] }]
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void

  const promise = new Promise<T>(done => {
    resolve = done
  })

  return { promise, resolve }
}

function fixture() {
  const state = facts()

  const client: MatrixAuxiliaryClient = {
    snapshot: vi.fn(async () => structuredClone(state)),
    set: vi.fn(async (task: MatrixAuxiliaryTask, provider: string, model: string) => {
      Object.assign(state.tasks.find(row => row.task === task)!, { provider, model })

      return { status: 'applied' as const, task, provider, model }
    })
  }

  return { state, client }
}

function draw(client: MatrixAuxiliaryClient, agent = 'Ada') {
  return (
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixAuxiliarySettings agentName={agent} client={client} />
    </I18nProvider>
  )
}

async function choose(value: string, task = 'Vision') {
  fireEvent.click(await screen.findByRole('combobox', { name: `${task}: Choose model` }))
  fireEvent.click(await screen.findByRole('option', { name: value }))
}

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => {} })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('exposes server tasks, catalog choices and single-task return to automatic', async () => {
  const f = fixture()
  render(draw(f.client))

  for (const task of MATRIX_AUXILIARY_TASKS) {
    expect(
      await screen.findByRole('combobox', { name: `${matrixAuxiliaryCopy.en.tasks[task]}: Choose model` })
    ).toBeTruthy()
  }

  await choose('Automatic')
  await screen.findByText('Supporting model updated.')
  expect(f.client.set).toHaveBeenCalledExactlyOnceWith('vision', 'auto', '')
  expect(f.client.snapshot).toHaveBeenCalledTimes(2)
  const root = globalThis.document.querySelector('[data-matrix-auxiliary-settings]') as HTMLElement
  expect(within(root).queryByRole('textbox')).toBeNull()
  expect(within(root).queryByRole('button', { name: /reset|all tasks/i })).toBeNull()
})
it('displays normalized readback after a confirmed pin and never optimistic success', async () => {
  const f = fixture()
  const waiting = deferred<Awaited<ReturnType<MatrixAuxiliaryClient['set']>>>()
  vi.mocked(f.client.set).mockReturnValue(waiting.promise)
  render(draw(f.client))
  await choose('openrouter / new-model')
  expect(screen.queryByText('Supporting model updated.')).toBeNull()
  expect((screen.getByRole('combobox', { name: 'Vision: Choose model' }) as HTMLButtonElement).disabled).toBe(true)
  Object.assign(f.state.tasks[0], { provider: 'openrouter', model: 'new-model' })
  await act(async () => {
    waiting.resolve({ status: 'applied', task: 'vision', provider: 'openrouter', model: 'new-model' })
  })
  await screen.findByText('Supporting model updated.')
  expect(screen.getByRole('combobox', { name: 'Vision: Choose model' }).textContent).toContain('new-model')
})
it('keeps server truth after native cancellation', async () => {
  const f = fixture()
  vi.mocked(f.client.set).mockResolvedValue({ status: 'cancelled' })
  render(draw(f.client))
  await choose('Automatic')
  await screen.findByText('Change cancelled.')
  expect(screen.getByRole('combobox', { name: 'Vision: Choose model' }).textContent).toContain('old-model')
  expect(f.client.snapshot).toHaveBeenCalledOnce()
})
it('drops unverified values and never displays upstream secrets or endpoints', async () => {
  const f = fixture()
  vi.mocked(f.client.set).mockRejectedValue(new Error('https://private?api_key=secret'))
  render(draw(f.client))
  await choose('Automatic')
  await screen.findByRole('alert')
  expect(globalThis.document.body.textContent).toContain(matrixAuxiliaryCopy.en.saveError)
  expect(globalThis.document.body.textContent).not.toMatch(/private|api_key|secret/)
  expect(screen.queryByRole('combobox')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  await screen.findByRole('combobox', { name: 'Vision: Choose model' })
})
it('retires late writes when the selected agent changes', async () => {
  const first = fixture()
  const waiting = deferred<Awaited<ReturnType<MatrixAuxiliaryClient['set']>>>()
  vi.mocked(first.client.set).mockReturnValue(waiting.promise)
  const view = render(draw(first.client))
  await choose('Automatic')
  const next = fixture()
  next.state.tasks[0].model = 'new-model'
  view.rerender(draw(next.client, 'Babbage'))
  await waitFor(() =>
    expect(screen.getByRole('combobox', { name: 'Vision: Choose model' }).textContent).toContain('new-model')
  )
  await act(async () => {
    waiting.resolve({ status: 'applied', task: 'vision', provider: 'auto', model: '' })
  })
  expect(screen.queryByText('Supporting model updated.')).toBeNull()
  expect(first.client.snapshot).toHaveBeenCalledOnce()
  expect(screen.getByRole('combobox', { name: 'Vision: Choose model' }).textContent).toContain('new-model')
})
it('does not claim success when refresh after write fails', async () => {
  const f = fixture()
  vi.mocked(f.client.snapshot).mockResolvedValueOnce(facts()).mockRejectedValueOnce(new Error('private'))
  render(draw(f.client))
  await choose('Automatic')
  await screen.findByText(matrixAuxiliaryCopy.en.saveError)
  expect(screen.queryByText('Supporting model updated.')).toBeNull()
  expect(screen.queryByRole('combobox')).toBeNull()
})
it.each(Object.keys(matrixAuxiliaryCopy) as (keyof typeof matrixAuxiliaryCopy)[])(
  'localizes task controls and native confirmation in %s',
  async locale => {
    const f = fixture()
    render(
      <I18nProvider configClient={null} initialLocale={locale}>
        <MatrixAuxiliarySettings agentName="Ada" client={f.client} />
      </I18nProvider>
    )

    for (const task of MATRIX_AUXILIARY_TASKS) {
      const copy = matrixAuxiliaryCopy[locale]
      expect(await screen.findByRole('combobox', { name: `${copy.tasks[task]}: ${copy.choose}` })).toBeTruthy()
    }
  }
)
