import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { en } from '@/i18n/en'
import { ja } from '@/i18n/ja'
import { vi as viCopy } from '@/i18n/vi'
import { zh } from '@/i18n/zh'
import { zhHant } from '@/i18n/zh-hant'
import type { AtumMessagingMessage } from '@/lib/atum-messaging-client'

vi.mock('@/store/atum-dm-workspace', () => ({
  selectAtumDmArtifact: vi.fn(),
  setAtumDmConversationPreviewTarget: vi.fn()
}))

import { selectAtumDmArtifact, setAtumDmConversationPreviewTarget } from '@/store/atum-dm-workspace'

import { DmMessageBubble } from './dm-message-bubble'

const PLANE_URL = 'https://deployment.example.invalid/resources/la-so.html'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function message(overrides: Partial<AtumMessagingMessage> = {}): AtumMessagingMessage {
  return {
    localId: 'local-1',
    id: 'server-1',
    clientMessageId: null,
    conversationId: 'conversation-1',
    sender: { type: 'agent', id: 'moon' },
    content: 'Lá số của bạn đây.',
    kind: 'text',
    attachments: [],
    metadata: null,
    replyToMessageId: null,
    forwardedFrom: null,
    reactions: [],
    version: 1,
    createdAt: '2026-08-17T03:00:00.000Z',
    editedAt: null,
    recalledAt: null,
    delivery: 'sent',
    optimistic: false,
    ...overrides
  }
}

function renderBubble(overrides: Partial<AtumMessagingMessage> = {}, own = false) {
  return render(
    <I18nProvider configClient={null} initialLocale="vi">
      <DmMessageBubble message={message(overrides)} onRetry={vi.fn()} own={own} retryLabel="Thử lại" />
    </I18nProvider>
  )
}

describe('a plain message, unchanged by this work', () => {
  it('renders text and a timestamp and nothing else when there is no metadata', () => {
    const { container } = renderBubble()

    expect(screen.getByText('Lá số của bạn đây.')).toBeTruthy()
    expect(container.querySelector('time')).toBeTruthy()
    expect(container.querySelector('[data-dm-memory-outcome]')).toBeNull()
    expect(container.querySelector('[data-dm-dispatch-state]')).toBeNull()
    expect(screen.getByRole('button', { name: 'Trả lời' })).toBeTruthy()
  })

  it('renders Markdown the way the assistant transcript does, with no raw HTML', async () => {
    const { container } = renderBubble({
      content: 'Đọc kỹ **Chương 2** và:\n* Nhật chủ **Mậu Thổ**\n* Dụng thần là Kim\n\n<img src=x onerror=alert(1)>'
    })

    expect(container.querySelector('[data-dm-markdown]')).toBeTruthy()
    // The transcript renderer paints asynchronously.
    await screen.findByText('Chương 2')
    expect(Array.from(container.querySelectorAll('[data-streamdown="strong"]')).map(node => node.textContent)).toEqual([
      'Chương 2',
      'Mậu Thổ'
    ])
    expect(container.querySelectorAll('li')).toHaveLength(2)
    expect(container.textContent).not.toContain('**')
    expect(container.querySelector('img')).toBeNull()
  })

  it("keeps the sender's own Markdown legible on the ink bubble", async () => {
    const { container } = renderBubble({ content: 'Mở **lá số** của mình.' }, true)

    await screen.findByText('lá số')
    const markdown = container.querySelector('[data-dm-markdown]') as HTMLElement
    expect(markdown.hasAttribute('data-dm-own')).toBe(true)
    // The transcript renderer paints `text-foreground` (ink) on its own
    // container; an own bubble must replace it, not stack under it.
    expect(markdown.className).not.toContain('text-foreground')
    expect(markdown.className).toContain('text-(--atum-card)')
    expect(markdown.className).toContain('prose-strong:text-(--atum-card)')
    expect(markdown.className).toContain('[--tw-prose-body:var(--atum-card)]')
  })

  it('leaves app and person Markdown on the transcript foreground colour', async () => {
    const { container } = renderBubble({ content: 'Đọc **Chương 2**.' })

    await screen.findByText('Chương 2')
    const markdown = container.querySelector('[data-dm-markdown]') as HTMLElement
    expect(markdown.hasAttribute('data-dm-own')).toBe(false)
    expect(markdown.className).toContain('text-foreground')
    expect(markdown.className).not.toContain('text-(--atum-card)')
  })

  it("never turns a peer's #media: or #preview: link into a control that opens a local path", async () => {
    // 2026-11-06 audit lead atum-legacy-dm-markdown-media-link-openpath.
    const openExternal = vi.fn()
    vi.stubGlobal('window', Object.assign(globalThis.window, { hermesDesktop: { openExternal } }))

    const { container } = renderBubble({
      content: '[Open probe.bin](#media:%2Ftmp%2Fprobe.bin) and [pane](#preview:%2Ftmp%2Fnotes.md) done'
    })

    await screen.findByText(/done/)
    expect(container.querySelector('a')).toBeNull()
    // The words stay as inert text (the peer's own label); nothing is clickable.
    expect(screen.getByText('Open probe.bin').closest('a,button')).toBeNull()
    expect(screen.queryByText(/Loading/)).toBeNull()
    expect(openExternal).not.toHaveBeenCalled()
  })

  it("keeps the owner's own #media: link working", async () => {
    const openExternal = vi.fn()
    vi.stubGlobal('window', Object.assign(globalThis.window, { hermesDesktop: { openExternal } }))

    renderBubble({ content: '[x](#media:%2Ftmp%2Fprobe.bin)' }, true)

    fireEvent.click(await screen.findByText('Open probe.bin'))
    expect(openExternal).toHaveBeenCalledWith('file:///tmp/probe.bin')
  })

  it("never lets a peer's image read or open a local file", async () => {
    // Review r1 of the 2026-11-06 DM audit lead: the image path kept the owner's local-file powers.
    const openExternal = vi.fn()
    const readFileDataUrl = vi.fn().mockRejectedValue(new Error('denied'))
    vi.stubGlobal('window', Object.assign(globalThis.window, { hermesDesktop: { openExternal, readFileDataUrl } }))

    const { container } = renderBubble({
      content: [
        '![report](/tmp/alias.txt)',
        '![ref][r]',
        '![file](file:///tmp/alias2.txt)',
        '<img src="/tmp/raw.txt" alt="raw">',
        'done',
        '',
        '[r]: /tmp/ref.txt'
      ].join('\n\n')
    })

    await screen.findByText(/done/)
    // Let any (wrongly) started read settle and surface its fallback button.
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(container.querySelector('img')).toBeNull()
    expect(screen.queryByText('Open image')).toBeNull()
    expect(screen.queryByText(/Couldn.t load/)).toBeNull()
    expect(readFileDataUrl).not.toHaveBeenCalled()
    expect(openExternal).not.toHaveBeenCalled()
  })

  it("keeps the owner's own local image working, including its open fallback", async () => {
    const openExternal = vi.fn()
    const readFileDataUrl = vi.fn().mockRejectedValue(new Error('denied'))
    vi.stubGlobal('window', Object.assign(globalThis.window, { hermesDesktop: { openExternal, readFileDataUrl } }))

    renderBubble({ content: '![report](/tmp/alias.txt)' }, true)

    fireEvent.click(await screen.findByText('Open image'))
    expect(readFileDataUrl).toHaveBeenCalledWith('/tmp/alias.txt')
    expect(openExternal).toHaveBeenCalledWith('file:///tmp/alias.txt')
  })

  it('ignores malformed metadata and malformed attachments entirely', () => {
    const { container } = renderBubble({
      attachments: [null, 'nope', { url: 'file:///etc/passwd' }] as unknown[],
      metadata: { andy_memory: 'supplied', specialist_dispatch: [] } as unknown as Record<string, unknown>
    })

    expect(screen.getByText('Lá số của bạn đây.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Trả lời' })).toBeTruthy()
    expect(container.querySelector('[data-dm-memory-outcome]')).toBeNull()
  })
})

describe('messenger message states', () => {
  it('renders the honest recall tombstone instead of the old body', () => {
    renderBubble({ recalledAt: '2026-08-29T01:00:00.000Z' })
    expect(screen.getByText('Tin nhắn đã được thu hồi')).toBeTruthy()
    expect(screen.queryByText('Lá số của bạn đây.')).toBeNull()
  })

  it('renders reaction counts and toggles the selected emoji', () => {
    const onReact = vi.fn()
    render(
      <I18nProvider configClient={null} initialLocale="vi">
        <DmMessageBubble
          message={message({ reactions: [{ emoji: '👍', count: 2 }] })}
          onReact={onReact}
          onRetry={vi.fn()}
          own={false}
          retryLabel="Thử lại"
        />
      </I18nProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: '👍 2' }))
    expect(onReact).toHaveBeenCalledWith('server-1', '👍')
  })

  it('jumps from a quoted reply to its source', () => {
    const source = message({ id: 'source-1', content: 'Tin gốc' })
    const scrollIntoView = vi.fn()
    const node = document.createElement('div')
    node.id = 'dm-message-source-1'
    Object.assign(node, { scrollIntoView })
    document.body.append(node)
    render(
      <I18nProvider configClient={null} initialLocale="vi">
        <DmMessageBubble
          message={message({ replyToMessageId: 'source-1' })}
          onRetry={vi.fn()}
          own={false}
          replySource={source}
          retryLabel="Thử lại"
        />
      </I18nProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Tin gốc' }))
    expect(scrollIntoView).toHaveBeenCalled()
    node.remove()
  })
})

describe('app memory disclosure', () => {
  it.each(['granted_empty', 'not_authorized', 'revoked'])(
    'does not put routine %s permission state under an answer',
    outcome => {
      const { container } = renderBubble({ metadata: { andy_memory: { v: 1, outcome, used: false } } })
      expect(container.querySelector('[data-dm-memory-outcome]')).toBeNull()
      expect(screen.queryByText('b1')).toBeNull()
    }
  )
  it('discloses actual sharing without the internal protocol version', () => {
    renderBubble({ sender: { type: 'agent', id: 'andy' }, metadata: { andy_memory: { v: 1, outcome: 'supplied', used: true } } })
    expect(screen.getByText('Đã chia sẻ bộ nhớ với ứng dụng')).toBeTruthy()
    expect(screen.queryByText('b1')).toBeNull()
  })
  it('discloses a generic receipt for a third provider but not a human spoof', () => {
    const { container, rerender } = renderBubble({
      sender: { type: 'specialist', id: 'provider-memory' },
      metadata: { provider_memory: { v: 1, outcome: 'supplied', used: true } }
    })

    expect(container.querySelector('[data-dm-memory-outcome="supplied"]')).toBeTruthy()
    rerender(
      <I18nProvider configClient={null} initialLocale="vi">
        <DmMessageBubble
          message={message({ sender: { type: 'assistant', id: 'provider-memory' }, metadata: { provider_memory: { v: 1, outcome: 'supplied', used: true } } })}
          onRetry={vi.fn()}
          own={false}
          retryLabel="Thử lại"
        />
      </I18nProvider>
    )
    expect(container.querySelector('[data-dm-memory-outcome]')).toBeNull()
  })
  it.each([false, undefined])('does not infer actual sharing when used is %s', used => {
    const { container } = renderBubble({ metadata: { andy_memory: { outcome: 'supplied', used } } })
    expect(container.querySelector('[data-dm-memory-outcome]')).toBeNull()
  })
})

describe('specialist dispatch (beats 2–3)', () => {
  it.each(['pending', 'dispatched', 'running'])('shows the in-flight marker while %s', state => {
    const { container } = renderBubble({ metadata: { specialist_dispatch: { state, specialist: 'Moon' } } })

    expect(screen.getByText('Moon đang trả lời…')).toBeTruthy()
    expect(container.querySelector(`[data-dm-dispatch-state="${state}"]`)).toBeTruthy()
  })

  it('falls back to the generic label when no specialist is named', () => {
    renderBubble({ metadata: { specialist_dispatch: { state: 'running' } } })

    expect(screen.getByText('Đang trả lời…')).toBeTruthy()
  })

  it.each(['succeeded', 'failed'])('shows no marker once the turn has settled (%s)', state => {
    const { container } = renderBubble({ metadata: { specialist_dispatch: { state } } })

    expect(container.querySelector('[data-dm-dispatch-state]')).toBeNull()
  })
})

describe('hosted Atum mention dispatch', () => {
  it.each(['pending', 'processing'])('shows the quiet replying line while %s', state => {
    const { container } = renderBubble(
      { metadata: { mention_dispatch: { state, agent: 'binh-minh', revision: 0 } } },
      true
    )

    expect(screen.getByText('Atum đang trả lời…')).toBeTruthy()
    expect(container.querySelector(`[data-dm-mention-state="${state}"]`)).toBeTruthy()
  })

  it('maps an empty wallet to actionable Proton copy', () => {
    renderBubble(
      {
        metadata: {
          mention_dispatch: {
            state: 'dead_lettered',
            agent: 'binh-minh',
            revision: 0,
            error_code: 'insufficient_protons'
          }
        }
      },
      true
    )
    expect(screen.getByText('Atum cần thêm Proton để tiếp tục.')).toBeTruthy()
  })

  it('keeps completed assistant participation visible without asserting server context policy', () => {
    const { container } = renderBubble(
      { metadata: { mention_dispatch: { state: 'completed', agent: 'binh-minh', revision: 0 } } },
      true
    )

    expect(screen.getByText('Atum đã trả lời.')).toBeTruthy()
    expect(container.querySelector('[data-dm-mention-state="completed"]')).toBeTruthy()
  })
})

describe('resource cards (beat 2)', () => {
  it('renders and opens a typed artifact without accepting a URL from message metadata', () => {
    const ref = { kind: 'artifact', resource_id: 'moon.laso:42', type: 'reading', title: 'Lá số', status: 'ready' }
    renderBubble({ content: '', metadata: { resource_refs: [ref] } })

    fireEvent.click(screen.getByRole('button', { name: 'Mở Lá số' }))
    expect(selectAtumDmArtifact).toHaveBeenCalledWith('conversation-1', {
      kind: 'artifact',
      resourceId: 'moon.laso:42',
      type: 'reading',
      title: 'Lá số',
      status: 'ready'
    })
  })

  it('drops a typed artifact carrying path or URL authority', () => {
    renderBubble({
      metadata: {
        resource_refs: [
          {
            kind: 'artifact',
            resource_id: 'moon.laso:42',
            type: 'reading',
            title: 'Lá số',
            status: 'ready',
            url: 'https://evil.test',
            path: '/tmp/x'
          }
        ]
      }
    })
    expect(screen.queryByRole('button', { name: 'Mở Lá số' })).toBeNull()
  })
  it('renders an attachment as a card with its name, kind, and size', () => {
    renderBubble({
      attachments: [{ id: 'a-1', name: 'Lá số.html', mime_type: 'text/html', size_bytes: 4096, url: PLANE_URL }]
    })

    expect(screen.getByRole('button', { name: 'Mở Lá số.html' })).toBeTruthy()
    expect(screen.getByText('Lá số.html')).toBeTruthy()
    expect(screen.getByText('Trang · 4 KB')).toBeTruthy()
  })

  it('routes an allowlisted resource into the panel the same way preview.open does', () => {
    renderBubble({ attachments: [{ id: 'a-1', name: 'Lá số.html', url: PLANE_URL }] })
    fireEvent.click(screen.getByRole('button', { name: 'Mở Lá số.html' }))

    expect(setAtumDmConversationPreviewTarget).toHaveBeenCalledWith('conversation-1', {
      kind: 'url',
      label: 'Lá số.html',
      source: PLANE_URL,
      url: PLANE_URL
    })
  })

  it('sends a non-allowlisted origin to the browser, and says so on the control', () => {
    const openExternal = vi.fn()
    vi.stubGlobal('window', Object.assign(globalThis.window, { hermesDesktop: { openExternal } }))

    renderBubble({ attachments: [{ id: 'a-1', name: 'Lá số', url: 'https://moon.example.test/embed/laso/9' }] })

    expect(screen.getByText('Mở bằng trình duyệt')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Mở Lá số' }))
    expect(openExternal).toHaveBeenCalledWith('https://moon.example.test/embed/laso/9')
    expect(setAtumDmConversationPreviewTarget).not.toHaveBeenCalled()
  })

  it('renders a resource-only message that carries no text', () => {
    renderBubble({ attachments: [{ id: 'a-1', name: 'chart.png', url: PLANE_URL }], content: '' })

    expect(screen.getByRole('button', { name: 'chart.png' })).toBeTruthy()
  })

  it('renders a card and a receipt together on one bubble', () => {
    renderBubble({
      attachments: [{ id: 'a-1', name: 'receipt.pdf', url: PLANE_URL }],
      sender: { type: 'agent', id: 'andy' },
      metadata: { andy_memory: { v: 1, outcome: 'supplied', used: true } }
    })

    expect(screen.getByRole('button', { name: 'Mở receipt.pdf' })).toBeTruthy()
    expect(screen.getByText('Đã chia sẻ bộ nhớ với ứng dụng')).toBeTruthy()
  })
})

describe('delivery failure is visible', () => {
  // The engine's own state name is `failed_terminal` (MutationState). This
  // bubble previously tested for `failed_terminal`'s non-existent twin,
  // `failed_permanent`, so a message that could never be delivered rendered
  // exactly like a delivered one. The failure is named in words, in the reader's
  // language; the icon beside them is only a mark.
  const locales = [
    ['vi', viCopy],
    ['en', en],
    ['ja', ja],
    ['zh', zh],
    ['zh-hant', zhHant]
  ] as const

  function renderIn(locale: string, overrides: Partial<AtumMessagingMessage>) {
    return render(
      <I18nProvider configClient={null} initialLocale={locale}>
        <DmMessageBubble message={message(overrides)} onRetry={vi.fn()} own retryLabel="Retry" />
      </I18nProvider>
    )
  }

  it.each(locales)('marks a terminally failed message as failed and offers no retry (%s)', (locale, copy) => {
    const { container } = renderIn(locale, { delivery: 'failed_terminal', clientMessageId: 'client-1' })

    expect(container.querySelector('[data-delivery-failed]')).toBeTruthy()
    expect(screen.getByText(copy.dm.sendFailed)).toBeTruthy()
    expect(container.querySelector('[aria-label="failed"]')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  it.each(locales)('marks a retryable failure as failed and offers retry (%s)', (locale, copy) => {
    const { container } = renderIn(locale, { delivery: 'failed_retryable', clientMessageId: 'client-1' })

    expect(container.querySelector('[data-delivery-failed]')).toBeTruthy()
    expect(screen.getByText(copy.dm.sendFailed)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
  })

  it('leaves a delivered message unmarked', () => {
    const { container } = renderBubble({ delivery: 'sent' }, true)

    expect(container.querySelector('[data-delivery-failed]')).toBeNull()
    expect(screen.queryByText('Gửi thất bại')).toBeNull()
  })
})

describe('immutable group messages', () => {
  it('keeps reporting available while hiding mutation and reply controls', () => {
    const onEdit = vi.fn()
    const onReact = vi.fn()
    const onRecall = vi.fn()
    const onReply = vi.fn()
    const onReport = vi.fn()
    const onRetry = vi.fn()

    render(
      <I18nProvider configClient={null} initialLocale="en">
        <DmMessageBubble
          immutable
          message={message({
            clientMessageId: 'client-1',
            delivery: 'failed_retryable',
            reactions: [{ emoji: '👍', count: 2 }]
          })}
          onEdit={onEdit}
          onReact={onReact}
          onRecall={onRecall}
          onReply={onReply}
          onReport={onReport}
          onRetry={onRetry}
          own
          retryLabel="Retry"
        />
      </I18nProvider>
    )

    expect(screen.queryByRole('button', { name: 'Reply' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    expect((screen.getByRole('button', { name: '👍 2' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Report' }))
    expect(onReport).toHaveBeenCalledWith('server-1')
    expect(onEdit).not.toHaveBeenCalled()
    expect(onReact).not.toHaveBeenCalled()
    expect(onRecall).not.toHaveBeenCalled()
    expect(onReply).not.toHaveBeenCalled()
    expect(onRetry).not.toHaveBeenCalled()
  })
})

describe('addressed assistant presentation', () => {
  const id = '00000000-0000-4000-8000-bd7662a5eeb4'
  const owner = '00000000-0000-4000-8000-b454f82c5857'

  it('shows the named target status without the legacy Atum aggregate', () => {
    renderBubble({
      metadata: {
        mention_dispatch: { state: 'completed', agent: 'binh-minh', revision: 0 },
        target_dispatches: [
          {
            target_type: 'assistant',
            target_id: id,
            display_name: 'Mai',
            avatar: '🌿',
            revision: 1,
            job_id: owner,
            state: 'completed'
          }
        ]
      }
    })
    expect(screen.getByText('Mai đã trả lời.')).toBeTruthy()
    expect(screen.queryByText('Atum đã trả lời.')).toBeNull()
  })

  it('renders only an identity snapshot matching the assistant sender', () => {
    renderBubble({
      sender: { type: 'assistant', id },
      metadata: {
        assistant_identity: {
          id: owner,
          owner_user_id: owner,
          display_name: 'Wrong identity',
          avatar: '🌿',
          revision: 1
        }
      }
    })
    expect(screen.queryByText('Wrong identity')).toBeNull()
  })
})
