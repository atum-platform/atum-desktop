import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixDebugClient } from '../../shared/matrix-debug-share'
import { matrixDebugShareCopy } from '../../shared/matrix-debug-share-copy'
import type { MatrixPagesRequest } from '../../shared/matrix-pages'

import { MatrixDebugSharing } from './debug-share'
import { createMatrixDebugClient } from './debug-share-client'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function fixture(): MatrixDebugClient {
  return {
    status: vi.fn(async () => ({ state: 'unknown' as const, destination: null, urls: [], uncertainLabel: null })),
    preview: vi.fn(async () => ({
      files: [
        { label: 'report' as const, text: 'LOCAL_PREVIEW_END\n秘密 café', bytes: 30 },
        { label: 'agent.log' as const, text: 'FULL_LOG_END', bytes: 12 }
      ]
    })),
    upload: vi.fn(async () => ({ status: 'cancelled' as const })),
    open: vi.fn(),
    copy: vi.fn()
  }
}

function draw(client: MatrixDebugClient, name = 'Ada', locale = 'en') {
  return (
    <I18nProvider configClient={null} initialLocale={locale as 'en'}>
      <MatrixDebugSharing agentName={name} client={client} />
    </I18nProvider>
  )
}

it('opens without collection/upload, shows full local text, shares only selected files, cancellation keeps preview', async () => {
  const client = fixture()
  render(draw(client))
  await waitFor(() => expect(client.status).toHaveBeenCalledOnce())
  expect(client.preview).not.toHaveBeenCalled()
  expect(client.upload).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Capture local preview' }))
  await screen.findByText(/LOCAL_PREVIEW_END/)
  expect(screen.getByText(/秘密 café/)).toBeTruthy()
  expect(screen.getByText('FULL_LOG_END')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Share selected text…' }))
  await screen.findByText('Sharing cancelled. No upload was started.')
  expect(client.upload).toHaveBeenCalledExactlyOnceWith('paste.rs', ['report'])
  expect(screen.getByText('FULL_LOG_END')).toBeTruthy()
  fireEvent.click(screen.getByRole('checkbox', { name: /agent.log/ }))
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'dpaste.com' } })
  fireEvent.click(screen.getByRole('button', { name: 'Share selected text…' }))
  await waitFor(() => expect(client.upload).toHaveBeenLastCalledWith('dpaste.com', ['report', 'agent.log']))
})
it('late captured private text is retired across selected-agent change', async () => {
  const first = fixture()
  let finish!: (v: Awaited<ReturnType<MatrixDebugClient['preview']>>) => void
  vi.mocked(first.preview).mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  const view = render(draw(first))
  fireEvent.click(screen.getByRole('button', { name: 'Capture local preview' }))
  view.rerender(draw(fixture(), 'Babbage'))
  await act(async () => {
    finish({ files: [{ label: 'report', text: 'OLD_PRIVATE_PREVIEW', bytes: 19 }] })
  })
  expect(screen.queryByText('OLD_PRIVATE_PREVIEW')).toBeNull()
})
it('projects generic failure and does not retry a failed upload', async () => {
  const client = fixture()
  vi.mocked(client.upload).mockRejectedValue(new Error('private-api-key'))
  render(draw(client))
  fireEvent.click(screen.getByRole('button', { name: 'Capture local preview' }))
  await screen.findByText(/LOCAL_PREVIEW_END/)
  fireEvent.click(screen.getByRole('button', { name: 'Share selected text…' }))
  await screen.findByText(matrixDebugShareCopy.en.failed)
  expect(globalThis.document.body.textContent).not.toContain('private-api-key')
  expect(client.upload).toHaveBeenCalledOnce()
})
it.each(Object.keys(matrixDebugShareCopy))('renders privacy and retention in locale %s', async locale => {
  const client = fixture()
  render(draw(client, 'Ada', locale))
  expect(screen.getByRole('heading', { name: matrixDebugShareCopy[locale].title })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: matrixDebugShareCopy[locale].preview }))
  await screen.findByText(/LOCAL_PREVIEW_END/)
  expect(screen.getByText(matrixDebugShareCopy[locale].pasteRetention)).toBeTruthy()
})
it('client never supplies a preview token, raw URL, home or profile', async () => {
  const request = vi.fn(async (_value: MatrixPagesRequest) => ({}) as never)
  const client = createMatrixDebugClient(request)
  await client.preview()
  await client.upload('paste.rs', ['report'])
  await client.open('report')
  await client.copy('report')
  expect(request.mock.calls.map(([v]) => v)).toEqual([
    { path: '/api/command-center/debug-share/preview', method: 'POST' },
    {
      path: '/api/command-center/debug-share/upload',
      method: 'POST',
      body: { destination: 'paste.rs', labels: ['report'] }
    },
    { path: '/api/command-center/debug-share/open/report', method: 'POST' },
    { path: '/api/command-center/debug-share/copy/report', method: 'POST' }
  ])
})

it('clears a previous receipt while previewing a fresh bundle and can recover it explicitly', async () => {
  const client = fixture()
  vi.mocked(client.status).mockResolvedValue({
    state: 'succeeded',
    destination: 'paste.rs',
    uncertainLabel: null,
    urls: [{ label: 'report', url: 'https://paste.rs/previous' }]
  })
  render(draw(client))
  await screen.findByRole('button', { name: 'Open link' })
  fireEvent.click(screen.getByRole('button', { name: 'Capture local preview' }))
  await screen.findByText(/LOCAL_PREVIEW_END/)
  expect(screen.queryByRole('button', { name: 'Open link' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Check upload status' }))
  await screen.findByRole('button', { name: 'Open link' })
  expect(client.upload).not.toHaveBeenCalled()
})
