import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixHermesSetupResult, MatrixUiBridge } from '../../shared/matrix'

import { HermesSetup } from './hermes-setup'
import { hermesSetupCopy } from './hermes-setup-copy'

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'atumMatrix')
})

function fixture(configure = vi.fn(async (): Promise<MatrixHermesSetupResult> => ({ state: 'ready' }))) {
  const cancelHermes = vi.fn(async () => {})
  window.atumMatrix = { configureHermes: configure, cancelHermes } as unknown as MatrixUiBridge
  render(
    <I18nProvider configClient={null} initialLocale="en">
      <HermesSetup status="ready" />
    </I18nProvider>
  )
  fireEvent.click(screen.getByText('Use your own model'))
  fireEvent.change(screen.getByLabelText('Service address'), {
    target: { value: 'https://model.example/v1' }
  })
  fireEvent.change(screen.getByLabelText('Model name'), { target: { value: 'test-model' } })
  fireEvent.change(screen.getByLabelText(/API key/), { target: { value: 'test-secret' } })

  return { configure, cancelHermes }
}

describe('local Hermes setup', () => {
  it('warns that paid Store items stop working before an assistant holding them switches to its own model', () => {
    window.atumMatrix = { configureHermes: vi.fn(), cancelHermes: vi.fn() } as unknown as MatrixUiBridge

    const { rerender } = render(
      <I18nProvider configClient={null} initialLocale="en">
        <HermesSetup paidItems status="ready" />
      </I18nProvider>
    )

    fireEvent.click(screen.getByText('Use your own model'))
    expect(screen.getByText(hermesSetupCopy.en.paidItems)).toBeTruthy()

    // Nothing paid, or already on its own model: no warning.
    rerender(
      <I18nProvider configClient={null} initialLocale="en">
        <HermesSetup status="ready" />
      </I18nProvider>
    )
    expect(screen.queryByText(hermesSetupCopy.en.paidItems)).toBeNull()
    rerender(
      <I18nProvider configClient={null} initialLocale="en">
        <HermesSetup ownModel paidItems status="ready" />
      </I18nProvider>
    )
    expect(screen.queryByText(hermesSetupCopy.en.paidItems)).toBeNull()

    for (const locale of ['vi', 'ja', 'zh', 'zh-hant'] as const) {
      expect(hermesSetupCopy[locale].paidItems).not.toBe('')
      expect(hermesSetupCopy[locale].paidItems).not.toBe(hermesSetupCopy.en.paidItems)
    }
  })
  it('requires explicit submission, shows honest readiness and clears the entered key', async () => {
    const f = fixture()
    expect(f.configure).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText('Saved. Your assistant now answers with your model.')
    expect(f.configure).toHaveBeenCalledWith({
      baseUrl: 'https://model.example/v1',
      model: 'test-model',
      apiKey: 'test-secret'
    })
    expect((screen.getByLabelText(/API key/) as HTMLInputElement).value).toBe('')
  })
  it('does not echo backend failure details or keep an entered key after failure', async () => {
    const f = fixture(
      vi.fn(async () => {
        throw new Error('provider leaked test-secret')
      })
    )

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText(/Saving didn’t finish/)
    expect(screen.queryByText(/provider leaked/)).toBeNull()
    expect((screen.getByLabelText(/API key/) as HTMLInputElement).value).toBe('')
    expect(f.configure).toHaveBeenCalledTimes(1)
  })
  it('reports owner cancellation distinctly and discloses key cleanup without history deletion', async () => {
    fixture(vi.fn(async () => ({ state: 'cancelled' })))
    expect(screen.getByText(/Signing out removes it; your chats stay/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText(/^Stopped\./)
    expect(screen.queryByText(/Saving didn’t finish/)).toBeNull()
    expect((screen.getByLabelText(/API key/) as HTMLInputElement).value).toBe('')
  })
  it('offers cancellation during helper installation and ignores completion after unmount', async () => {
    let finish!: (value: MatrixHermesSetupResult) => void

    const f = fixture(
      vi.fn(
        () =>
          new Promise(resolve => {
            finish = resolve
          })
      )
    )

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(f.cancelHermes).toHaveBeenCalledOnce())
    cleanup()
    await act(async () => finish({ state: 'ready' }))
    expect(screen.queryByText(/^Saved\. The connection/)).toBeNull()
  })
})

describe('which model the assistant answers with', () => {
  function draw(
    props: { atumModel?: boolean; ownModel?: boolean },
    useAtumModel?: () => Promise<MatrixHermesSetupResult>
  ) {
    window.atumMatrix = { configureHermes: vi.fn(), cancelHermes: vi.fn(), useAtumModel } as unknown as MatrixUiBridge
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <HermesSetup status="ready" {...props} />
      </I18nProvider>
    )
  }

  it('says it uses Atum’s AI, with a way to use a model of one’s own', () => {
    draw({ atumModel: true })
    expect(window.document.querySelector('[data-matrix-model-mode="atum"]')?.textContent).toContain('Atum’s AI')
    expect(screen.getByText('Use your own model')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Switch back to Atum’s AI' })).toBeNull()
  })

  it('says it uses the person’s own model and switches back to Atum’s AI on request', async () => {
    const useAtumModel = vi.fn(async (): Promise<MatrixHermesSetupResult> => ({ state: 'ready' }))
    draw({ ownModel: true }, useAtumModel)
    expect(window.document.querySelector('[data-matrix-model-mode="own"]')?.textContent).toContain('Your own model')
    expect(screen.getByText('Change your model')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Switch back to Atum’s AI' }))
    expect(useAtumModel).toHaveBeenCalledOnce()
    expect(await screen.findByText('Your assistant answers with Atum’s AI again.')).toBeTruthy()
  })

  it('says so when switching back does not finish', async () => {
    draw(
      { ownModel: true },
      vi.fn(async () => Promise.reject(new Error('busy')))
    )
    fireEvent.click(screen.getByRole('button', { name: 'Switch back to Atum’s AI' }))
    expect(await screen.findByText('Couldn’t switch back. Check your connection and try again.')).toBeTruthy()
  })
})
