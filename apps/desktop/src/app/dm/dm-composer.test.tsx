import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import type { AtumMessagingClient } from '@/lib/atum-messaging-client'
import { resetAtumMessagingState, setAtumDraft } from '@/store/atum-messaging'
import { $workspaceOpen, setWorkspaceOpen } from '@/store/atum-shell'
import { $workbenchTabs, resetWorkbenchTabs } from '@/store/workbench-tabs'

import { DmComposer } from './dm-composer'

const legacyMentionProps = {
  mentionEnabled: true,
  mentionTargetState: 'legacy' as const,
  mentionTargets: [
    { target: { type: 'assistant' as const, id: 'binh-minh' }, revision: 0, displayName: 'Atum', avatar: '' }
  ]
}

let sendTyping = vi.fn()

beforeEach(() => {
  resetAtumMessagingState()
  resetWorkbenchTabs()
  setWorkspaceOpen(false)
  sendTyping = vi.fn()
  Object.assign(window, {
    hermesDesktop: {
      messaging: { saveDraft: vi.fn().mockResolvedValue({}), sendTyping } as unknown as AtumMessagingClient
    }
  })
})

afterEach(cleanup)

function renderComposer(onSend = vi.fn()) {
  return {
    onSend,
    ...render(
      <I18nProvider configClient={null} initialLocale="vi">
        <DmComposer conversationId="conversation-1" disabled={false} onSend={onSend} />
      </I18nProvider>
    )
  }
}

describe('DmComposer', () => {
  it('retains an editable draft while connection readiness blocks sending', () => {
    const onSend = vi.fn()

    const view = (sendDisabled: boolean) => (
      <I18nProvider configClient={null} initialLocale="vi">
        <DmComposer conversationId="conversation-1" disabled={false} onSend={onSend} sendDisabled={sendDisabled} />
      </I18nProvider>
    )

    const { rerender } = render(view(true))
    const composer = screen.getByRole('textbox', { name: 'Nhắn tin...' }) as HTMLTextAreaElement
    fireEvent.change(composer, { target: { value: 'My draft' } })
    fireEvent.keyDown(composer, { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
    expect(composer.value).toBe('My draft')
    rerender(view(false))
    expect(onSend).not.toHaveBeenCalled()
    expect(composer.value).toBe('My draft')
    fireEvent.keyDown(composer, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledOnce()
  })

  it('offers and selects Atum as a highlighted structured mention in human DMs', () => {
    const { rerender } = render(
      <I18nProvider configClient={null} initialLocale="vi">
        <DmComposer conversationId="conversation-1" disabled={false} {...legacyMentionProps} />
      </I18nProvider>
    )

    const composer = screen.getByRole('textbox', { name: 'Nhắn tin...' })
    fireEvent.change(composer, { target: { value: 'Chào @', selectionStart: 6 } })
    expect(screen.getByRole('option', { name: /Atum/ })).toBeTruthy()
    fireEvent.mouseDown(screen.getByRole('option', { name: /Atum/ }))
    expect((composer as HTMLTextAreaElement).value).toBe('Chào @Atum ')
    expect(screen.getByText('@Atum', { selector: 'mark' })).toBeTruthy()
    expect(screen.getByText(/chỉ tin nhắn này/)).toBeTruthy()

    rerender(
      <I18nProvider configClient={null} initialLocale="vi">
        <DmComposer conversationId="conversation-2" disabled={false} {...legacyMentionProps} />
      </I18nProvider>
    )
    expect(screen.queryByText(/chỉ tin nhắn này/)).toBeNull()
  })

  it('disables attaching once a mention is armed, since the two cannot travel together', () => {
    const { container } = render(
      <I18nProvider configClient={null} initialLocale="vi">
        <DmComposer conversationId="conversation-1" disabled={false} {...legacyMentionProps} />
      </I18nProvider>
    )

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement
    expect(fileInput.disabled).toBe(false)

    const composer = screen.getByRole('textbox', { name: 'Nhắn tin...' })
    fireEvent.change(composer, { target: { value: 'Chào @', selectionStart: 6 } })
    fireEvent.mouseDown(screen.getByRole('option', { name: /Atum/ }))

    expect(fileInput.disabled).toBe(true)
  })

  it('retracts an open mention popover when an upload starts', () => {
    const { container } = render(
      <I18nProvider configClient={null} initialLocale="vi">
        <DmComposer conversationId="conversation-1" disabled={false} {...legacyMentionProps} />
      </I18nProvider>
    )

    const composer = screen.getByRole('textbox', { name: 'Nhắn tin...' })
    fireEvent.change(composer, { target: { value: 'Chào @', selectionStart: 6 } })
    expect(screen.getByRole('option', { name: /Atum/ })).toBeTruthy()

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(fileInput, { target: { files: [new File([new Uint8Array(4)], 'a.png', { type: 'image/png' })] } })

    // Disabling the control cannot retract a list that is already on screen.
    expect(screen.queryByRole('option', { name: /Atum/ })).toBeNull()
  })

  it('does not offer mentions when the conversation disables the affordance', () => {
    renderComposer()
    const composer = screen.getByRole('textbox', { name: 'Nhắn tin...' })
    fireEvent.change(composer, { target: { value: '@', selectionStart: 1 } })
    expect(screen.queryByRole('option')).toBeNull()
  })

  it('keeps two same-label assistant selections distinct and drops only the edited token', () => {
    const targets = [
      {
        target: { type: 'assistant' as const, id: '00000000-0000-4000-8000-bd7662a5eeb4' },
        revision: 1,
        displayName: 'Mai',
        avatar: '1'
      },
      {
        target: { type: 'assistant' as const, id: '00000000-0000-4000-8000-b454f82c5857' },
        revision: 1,
        displayName: 'Mai',
        avatar: '2'
      }
    ]

    const { container } = render(
      <I18nProvider configClient={null} initialLocale="vi">
        <DmComposer
          conversationId="conversation-1"
          disabled={false}
          mentionEnabled
          mentionTargets={targets}
          mentionTargetState="ready"
        />
      </I18nProvider>
    )

    const composer = screen.getByRole('textbox', { name: 'Nhắn tin...' }) as HTMLTextAreaElement

    fireEvent.change(composer, { target: { value: '@', selectionStart: 1 } })
    fireEvent.mouseDown(screen.getAllByRole('option', { name: /Mai/ })[0]!)
    const secondDraft = `${composer.value} và @`
    fireEvent.change(composer, { target: { value: secondDraft, selectionStart: secondDraft.length } })
    fireEvent.mouseDown(screen.getAllByRole('option', { name: /Mai/ })[1]!)
    expect(container.querySelectorAll('mark')).toHaveLength(2)

    fireEvent.change(composer, { target: { value: ' và @Mai ', selectionStart: 0 } })
    expect(container.querySelectorAll('mark')).toHaveLength(1)
  })

  it('leaves a typed literal unarmed and does not use an implicit legacy roster', () => {
    const { container } = render(
      <I18nProvider configClient={null} initialLocale="vi">
        <DmComposer conversationId="conversation-1" disabled={false} mentionEnabled />
      </I18nProvider>
    )

    const composer = screen.getByRole('textbox', { name: 'Nhắn tin...' }) as HTMLTextAreaElement
    fireEvent.change(composer, { target: { value: '@Atum', selectionStart: 5 } })

    expect(container.querySelectorAll('mark')).toHaveLength(0)
    expect(screen.queryByRole('option')).toBeNull()
  })

  it('keeps an explicit app quote visible and requires an addressed target before sending', () => {
    const clearQuote = vi.fn()
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <DmComposer
          conversationId="conversation-1"
          disabled={false}
          mentionEnabled
          mentionTargets={[
            {
              target: { type: 'specialist', id: 'moon' },
              revision: 1,
              displayName: 'Moon',
              avatar: '☾',
              availability: 'available'
            }
          ]}
          mentionTargetState="ready"
          onClearQuote={clearQuote}
          quotedMessage={{ messageId: 'message-1', sourceVersion: 1, preview: 'Share this deliberately.' }}
          specialistAddressingEnabled
        />
      </I18nProvider>
    )

    expect(screen.getByText(/Share this deliberately/)).toBeTruthy()
    const composer = screen.getByRole('textbox')
    fireEvent.change(composer, { target: { value: 'Please help', selectionStart: 11 } })
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(composer, { target: { value: '@', selectionStart: 1 } })
    fireEvent.mouseDown(screen.getByRole('option', { name: /Moon/ }))
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Remove quote' }))
    expect(clearQuote).toHaveBeenCalledWith({
      messageId: 'message-1',
      sourceVersion: 1,
      preview: 'Share this deliberately.'
    })
  })

  it('shows shared-group disclosure and keeps a listed foreign agent unavailable for invocation', () => {
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <DmComposer
          conversationId="conversation-1"
          disabled={false}
          mentionEnabled
          mentionTargets={[
            {
              target: { type: 'assistant', id: 'owner-agent' },
              revision: 1,
              displayName: 'Owner agent',
              avatar: '◌',
              availability: 'available'
            },
            {
              target: { type: 'assistant', id: 'foreign-agent' },
              revision: 1,
              displayName: 'Lan agent',
              avatar: '◒',
              availability: 'assistant_not_owned'
            }
          ]}
          mentionTargetState="ready"
          sharedGroup
          specialistAddressingEnabled
        />
      </I18nProvider>
    )

    const composer = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(composer, { target: { value: '@', selectionStart: 1 } })

    const foreign = screen.getByRole('option', { name: /Lan agent/ }) as HTMLButtonElement
    expect(foreign.disabled).toBe(true)
    fireEvent.mouseDown(screen.getByRole('option', { name: /Owner agent/ }))

    expect(composer.value).toBe('@Owner agent ')
    expect(screen.getByRole('status', { name: '' }).getAttribute('data-dm-assistant-context')).toBe('shared-group')
    expect(screen.getByText(/recent group history and an approved shared identity/)).toBeTruthy()
  })

  it.each(([
    ['specialist', 'not_linked', 'This app is not linked'],
    ['specialist', 'unsupported', 'This app does not support room messages'],
    ['specialist', 'not_registered', 'Unavailable'],
    ['specialist', 'unavailable', 'Unavailable'],
    ['assistant', 'unavailable', 'Unavailable'],
    ['assistant', 'not_linked', 'Unavailable']
  ] as const).flatMap(([type, availability, reason]) =>
    (['private', 'shared', 'ordinary'] as const).map(mode => [type, availability, reason, mode] as const)
  ))('keeps other participants selectable beside %s/%s (%s, %s room)', (type, availability, reason, mode) => {
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <DmComposer
          conversationId="conversation-1"
          disabled={false}
          mentionCardinality={1}
          mentionEnabled
          mentionTargets={[
            { target: { type, id: 'unavailable-participant' }, revision: 1, displayName: 'Participant', avatar: '', availability },
            { target: { type: 'assistant', id: 'owner-agent' }, revision: 1, displayName: 'Atum', avatar: '', availability: 'available' }
          ]}
          mentionTargetState="ready"
          privateAdvisory={mode === 'private'}
          sharedGroup={mode === 'shared'}
          specialistAddressingEnabled
        />
      </I18nProvider>
    )
    const composer = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(composer, { target: { value: '@', selectionStart: 1 } })
    const unavailable = screen.getByRole('option', { name: /Participant/ }) as HTMLButtonElement

    expect(unavailable.disabled).toBe(true)
    expect(unavailable.querySelector('small')?.textContent).toBe(reason)
    fireEvent.mouseDown(unavailable)
    expect(composer.value).toBe('@')
    // The one-mention limit must not truncate the choice list to its first row.
    fireEvent.mouseDown(screen.getByRole('option', { name: /Atum/ }))
    expect(composer.value).toBe('@Atum ')
    fireEvent.change(composer, { target: { value: '@Atum @', selectionStart: 7 } })
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it.each(['Enter', 'Tab'])('selects the first invocable participant with %s', key => {
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <DmComposer
          conversationId="conversation-1"
          disabled={false}
          mentionCardinality={1}
          mentionEnabled
          mentionTargets={[
            { target: { type: 'specialist', id: 'moon' }, revision: 1, displayName: 'Moon', avatar: '', availability: 'not_linked' },
            { target: { type: 'assistant', id: 'owner-agent' }, revision: 1, displayName: 'Atum', avatar: '', availability: 'available' }
          ]}
          mentionTargetState="ready"
          privateAdvisory
          specialistAddressingEnabled
        />
      </I18nProvider>
    )
    const composer = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(composer, { target: { value: '@', selectionStart: 1 } })
    expect((screen.getByRole('option', { name: /Moon/ }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.keyDown(composer, { key })
    expect(composer.value).toBe('@Atum ')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('sends on Enter without inserting a line break', () => {
    const { onSend } = renderComposer()
    const composer = screen.getByRole('textbox', { name: 'Nhắn tin...' })
    fireEvent.change(composer, { target: { value: 'xin chào' } })
    fireEvent.keyDown(composer, { key: 'Enter', shiftKey: false })
    expect(onSend).toHaveBeenCalledWith('xin chào')
  })

  it('keeps Shift+Enter for a newline and does not send', () => {
    const { onSend } = renderComposer()
    const composer = screen.getByRole('textbox', { name: 'Nhắn tin...' })
    fireEvent.change(composer, { target: { value: 'line one' } })
    fireEvent.keyDown(composer, { key: 'Enter', shiftKey: true })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('restores the conversation draft and persists it on blur', () => {
    setAtumDraft('conversation-1', 'bản nháp')
    renderComposer()
    const composer = screen.getByRole('textbox', { name: 'Nhắn tin...' })
    expect((composer as HTMLTextAreaElement).value).toBe('bản nháp')
    fireEvent.blur(composer)
    expect(window.hermesDesktop.messaging.saveDraft).toHaveBeenCalledWith('conversation-1', { text: 'bản nháp' })
  })

  it('disables the composer for expired/error states supplied by the view', () => {
    render(
      <I18nProvider configClient={null} initialLocale="vi">
        <DmComposer conversationId="conversation-1" disabled />
      </I18nProvider>
    )
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Gửi' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows contextual reconnecting copy without disabling queued composition', () => {
    render(
      <I18nProvider configClient={null} initialLocale="vi">
        <DmComposer conversationId="conversation-1" disabled={false} placeholder="Đang kết nối lại…" />
      </I18nProvider>
    )

    const composer = screen.getByRole('textbox') as HTMLTextAreaElement
    expect(composer.placeholder).toBe('Đang kết nối lại…')
    expect(composer.disabled).toBe(false)
  })

  it('shows composer-placed routes only with declared app routes and opens an app view in the conversation scope', async () => {
    const routes = {
      app: 'moon',
      launch: true,
      routes: [
        {
          id: 'chart',
          label: { vi: 'Lá số', en: 'Chart' },
          icon: 'starmap',
          placements: ['composer' as const],
          session: 'required' as const
        },
        {
          id: 'pricing',
          label: { vi: 'Giá', en: 'Pricing' },
          icon: 'tag',
          placements: ['menu' as const],
          session: 'none' as const
        }
      ]
    }

    render(
      <I18nProvider configClient={null} initialLocale="vi">
        <DmComposer accountId="account-1" appRoutes={routes} conversationId="conversation-1" disabled={false} />
      </I18nProvider>
    )
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Thêm' }))
    expect(screen.queryByRole('menuitem', { name: 'Giá' })).toBeNull()
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Lá số' }))

    // Only {app, route_id} is remembered: no URL, origin, or path.
    const tab = $workbenchTabs.get().find(entry => entry.scopeKey === 'atum-dm:account-1:conversation-1')
    expect(tab).toMatchObject({ surface: { app: 'moon', kind: 'app-view', routeId: 'chart' }, title: 'Lá số' })
    expect(JSON.stringify(tab)).not.toContain('moon.example')
    expect($workspaceOpen.get()).toBe(true)
  })

  it('renders exactly one "+" menu, on the left of the text, with image attach inside it and no app section without a surface', async () => {
    const { container } = renderComposer()
    const plus = screen.getByRole('button', { name: 'Thêm' })
    const textbox = screen.getByRole('textbox')
    const send = screen.getByRole('button', { name: 'Gửi' })

    expect(container.querySelectorAll('[aria-label="Thêm"]')).toHaveLength(1)
    expect(container.querySelector('label[aria-label="Đính kèm ảnh"]')).toBeNull()
    // DOM order is layout order: plus, text, send.
    expect(plus.compareDocumentPosition(textbox) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(textbox.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    const click = vi.spyOn(input, 'click')

    fireEvent.pointerDown(plus)
    expect(screen.queryByRole('separator')).toBeNull()
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Đính kèm ảnh' }))
    expect(click).toHaveBeenCalledTimes(1)
  })

  it('stops pinging typing once the composer is gone', () => {
    vi.useFakeTimers()

    try {
      const { unmount } = renderComposer()
      fireEvent.change(screen.getByRole('textbox', { name: 'Nhắn tin...' }), {
        target: { value: 'đang gõ', selectionStart: 7 }
      })
      expect(sendTyping).toHaveBeenLastCalledWith('conversation-1', true)

      unmount()
      const pingsAtUnmount = sendTyping.mock.calls.length
      vi.advanceTimersByTime(5_000)

      // A debounced ping that survives unmount reaches for a renderer that no
      // longer exists — in the suite that is a ReferenceError raised after the
      // environment is torn down, so no timer may outlive the component.
      expect(sendTyping.mock.calls.slice(pingsAtUnmount)).toEqual([])
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not report the previous conversation idle after switching away from it', () => {
    vi.useFakeTimers()

    try {
      const { rerender } = render(
        <I18nProvider configClient={null} initialLocale="vi">
          <DmComposer conversationId="conversation-1" disabled={false} />
        </I18nProvider>
      )

      fireEvent.change(screen.getByRole('textbox', { name: 'Nhắn tin...' }), {
        target: { value: 'đang gõ', selectionStart: 7 }
      })

      rerender(
        <I18nProvider configClient={null} initialLocale="vi">
          <DmComposer conversationId="conversation-2" disabled={false} />
        </I18nProvider>
      )
      const pingsAtSwitch = sendTyping.mock.calls.length
      vi.advanceTimersByTime(5_000)

      expect(sendTyping.mock.calls.slice(pingsAtSwitch)).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('lists app actions before the attachment item in the same menu', async () => {
    const routes = {
      app: 'moon',
      launch: true,
      routes: [
        {
          id: 'chart',
          label: { vi: 'Lá số', en: 'Chart' },
          icon: 'starmap',
          placements: ['composer' as const],
          session: 'required' as const
        }
      ]
    }

    render(
      <I18nProvider configClient={null} initialLocale="vi">
        <DmComposer accountId="account-1" appRoutes={routes} conversationId="conversation-1" disabled={false} />
      </I18nProvider>
    )
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Thêm' }))

    const items = await screen.findAllByRole('menuitem')
    expect(items.map(item => item.textContent)).toEqual(['Lá số', 'Đính kèm ảnh'])
    expect(screen.getByRole('separator')).toBeTruthy()
  })
})
