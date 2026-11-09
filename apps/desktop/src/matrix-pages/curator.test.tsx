import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixCuratorClient, MatrixCuratorStatus } from '../../shared/matrix-curator'
import { matrixCuratorCopy } from '../../shared/matrix-curator-copy'

import { MatrixCuratorControls } from './curator'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const value: MatrixCuratorStatus = {
  enabled: true,
  paused: false,
  consolidate: false,
  intervalHours: 168,
  lastRunAt: null,
  run: { state: 'unknown', lines: [], truncated: false }
}

function fixture(): MatrixCuratorClient {
  return { status: vi.fn(async () => value), act: vi.fn(async () => ({ status: 'cancelled' as const })) }
}

function draw(client: MatrixCuratorClient, agent = 'Ada', locale = 'en') {
  return (
    <I18nProvider configClient={null} initialLocale={locale as 'en'}>
      <MatrixCuratorControls agentName={agent} client={client} />
    </I18nProvider>
  )
}

it('mount only reads, cancellation keeps actual state, and failure never claims pause', async () => {
  const client = fixture()
  const view = render(draw(client))
  await screen.findByText(matrixCuratorCopy.en.active)
  expect(client.act).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: matrixCuratorCopy.en.pause }))
  await screen.findByText(matrixCuratorCopy.en.cancelled)
  expect(screen.getByText(matrixCuratorCopy.en.active)).toBeTruthy()
  vi.mocked(client.act).mockRejectedValue(new Error('private-provider-detail'))
  fireEvent.click(screen.getByRole('button', { name: matrixCuratorCopy.en.pause }))
  await screen.findByText(matrixCuratorCopy.en.unavailable)
  expect(screen.queryByText(matrixCuratorCopy.en.paused)).toBeNull()
  expect(view.baseElement.textContent).not.toContain('private-provider-detail')
  expect(client.act).toHaveBeenCalledTimes(2)
})
it('late mutation result cannot overwrite the new selected agent', async () => {
  const first = fixture()
  let finish!: (v: Awaited<ReturnType<MatrixCuratorClient['act']>>) => void
  vi.mocked(first.act).mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  const view = render(draw(first))
  await screen.findByText(matrixCuratorCopy.en.active)
  fireEvent.click(screen.getByRole('button', { name: matrixCuratorCopy.en.pause }))
  await waitFor(() => expect(first.act).toHaveBeenCalledOnce())
  view.rerender(draw(fixture(), 'Babbage'))
  await act(async () => {
    finish({ status: 'completed', value: { ...value, paused: true } })
  })
  await screen.findByText(matrixCuratorCopy.en.active)
  expect(screen.queryByText(matrixCuratorCopy.en.paused)).toBeNull()
})
it.each(Object.keys(matrixCuratorCopy))('renders consent consequences and actions in %s', async locale => {
  const client = fixture()
  render(draw(client, 'Ada', locale))
  await screen.findByText(matrixCuratorCopy[locale].active)
  expect(screen.getByText(matrixCuratorCopy[locale].warning)).toBeTruthy()
  expect(screen.getByRole('button', { name: matrixCuratorCopy[locale].run })).toBeTruthy()
})
