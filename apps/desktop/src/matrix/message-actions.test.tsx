import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { AudioLines } from '@/lib/icons'

import { MatrixMessageContextMenu, MatrixMessageMenu, MatrixMessageToolbar } from './message-actions'

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

describe('message options at the pointer', () => {
  const message = (props: Partial<Parameters<typeof MatrixMessageMenu>[0]> = {}) => (
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixMessageContextMenu>
        <div data-testid="message">
          <p>The answer</p>
          <a href="https://example.org">a link</a>
          <MatrixMessageToolbar
            menu={<MatrixMessageMenu kind="answer" label="Message actions" text="The answer" {...props} />}
            onForward={props.onForward}
            placement="corner"
          />
        </div>
      </MatrixMessageContextMenu>
    </I18nProvider>
  )

  // Radix places the menu's wrapper with a translate from the anchor it was given.
  const menuOffset = async () => {
    const content = await screen.findByRole('menu')
    const wrapper = content.closest<HTMLElement>('[data-radix-popper-content-wrapper]')!

    await waitFor(() => expect(wrapper.style.transform).toMatch(/translate\(/u))

    const [, x, y] = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/u.exec(wrapper.style.transform)!

    return { x: Number(x), y: Number(y) }
  }

  it('opens the same options where the message was right-clicked, not at the "…"', async () => {
    render(message({ onRetry: vi.fn() }))

    expect(fireEvent.contextMenu(screen.getByText('The answer'), { button: 2, clientX: 140, clientY: 260 })).toBe(false)
    const menu = await screen.findByRole('menu')
    expect(menu.hasAttribute('data-matrix-message-context-menu')).toBe(true)
    expect(within(menu).getByRole('menuitem', { name: 'Copy' })).toBeTruthy()
    expect(within(menu).getByRole('menuitem', { name: 'Retry' })).toBeTruthy()

    const { x, y } = await menuOffset()
    // At the pointer (Radix sets it a couple of pixels to the side), never at the toolbar's corner.
    expect(Math.abs(x - 140)).toBeLessThanOrEqual(4)
    expect(Math.abs(y - 260)).toBeLessThanOrEqual(4)
  })

  it('keeps the "…" opening its own menu, anchored to itself', async () => {
    render(message())

    fireEvent.keyDown(screen.getByRole('button', { name: 'Message actions' }), { key: 'Enter' })
    const menu = await screen.findByRole('menu')
    expect(menu.hasAttribute('data-matrix-message-context-menu')).toBe(false)
    expect(within(menu).getByRole('menuitem', { name: 'Copy' })).toBeTruthy()
  })

  it('opens the options from the keyboard (Shift+F10) on the focused message', async () => {
    render(message())

    const more = screen.getByRole('button', { name: 'Message actions' })
    more.focus()
    fireEvent.keyDown(more, { key: 'F10', shiftKey: true })
    const menu = await screen.findByRole('menu')
    expect(menu.hasAttribute('data-matrix-message-context-menu')).toBe(true)
  })

  it('leaves a link its own browser menu', () => {
    render(message())

    expect(fireEvent.contextMenu(screen.getByText('a link'))).toBe(true)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('forwards with the forward arrow, in the toolbar and in the menu', async () => {
    const onForward = vi.fn()
    render(message({ onForward }))

    const toolbarForward = screen.getByRole('button', { name: 'Forward' })
    expect(toolbarForward.querySelector('svg')!.classList.contains('atum-icon-share-fat')).toBe(true)

    fireEvent.contextMenu(screen.getByText('The answer'), { clientX: 10, clientY: 10 })
    const item = await screen.findByRole('menuitem', { name: 'Forward' })
    expect(item.querySelector('svg')!.classList.contains('atum-icon-share-fat')).toBe(true)
    fireEvent.click(item)
    expect(onForward).toHaveBeenCalledOnce()
  })
})

describe('reactions inside the message options', () => {
  const reactions = [
    { key: '👍', count: 2, own: false, senders: ['@a:test', '@b:test'] },
    { key: '❤️', count: 1, own: true, senders: ['@you:test'] }
  ]

  const openDropdown = () => {
    fireEvent.keyDown(screen.getByRole('button', { name: 'Message actions' }), { key: 'Enter' })

    return screen.findByRole('menu')
  }

  it('reacts from the "…" menu with the same toggle the hover picker calls', async () => {
    const onReact = vi.fn()
    render(menu({ react: { reactions: [...reactions], onReact } }))

    const dropdown = await openDropdown()
    const row = within(dropdown).getByRole('group', { name: 'React' })
    expect(row.querySelectorAll('[role=menuitemcheckbox]')).toHaveLength(6)

    const mine = within(row).getByRole('menuitemcheckbox', { name: 'React with ❤️' })
    expect(mine.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(mine)
    expect(onReact).toHaveBeenCalledExactlyOnceWith('❤️', false)

    expect(screen.queryByRole('menu')).toBeNull()
    const reopened = await openDropdown()
    fireEvent.click(within(reopened).getByRole('menuitemcheckbox', { name: 'React with 😂' }))
    expect(onReact).toHaveBeenCalledTimes(2)
    expect(onReact).toHaveBeenLastCalledWith('😂', true)
  })

  it('reacts from the right-click menu with the same row, above Copy', async () => {
    const onReact = vi.fn()
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixMessageContextMenu>
          <div data-testid="message">
            <p>The answer</p>
            <MatrixMessageToolbar
              menu={
                <MatrixMessageMenu
                  kind="answer"
                  label="Message actions"
                  react={{ reactions: [...reactions], onReact }}
                  text="The answer"
                />
              }
              placement="corner"
            />
          </div>
        </MatrixMessageContextMenu>
      </I18nProvider>
    )

    expect(fireEvent.contextMenu(screen.getByText('The answer'), { button: 2, clientX: 140, clientY: 260 })).toBe(false)
    const context = await screen.findByRole('menu')
    expect(context.hasAttribute('data-matrix-message-context-menu')).toBe(true)

    const row = within(context).getByRole('group', { name: 'React' })
    expect(
      row.compareDocumentPosition(within(context).getByRole('menuitem', { name: 'Copy' })) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    fireEvent.click(within(row).getByRole('menuitemcheckbox', { name: 'React with 👍' }))
    expect(onReact).toHaveBeenCalledExactlyOnceWith('👍', true)
  })

  it.each([['dropdown', 'Enter'], ['dropdown', ' '], ['context', 'Enter'], ['context', ' ']] as const)('traverses reactions and toggles once in the %s menu with %s', async (surface, key) => {
    const onReact = vi.fn()
    const content = menu({ react: { reactions, onReact } })
    render(surface === 'context' ? <MatrixMessageContextMenu><div>{content}</div></MatrixMessageContextMenu> : content)
    const trigger = screen.getByRole('button', { name: 'Message actions' })
    trigger.focus()
    fireEvent.keyDown(trigger, surface === 'context' ? { key: 'F10', shiftKey: true } : { key: 'Enter' })
    const opened = await screen.findByRole('menu')
    const items = within(opened).getAllByRole('menuitemcheckbox')
    await waitFor(() => expect(window.document.activeElement).toBe(items[0]))
    expect(fireEvent.keyDown(items[0]!, { key: 'Tab' })).toBe(false)
    for (const item of items.slice(1)) {
      fireEvent.keyDown(window.document.activeElement!, { key: 'ArrowDown' })
      await waitFor(() => expect(window.document.activeElement).toBe(item))
    }
    for (const item of items.slice(0, -1).reverse()) {
      fireEvent.keyDown(window.document.activeElement!, { key: 'ArrowUp' })
      await waitFor(() => expect(window.document.activeElement).toBe(item))
    }
    fireEvent.keyDown(items[0]!, { key: 'ArrowDown' })
    await waitFor(() => expect(window.document.activeElement).toBe(items[1]))
    fireEvent.keyDown(items[1]!, { key })
    expect(onReact).toHaveBeenCalledExactlyOnceWith('❤️', false)
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  })

  it('updates the checked reaction from the caller projection without sending another toggle', async () => {
    const onReact = vi.fn()
    const view = render(menu({ react: { reactions, onReact } }))
    await openDropdown()
    expect(screen.getByRole('menuitemcheckbox', { name: 'React with ❤️' }).getAttribute('aria-checked')).toBe('true')
    view.rerender(menu({ react: { reactions: reactions.map(reaction => ({ ...reaction, own: false })), onReact } }))
    expect(screen.getByRole('menuitemcheckbox', { name: 'React with ❤️' }).getAttribute('aria-checked')).toBe('false')
    expect(onReact).not.toHaveBeenCalled()
  })

  it('shows no reaction row when the message cannot take one', async () => {
    render(menu())

    const dropdown = await openDropdown()
    expect(within(dropdown).queryByRole('group', { name: 'React' })).toBeNull()


  })
})
