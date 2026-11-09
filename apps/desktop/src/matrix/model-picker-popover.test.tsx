import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import { ModelPickerPopover, pickerRouteOf } from './model-picker-popover'

beforeEach(() => {
  window.localStorage.clear()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
})

afterEach(async () => {
  cleanup()
  // Radix FocusScope dispatches its deferred unmount event before jsdom teardown.
  await new Promise<void>(resolve => setTimeout(resolve, 0))
  vi.unstubAllGlobals()
})

const ROUTES = [
  pickerRouteOf({ provider: 'atum', providerLabel: 'Atum', model: 'nguyet-thuc', name: 'Nguyệt Thực 1.3' }),
  pickerRouteOf({ provider: 'atum', providerLabel: 'Atum', model: 'nhat-thuc', name: 'Nhật Thực 1.1' }),
  pickerRouteOf({ provider: 'openai-codex', providerLabel: 'ChatGPT', model: 'gpt-6-luna', name: 'GPT-6 Luna' }),
  pickerRouteOf({ provider: 'openai-codex', providerLabel: 'ChatGPT', model: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' })
]

function show(props: Partial<Parameters<typeof ModelPickerPopover>[0]> = {}) {
  const onChoose = vi.fn()

  render(
    <I18nProvider configClient={null} initialLocale="en">
      <ModelPickerPopover
        currentId="atum:nguyet-thuc"
        label="Model"
        onChoose={onChoose}
        placeholder="Choose a model"
        routes={ROUTES}
        scope="popover-test"
        {...props}
      />
    </I18nProvider>
  )

  return { onChoose }
}

const open = async () => {
  fireEvent.click(screen.getByRole('button', { name: /^Model/ }))

  return screen.findByRole('dialog', { name: 'Model' })
}

const ids = (card: HTMLElement) =>
  [...card.querySelectorAll('[data-matrix-model-route]')].map(each => each.getAttribute('data-matrix-model-route'))

const rail = (card: HTMLElement, id: string) =>
  card.querySelector<HTMLButtonElement>(`[data-matrix-model-rail-item="${id}"]`)!

const star = (card: HTMLElement, id: string) =>
  card
    .querySelector(`[data-matrix-model-route="${id}"]`)!
    .parentElement!.querySelector<HTMLButtonElement>('[data-matrix-model-favorite]')!

describe('the shared model card for plain model lists (move flow, Advanced pages)', () => {
  it('opens on the current model’s provider and lists only that provider’s models', async () => {
    show({ currentId: 'openai-codex:gpt-6.1-sol' })
    const card = await open()

    expect(rail(card, 'openai-codex').getAttribute('aria-pressed')).toBe('true')
    expect(ids(card)).toEqual(['openai-codex:gpt-6-luna', 'openai-codex:gpt-6.1-sol'])

    fireEvent.click(rail(card, 'atum'))
    expect(ids(card)).toEqual(['atum:nguyet-thuc', 'atum:nhat-thuc'])
  })

  it('stars across providers and searches within the selected one', async () => {
    show()
    const card = await open()

    fireEvent.click(star(card, 'atum:nhat-thuc'))
    fireEvent.click(rail(card, 'openai-codex'))
    fireEvent.click(star(card, 'openai-codex:gpt-6.1-sol'))
    fireEvent.click(rail(card, 'favorites'))
    expect(ids(card)).toEqual(['atum:nhat-thuc', 'openai-codex:gpt-6.1-sol'])

    fireEvent.click(rail(card, 'openai-codex'))
    fireEvent.change(within(card).getByRole('textbox', { name: 'Search models…' }), { target: { value: 'luna' } })
    expect(ids(card)).toEqual(['openai-codex:gpt-6-luna'])
  })

  it('chooses in one click and has no rows at the foot of a list', async () => {
    const { onChoose } = show()
    const card = await open()

    expect(card.querySelector('[data-matrix-model-list] [data-matrix-model-connect]')).toBeNull()
    fireEvent.click(card.querySelector<HTMLElement>('[data-matrix-model-route="atum:nhat-thuc"]')!)
    expect(onChoose).toHaveBeenCalledWith(expect.objectContaining({ id: 'atum:nhat-thuc', model: 'nhat-thuc' }))
  })

  it('shows the rail’s Connect only where the surface can connect a service, and closes before it opens', async () => {
    show()
    let card = await open()
    expect(card.querySelector('[data-matrix-model-rail] [data-matrix-model-connect]')).toBeNull()
    cleanup()

    const onConnect = vi.fn()
    show({ onConnect })
    card = await open()
    fireEvent.click(card.querySelector<HTMLButtonElement>('[data-matrix-model-rail] [data-matrix-model-connect]')!)
    expect(onConnect).toHaveBeenCalledOnce()
  })
})
