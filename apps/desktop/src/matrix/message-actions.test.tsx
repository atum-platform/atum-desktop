import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { AudioLines } from '@/lib/icons'

import { MatrixMessageMenu, MatrixMessageToolbar } from './message-actions'

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'atumMatrix')
})

const menu = (props: Partial<Parameters<typeof MatrixMessageMenu>[0]> = {}) => (
  <I18nProvider configClient={null} initialLocale="en">
    <MatrixMessageMenu kind="answer" label="Message actions" text="The answer" {...props} />
  </I18nProvider>
)

describe('answer menu', () => {
  it('copies the stable Team space link separately from the message text', async () => {
    const writeText = vi.fn(async () => {})
    window.atumMatrix = { clipboard: { writeText } } as never
    render(menu({ link: 'atum://message/v1/opaque' }))

    fireEvent.keyDown(screen.getByRole('button', { name: 'Message actions' }), { key: 'Enter' })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy link' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith('atum://message/v1/opaque'))
  })

  it('offers the caller-owned Save or Unsave action and disables it while the account write is pending', () => {
    const onSelect = vi.fn()

    const { rerender } = render(menu({
      saved: { active: false, busy: false, label: 'Save message', onSelect }
    }))

    fireEvent.keyDown(screen.getByRole('button', { name: 'Message actions' }), { key: 'Enter' })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save message' }))
    expect(onSelect).toHaveBeenCalledOnce()

    rerender(menu({
      saved: { active: true, busy: true, label: 'Remove from Saved', onSelect }
    }))
    fireEvent.keyDown(screen.getByRole('button', { name: 'Message actions' }), { key: 'Enter' })
    expect(screen.getByRole('menuitem', { name: 'Remove from Saved' }).hasAttribute('data-disabled')).toBe(true)
  })

  it('offers Copy, Read aloud and Retry, and only the ones that exist', () => {
    const onSelect = vi.fn()
    const onRetry = vi.fn()

    const { rerender } = render(
      menu({
        onRetry,
        readAloud: { Icon: AudioLines, busy: false, label: 'Read aloud', onSelect, preparing: false }
      })
    )

    fireEvent.keyDown(screen.getByRole('button', { name: 'Message actions' }), { key: 'Enter' })
    expect(screen.getByRole('menuitem', { name: 'Copy' })).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Read aloud' }))
    expect(onSelect).toHaveBeenCalledOnce()

    rerender(menu({ retryDisabled: true, onRetry }))
    fireEvent.keyDown(screen.getByRole('button', { name: 'Message actions' }), { key: 'Enter' })
    expect(screen.queryByRole('menuitem', { name: 'Read aloud' })).toBeNull()
    expect(screen.getByRole('menuitem', { name: 'Retry' }).hasAttribute('data-disabled')).toBe(true)
  })

  it('disables Read aloud while another message is playing', () => {
    render(
      menu({
        readAloud: { Icon: AudioLines, busy: true, label: 'Read aloud', onSelect: vi.fn(), preparing: false }
      })
    )
    fireEvent.keyDown(screen.getByRole('button', { name: 'Message actions' }), { key: 'Enter' })
    expect(screen.getByRole('menuitem', { name: 'Read aloud' }).hasAttribute('data-disabled')).toBe(true)
  })

  it('shows only the authorized shared pin action and switches it to unpin for a pinned message', () => {
    const onPin = vi.fn()
    const { rerender } = render(menu())

    fireEvent.keyDown(screen.getByRole('button', { name: 'Message actions' }), { key: 'Enter' })
    expect(screen.queryByRole('menuitem', { name: 'Pin message' })).toBeNull()

    rerender(menu({ onPin }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pin message' }))
    expect(onPin).toHaveBeenCalledOnce()

    rerender(menu({ onPin, pinned: true }))
    fireEvent.keyDown(screen.getByRole('button', { name: 'Message actions' }), { key: 'Enter' })
    expect(screen.getByRole('menuitem', { name: 'Unpin message' })).toBeTruthy()
  })
})

describe('report menu', () => {
  it('reports a message with the person’s optional reason, from one short dialog', async () => {
    const onReport = vi.fn(async (_reason?: string) => {})
    render(menu({ kind: 'report', onReport }))

    fireEvent.keyDown(screen.getByRole('button', { name: 'Message actions' }), { key: 'Enter' })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Report' }))
    const dialog = screen.getByRole('dialog', { name: 'Report this message?' })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Reason (optional)' }), {
      target: { value: 'threats' }
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Report' }))
    await waitFor(() => expect(onReport).toHaveBeenCalledExactlyOnceWith('threats'))
  })
})

describe('message toolbar', () => {
  it('stays in view while the answer is read aloud, so the way to stop it is reachable', () => {
    const { container, rerender } = render(<MatrixMessageToolbar menu={<span />} placement="corner" />)
    const toolbar = () => container.querySelector<HTMLElement>('[data-matrix-message-toolbar]')!

    expect(toolbar().hasAttribute('data-reading')).toBe(false)
    expect(toolbar().classList.contains('opacity-0')).toBe(true)

    rerender(<MatrixMessageToolbar menu={<span />} placement="corner" reading />)
    expect(toolbar().hasAttribute('data-reading')).toBe(true)
    expect(toolbar().classList.contains('opacity-100')).toBe(true)
  })
})
