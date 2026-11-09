import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixAgentView, MatrixUiBridge } from '../../shared/matrix'
import type { MatrixAliasBridge } from '../../shared/matrix-aliases'
import type { MatrixAssistantCardsBridge } from '../../shared/matrix-assistant-card'

import { NewAssistantButton, NewAssistantDialog } from './agent-roster'

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  Reflect.deleteProperty(window, 'atumMatrix')
})

type Created = { principal: string; roomId?: string }

/** jsdom decodes and draws nothing: a picture that opens (or will not) and a canvas that
 * writes WebP, so the sheet's real preparation runs. */
function stubPictures({ decodes = true } = {}) {
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:local-preview' })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => {} })
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => {
      if (!decodes) {
        throw new Error('synthetic undecodable picture')
      }

      return { width: 1024, height: 768, close() {} }
    })
  )
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ clearRect() {}, drawImage() {} } as never)
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((done, type) => {
    const blob = new Blob([png], { type })
    Object.defineProperty(blob, 'arrayBuffer', { value: async () => png.slice().buffer })
    done(blob)
  })
}

function assistantsBridge() {
  return {
    read: vi.fn<MatrixAssistantCardsBridge['read']>(),
    save: vi.fn<MatrixAssistantCardsBridge['save']>(),
    avatar: vi.fn<MatrixAssistantCardsBridge['avatar']>().mockResolvedValue({
      ok: true,
      avatarUrl: 'https://cdn.atum.test/bea.webp'
    })
  }
}

function setup({
  agents,
  createAgent = vi.fn(
    async (): Promise<Created | { refused: 'name' | 'limit' | 'account' }> => ({
      principal: 'bea',
      roomId: '!bea:test'
    })
  ),
  assistants,
  aliases,
  apps
}: {
  agents?: MatrixAgentView[]
  createAgent?: MatrixUiBridge['createAgent']
  assistants?: ReturnType<typeof assistantsBridge>
  aliases?: MatrixAliasBridge
  /** The names the catalog's apps go by. */
  apps?: string[]
} = {}) {
  const importAgent = vi.fn<MatrixUiBridge['importAgent']>().mockResolvedValue({ cancelled: true })
  const command = vi.fn<MatrixUiBridge['command']>().mockResolvedValue(null)
  window.atumMatrix = { createAgent, importAgent, command, assistants, aliases } as unknown as MatrixUiBridge
  const onCreated = vi.fn()

  /** The roster's button and the sheet it opens, composed as the roster does. */
  function Roster() {
    const [open, setOpen] = useState(false)

    return (
      <>
        <NewAssistantButton onClick={() => setOpen(true)} />
        <NewAssistantDialog
          agents={agents}
          apps={apps}
          onCreated={onCreated}
          onOpenChange={setOpen}
          open={open}
          ready
        />
      </>
    )
  }

  render(
    <I18nProvider configClient={null} initialLocale="en">
      <Roster />
    </I18nProvider>
  )

  return { command, createAgent: vi.mocked(createAgent), importAgent, onCreated }
}

const ASSISTANT_ID = '00000000-0000-4000-8000-95eb2692c90e'

/** A handle directory: `taken` handles belong to others, `reserved` ones are refused by the
 * naming policy; `failing` refuses until healed. */
function directoryBridge({
  taken = [],
  reserved = () => false,
  failing = false
}: {
  taken?: string[]
  reserved?: (handle: string) => boolean
  failing?: boolean
} = {}) {
  let own: string | null = null
  let down = failing

  const request = vi.fn<MatrixAliasBridge['request']>(async input => {
    if (down) {
      return { ok: false, error: 'unavailable' }
    }

    if (input.action === 'current') {
      return { ok: true, value: { kind: 'current', alias: own ? { handle: own, generation: 1 } : null } }
    }

    if (input.action === 'check') {
      const code = reserved(input.handle) ? 'alias_reserved' : taken.includes(input.handle) ? 'alias_unavailable' : null

      return { ok: true, value: { kind: 'check', handle: input.handle, available: code === null, code } }
    }

    if (input.action === 'claim') {
      own = input.handle

      return { ok: true, value: { kind: 'claim', handle: input.handle, generation: 1 } }
    }

    return { ok: false, error: 'invalid' }
  })

  const diagnostic = vi.fn<NonNullable<MatrixAliasBridge['diagnostic']>>()

  const aliases: MatrixAliasBridge = {
    pending: vi.fn().mockResolvedValue({ ok: true, request: null }),
    request,
    diagnostic
  }

  return {
    aliases,
    diagnostic,
    request,
    claimed: () => own,
    heal: () => {
      down = false
    }
  }
}

/** The owner's primary, whose directory ID lets the sheet ask about a handle before the new
 * assistant exists. */
const CHECKER_ID = '00000000-0000-4000-8000-e2c9b40fdab3'

const owned = [
  { principal: 'atum', name: 'Atum', isDefault: true, assistantId: CHECKER_ID }
] as unknown as MatrixAgentView[]

const settled = { timeout: 2500 }

const sheet = () => screen.getByRole('dialog', { name: 'New assistant' })
const field = (name: string) => within(sheet()).getByRole('textbox', { name }) as HTMLInputElement
const createButton = () => within(sheet()).getByRole('button', { name: 'Create assistant' }) as HTMLButtonElement

/** One keystroke at a time, each appended to what the field holds after the last render, the
 * way typing reaches a controlled input. */
function typeInto(input: HTMLInputElement, text: string) {
  for (const char of text) {
    fireEvent.change(input, { target: { value: `${input.value}${char}` } })
  }
}

function picture(name = 'bea.png') {
  return new File([png], name, { type: 'image/png' })
}

/** Chooses and confirms a picture through the same crop sheet the person sees. */
async function choosePhoto(file = picture()) {
  fireEvent.change(within(sheet()).getByLabelText('Photo'), { target: { files: [file] } })
  const crop = await screen.findByRole('dialog', { name: 'Crop photo' })
  await within(crop).findByRole('img', { name: 'Photo position' })
  fireEvent.click(within(crop).getByRole('button', { name: 'Use photo' }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Crop photo' })).toBeNull())
  await within(sheet()).findByRole('button', { name: 'Change photo…' })
}

describe('a new assistant', () => {
  it('fills the bot handle from the display name, follows the name until changed, and claims it', async () => {
    const { aliases, diagnostic, request } = directoryBridge()

    const createAgent = vi.fn<MatrixUiBridge['createAgent']>().mockResolvedValue({
      principal: 'tiep-thi',
      roomId: '!tiep-thi:test',
      assistantId: ASSISTANT_ID
    })

    setup({ agents: owned, aliases, createAgent })
    fireEvent.click(screen.getByRole('button', { name: 'New assistant' }))
    fireEvent.change(field('Display name'), { target: { value: 'Tiếp thị' } })
    expect(field('Bot handle').value).toBe('tiep_thi')
    fireEvent.change(field('Display name'), { target: { value: 'Tiếp thị Hà' } })
    expect(field('Bot handle').value).toBe('tiep_thi_ha')
    // Asked about once typing pauses, as an assistant of this account.
    await within(sheet()).findByText('@tiep_thi_ha_bot is available.', undefined, settled)
    expect(request).toHaveBeenCalledWith({ action: 'check', handle: 'tiep_thi_ha_bot', assistantId: CHECKER_ID })
    fireEvent.click(createButton())

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(request).toHaveBeenCalledWith({
      action: 'claim',
      assistantId: ASSISTANT_ID,
      handle: 'tiep_thi_ha_bot',
      requestId: expect.any(String)
    })
    expect(createAgent).toHaveBeenCalledOnce()
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith({ source: 'derived', check: 'available', outcome: 'claimed' })
  })

  it('claims the handle the person typed, read the way a name is, and stops following the name', async () => {
    const { aliases, diagnostic, claimed } = directoryBridge()

    const createAgent = vi.fn<MatrixUiBridge['createAgent']>().mockResolvedValue({
      principal: 'bea',
      roomId: '!bea:test',
      assistantId: ASSISTANT_ID
    })

    setup({ agents: owned, aliases, createAgent })
    fireEvent.click(screen.getByRole('button', { name: 'New assistant' }))
    fireEvent.change(field('Display name'), { target: { value: 'Bea' } })
    fireEvent.change(field('Bot handle'), { target: { value: 'Bếp Trưởng' } })
    fireEvent.blur(field('Bot handle'))
    expect(field('Bot handle').value).toBe('bep_truong')
    fireEvent.change(field('Display name'), { target: { value: 'Bea Lê' } })
    expect(field('Bot handle').value).toBe('bep_truong')
    await within(sheet()).findByText('@bep_truong_bot is available.', undefined, settled)
    fireEvent.click(createButton())

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(claimed()).toBe('bep_truong_bot')
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith({ source: 'typed', check: 'available', outcome: 'claimed' })
  })

  it.each([
    ['Bếp Trưởng', 'bep_truong'],
    ['tro_ly_botanic', 'tro_ly_botanic']
  ])('keeps the bot handle as typed key by key (%s), and claims %s', async (typed, stem) => {
    const { aliases, claimed } = directoryBridge()

    const createAgent = vi.fn<MatrixUiBridge['createAgent']>().mockResolvedValue({
      principal: 'bea',
      roomId: '!bea:test',
      assistantId: ASSISTANT_ID
    })

    setup({ agents: owned, aliases, createAgent })
    fireEvent.click(screen.getByRole('button', { name: 'New assistant' }))
    fireEvent.change(field('Display name'), { target: { value: 'Bea' } })
    const handle = field('Bot handle')
    fireEvent.change(handle, { target: { value: '' } })
    typeInto(handle, typed)
    // Nothing typed is rewritten mid-word: spaces and marks stay until the field is left.
    expect(handle.value).toBe(typed)
    await within(sheet()).findByText(`@${stem}_bot is available.`, undefined, settled)
    fireEvent.blur(handle)
    expect(handle.value).toBe(stem)
    fireEvent.click(createButton())

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(claimed()).toBe(`${stem}_bot`)
  })

  it('says a taken handle in place and offers the same with a short number', async () => {
    const { aliases, diagnostic, claimed } = directoryBridge({ taken: ['tiep_thi_bot'] })

    const createAgent = vi.fn<MatrixUiBridge['createAgent']>().mockResolvedValue({
      principal: 'tiep-thi',
      roomId: '!tiep-thi:test',
      assistantId: ASSISTANT_ID
    })

    setup({ agents: owned, aliases, createAgent })
    fireEvent.click(screen.getByRole('button', { name: 'New assistant' }))
    fireEvent.change(field('Display name'), { target: { value: 'Tiếp thị' } })
    await within(sheet()).findByText('This handle is taken.', undefined, settled)
    // Taken never blocks Create.
    expect(createButton().disabled).toBe(false)

    fireEvent.click(within(sheet()).getByRole('button', { name: /^Use @tiep_thi\d{2,4}_bot$/ }))
    expect(field('Bot handle').value).toMatch(/^tiep_thi\d{2,4}$/)
    const offered = `${field('Bot handle').value}_bot`
    await within(sheet()).findByText(`@${offered} is available.`, undefined, settled)
    fireEvent.click(createButton())

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(claimed()).toBe(offered)
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith({ source: 'suggested', check: 'available', outcome: 'claimed' })
  })

  it('never holds up creating the assistant: an unusable handle falls back to the one from the name', async () => {
    const { aliases, diagnostic, claimed } = directoryBridge()

    const createAgent = vi.fn<MatrixUiBridge['createAgent']>().mockResolvedValue({
      principal: 'bea',
      roomId: '!bea:test',
      assistantId: ASSISTANT_ID
    })

    setup({ agents: owned, aliases, createAgent })
    fireEvent.click(screen.getByRole('button', { name: 'New assistant' }))
    fireEvent.change(field('Display name'), { target: { value: 'Bea' } })
    fireEvent.change(field('Bot handle'), { target: { value: '1' } })
    expect(within(sheet()).getByText('Use 3–32 letters, numbers or underscores, starting with a letter.')).toBeTruthy()
    expect(createButton().disabled).toBe(false)
    fireEvent.click(createButton())

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(claimed()).toBe('bea_bot')
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith({ source: 'derived', check: 'invalid', outcome: 'claimed' })
  })

  it('adds a short number when the handle from the name is taken at creation', async () => {
    const { aliases, claimed, diagnostic } = directoryBridge({ taken: ['tiep_thi_bot'] })

    const createAgent = vi.fn<MatrixUiBridge['createAgent']>().mockResolvedValue({
      principal: 'tiep-thi',
      roomId: '!tiep-thi:test',
      assistantId: ASSISTANT_ID
    })

    setup({ aliases, createAgent })
    fireEvent.click(screen.getByRole('button', { name: 'New assistant' }))
    fireEvent.change(field('Display name'), { target: { value: 'Tiếp thị' } })
    fireEvent.click(createButton())

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(claimed()).toMatch(/^tiep_thi\d{2,4}_bot$/)
    // No assistant to ask with yet: the field was never checked.
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith({
      source: 'derived',
      check: 'unchecked',
      outcome: 'claimed_other'
    })
  })

  it('keeps the made assistant when its handle cannot be set, and retries only the handle', async () => {
    const { aliases, request, claimed, heal, diagnostic } = directoryBridge({ failing: true })

    const createAgent = vi.fn<MatrixUiBridge['createAgent']>().mockResolvedValue({
      principal: 'bea',
      roomId: '!bea:test',
      assistantId: ASSISTANT_ID
    })

    setup({ aliases, createAgent })
    fireEvent.click(screen.getByRole('button', { name: 'New assistant' }))
    fireEvent.change(field('Display name'), { target: { value: 'Bea' } })
    fireEvent.click(createButton())

    expect((await within(sheet()).findByRole('alert')).textContent).toBe(
      'Bea is ready, but its @name isn’t set yet. Try again, or choose one later on Bea’s card.'
    )
    expect(field('Display name').disabled).toBe(true)
    heal()
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(claimed()).toBe('bea_bot')
    expect(createAgent).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalled()
    expect(diagnostic.mock.calls.map(([line]) => ('outcome' in line ? line.outcome : line.backfill))).toEqual([
      'retry',
      'claimed'
    ])
  })

  it('finishes quietly, with no Retry, when the directory reserves every handle a name gives', async () => {
    const { aliases, request, claimed } = directoryBridge({ reserved: () => true })

    const createAgent = vi.fn<MatrixUiBridge['createAgent']>().mockResolvedValue({
      principal: 'xiao',
      roomId: '!xiao:test',
      assistantId: ASSISTANT_ID
    })

    const { onCreated } = setup({ aliases, createAgent })
    fireEvent.click(screen.getByRole('button', { name: 'New assistant' }))
    fireEvent.change(field('Display name'), { target: { value: '小助手' } })
    fireEvent.click(createButton())

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    expect(onCreated).toHaveBeenCalledOnce()
    expect(claimed()).toBeNull()
    expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'claim' }))
  })

  it('finishes quietly when an older host omits the ID a handle needs: the card offers one later', async () => {
    const { aliases, request, diagnostic } = directoryBridge()

    const createAgent = vi.fn<MatrixUiBridge['createAgent']>().mockResolvedValue({
      principal: 'bea',
      roomId: '!bea:test'
    })

    const { onCreated } = setup({ aliases, createAgent })
    fireEvent.click(screen.getByRole('button', { name: 'New assistant' }))
    fireEvent.change(field('Display name'), { target: { value: 'Bea' } })
    fireEvent.click(createButton())

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(onCreated).toHaveBeenCalledOnce()
    expect(createAgent).toHaveBeenCalledOnce()
    expect(request).not.toHaveBeenCalled()
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith({ source: 'derived', check: 'unchecked', outcome: 'skipped' })
  })

  it('is one sheet: the name first and focused, then its photo, who they are and what they do', async () => {
    setup({ assistants: assistantsBridge() })
    fireEvent.click(screen.getByRole('button', { name: 'New assistant' }))
    expect(
      within(sheet())
        .getAllByRole('textbox')
        .map(each => each.getAttribute('id'))
    ).toEqual(['matrix-new-assistant-name', 'matrix-new-assistant-who', 'matrix-new-assistant-job'])
    await waitFor(() => expect(window.document.activeElement).toBe(field('Display name')))
    expect(field('Display name').required).toBe(true)

    // Required first: the name, then the optional photo and answers, in that order.
    const photo = within(sheet()).getByRole('button', { name: 'Choose a photo…' })
    expect(field('Display name').compareDocumentPosition(photo) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(photo.compareDocumentPosition(field('Who they are')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(createButton().disabled).toBe(true)
    // One plain line about what the sheet is for, never a folder path.
    const description = window.document.getElementById(sheet().getAttribute('aria-describedby')!)
    expect(description?.textContent).toBeTruthy()
    expect(description?.textContent).not.toMatch(/~\/|Atum\//)
  })

  it('asks for no photo where this Mac cannot set one', () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: 'New assistant' }))
    expect(within(sheet()).queryByRole('button', { name: 'Choose a photo…' })).toBeNull()
  })

  it('makes the assistant, gives it the chosen photo and opens its conversation, all from the one sheet', async () => {
    stubPictures()
    const assistants = assistantsBridge()
    const { command, createAgent, onCreated } = setup({ assistants })
    fireEvent.click(screen.getByRole('button', { name: 'New assistant' }))
    fireEvent.change(field('Display name'), { target: { value: ' Bea ' } })
    await choosePhoto()
    expect(within(sheet()).getByRole('button', { name: 'Remove' })).toBeTruthy()
    fireEvent.change(field('Who they are'), { target: { value: 'Warm and brief.' } })
    fireEvent.change(field('What they do'), { target: { value: 'Keeps my calendar.' } })
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    fireEvent.click(createButton())

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(createAgent).toHaveBeenCalledExactlyOnceWith(
      'Bea',
      '# Bea\n\n## Who you are\n\nWarm and brief.\n\n## What you do\n\nKeeps my calendar.'
    )
    expect(command).toHaveBeenCalledExactlyOnceWith({ kind: 'select', roomId: '!bea:test' })
    expect(onCreated).toHaveBeenCalledOnce()
    // The photo goes on the assistant the platform returned, only once it exists.
    expect(assistants.avatar).toHaveBeenCalledExactlyOnceWith({
      principal: 'bea',
      avatar: { type: 'image/webp', bytes: expect.any(Uint8Array) }
    })
    expect(createAgent.mock.invocationCallOrder[0]).toBeLessThan(assistants.avatar.mock.invocationCallOrder[0]!)
    // Nothing else opened, and the next sheet starts empty.
    fireEvent.click(screen.getByRole('button', { name: 'New assistant' }))
    expect(field('Display name').value).toBe('')
    expect(within(sheet()).getByRole('button', { name: 'Choose a photo…' })).toBeTruthy()
  })

  it('writes the answers as its persona, and sends no persona when nothing is answered', async () => {
    const { createAgent } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'New assistant' }))
    fireEvent.change(field('Display name'), { target: { value: ' Bea ' } })
    fireEvent.change(field('What they do'), { target: { value: 'Keeps my calendar.' } })
    fireEvent.click(createButton())
    await waitFor(() =>
      expect(createAgent).toHaveBeenCalledExactlyOnceWith('Bea', '# Bea\n\n## What you do\n\nKeeps my calendar.')
    )

    fireEvent.click(await screen.findByRole('button', { name: 'New assistant' }))
    fireEvent.change(field('Display name'), { target: { value: 'Cam' } })
    // Return in the name field creates it.
    fireEvent.submit(field('Display name').closest('form')!)
    await waitFor(() => expect(createAgent).toHaveBeenLastCalledWith('Cam', ''))
  })

  it('says a name already in use in the sheet and keeps everything typed', async () => {
    stubPictures()
    const assistants = assistantsBridge()
    const agents = [{ principal: 'agent-lan', name: 'Lan', isDefault: false }] as unknown as MatrixAgentView[]
    const { createAgent } = setup({ agents, assistants })
    fireEvent.click(screen.getByRole('button', { name: 'New assistant' }))
    fireEvent.change(field('Display name'), { target: { value: 'lan' } })
    await choosePhoto()
    fireEvent.change(field('Who they are'), { target: { value: 'Calm.' } })
    fireEvent.click(createButton())

    expect((await within(sheet()).findByRole('alert')).textContent).toBe('You already have an assistant named lan.')
    expect(createAgent).not.toHaveBeenCalled()
    expect(assistants.avatar).not.toHaveBeenCalled()
    expect(field('Display name').value).toBe('lan')
    expect(field('Who they are').value).toBe('Calm.')
    expect(within(sheet()).getByRole('button', { name: 'Change photo…' })).toBeTruthy()
    // Typing a new name clears the reason, and the same sheet creates it.
    fireEvent.change(field('Display name'), { target: { value: 'Lan Anh' } })
    expect(within(sheet()).queryByRole('alert')).toBeNull()
    fireEvent.click(createButton())
    await waitFor(() =>
      expect(createAgent).toHaveBeenCalledExactlyOnceWith('Lan Anh', '# Lan Anh\n\n## Who you are\n\nCalm.')
    )
  })

  it('keeps the name of an app in the catalog for the app, and lets it be one word of a person’s name', async () => {
    // The catalog this window holds: an app published after this client shipped, found by name alone.
    const { createAgent } = setup({ apps: ['Demoza', 'Demoza AI Skin Coach'] })
    fireEvent.click(screen.getByRole('button', { name: 'New assistant' }))

    for (const refused of ['Demoza', 'démôza', 'Demoza Official', 'DemozaBot']) {
      fireEvent.change(field('Display name'), { target: { value: refused } })
      fireEvent.click(createButton())

      expect((await within(sheet()).findByRole('alert')).textContent, refused).toBe(
        'This name belongs to an Atum assistant.'
      )
      expect(createAgent, refused).not.toHaveBeenCalled()
    }

    // Typing another name clears the reason, and the same sheet creates it.
    fireEvent.change(field('Display name'), { target: { value: 'Demoza Nguyễn' } })
    expect(within(sheet()).queryByRole('alert')).toBeNull()
    fireEvent.click(createButton())
    await waitFor(() => expect(createAgent).toHaveBeenCalledExactlyOnceWith('Demoza Nguyễn', ''))
  })

  it('reserves nothing for a window that holds no catalog', async () => {
    const { createAgent } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'New assistant' }))
    fireEvent.change(field('Display name'), { target: { value: 'Demoza' } })
    fireEvent.click(createButton())
    await waitFor(() => expect(createAgent).toHaveBeenCalledExactlyOnceWith('Demoza', ''))
  })

  it.each([
    ['refuses the name', { refused: 'name' as const }, "That name can't be used. Try another one."],
    ['is at its limit', { refused: 'limit' as const }, "You've reached the most assistants you can create."]
  ])('keeps the sheet and what was typed when the platform %s', async (_case, answer, message) => {
    const createAgent = vi.fn(async () => answer)
    const { command } = setup({ createAgent })
    fireEvent.click(screen.getByRole('button', { name: 'New assistant' }))
    fireEvent.change(field('Display name'), { target: { value: 'Linh' } })
    fireEvent.change(field('What they do'), { target: { value: 'Plans trips.' } })
    fireEvent.click(createButton())

    expect((await within(sheet()).findByRole('alert')).textContent).toBe(message)
    expect(field('Display name').value).toBe('Linh')
    expect(field('What they do').value).toBe('Plans trips.')
    expect(createButton().disabled).toBe(false)
    expect(command).not.toHaveBeenCalled()
  })

  it('says a failed creation in the sheet, keeps the answers and the photo, and can try again', async () => {
    stubPictures()
    const assistants = assistantsBridge()

    const createAgent = vi
      .fn<MatrixUiBridge['createAgent']>()
      .mockRejectedValueOnce(new Error('matrix_agent_unavailable'))
      .mockResolvedValue({ principal: 'bea', roomId: '!bea:test' })

    const { command } = setup({ createAgent, assistants })
    fireEvent.click(screen.getByRole('button', { name: 'New assistant' }))
    fireEvent.change(field('Display name'), { target: { value: 'Bea' } })
    await choosePhoto()
    fireEvent.change(field('Who they are'), { target: { value: 'Warm.' } })
    fireEvent.click(createButton())

    expect((await within(sheet()).findByRole('alert')).textContent).toBe(
      "Couldn't finish creating the assistant. It picks up where it stopped the next time Atum opens."
    )
    expect(field('Display name').value).toBe('Bea')
    expect(field('Who they are').value).toBe('Warm.')
    expect(within(sheet()).getByRole('button', { name: 'Change photo…' })).toBeTruthy()
    expect(assistants.avatar).not.toHaveBeenCalled()
    expect(command).not.toHaveBeenCalled()

    fireEvent.click(createButton())
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(createAgent).toHaveBeenCalledTimes(2)
    expect(assistants.avatar).toHaveBeenCalledOnce()
  })

  it('retries only the photo when it does not save: the assistant is never made twice', async () => {
    stubPictures()
    const assistants = assistantsBridge()
    assistants.avatar.mockResolvedValueOnce({ ok: false, error: 'offline' })
    const { command, createAgent } = setup({ assistants })
    fireEvent.click(screen.getByRole('button', { name: 'New assistant' }))
    fireEvent.change(field('Display name'), { target: { value: 'Bea' } })
    await choosePhoto()
    fireEvent.click(createButton())

    expect((await within(sheet()).findByRole('alert')).textContent).toBe("Bea is ready, but the photo didn't save.")
    // Its conversation already opened; what was made is no longer editable here.
    expect(command).toHaveBeenCalledExactlyOnceWith({ kind: 'select', roomId: '!bea:test' })
    expect(field('Display name').disabled).toBe(true)
    expect(within(sheet()).queryByRole('button', { name: 'Create assistant' })).toBeNull()
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Retry photo' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(assistants.avatar).toHaveBeenCalledTimes(2)
    expect(createAgent).toHaveBeenCalledOnce()
  })

  it('lets the person finish without the photo after it fails, and starts the next sheet empty', async () => {
    stubPictures()
    const assistants = assistantsBridge()
    assistants.avatar.mockResolvedValueOnce({ ok: false, error: 'offline' })
    const { createAgent } = setup({ assistants })
    fireEvent.click(screen.getByRole('button', { name: 'New assistant' }))
    fireEvent.change(field('Display name'), { target: { value: 'Bea' } })
    await choosePhoto()
    fireEvent.click(createButton())
    await within(sheet()).findByRole('alert')

    fireEvent.click(within(sheet()).getByRole('button', { name: 'Done' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'New assistant' }))
    expect(field('Display name').value).toBe('')
    expect(within(sheet()).queryByRole('alert')).toBeNull()
    expect(createAgent).toHaveBeenCalledOnce()
  })

  it('says a picture that will not open before anything is created, and still creates without it', async () => {
    stubPictures({ decodes: false })
    const assistants = assistantsBridge()
    const { createAgent } = setup({ assistants })
    fireEvent.click(screen.getByRole('button', { name: 'New assistant' }))
    fireEvent.change(field('Display name'), { target: { value: 'Bea' } })
    fireEvent.change(within(sheet()).getByLabelText('Photo'), { target: { files: [picture('bea.heic')] } })

    const crop = await screen.findByRole('dialog', { name: 'Crop photo' })
    expect((await within(crop).findByRole('alert')).textContent).toBe('Couldn’t open this image. Try a JPEG or PNG.')
    fireEvent.click(within(crop).getByRole('button', { name: 'Cancel' }))
    expect(within(sheet()).getByRole('button', { name: 'Choose a photo…' })).toBeTruthy()
    expect(field('Display name').value).toBe('Bea')
    fireEvent.click(createButton())
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(createAgent).toHaveBeenCalledExactlyOnceWith('Bea', '')
    expect(assistants.avatar).not.toHaveBeenCalled()
  })

  it('keeps a creation through a dismissal: no second assistant, and the new one still opens', async () => {
    let finish!: (value: Created) => void
    const createAgent = vi.fn(() => new Promise<Created>(resolve => (finish = resolve)))
    const { command, onCreated } = setup({ createAgent })
    fireEvent.click(screen.getByRole('button', { name: 'New assistant' }))
    fireEvent.change(field('Display name'), { target: { value: 'Bea' } })
    fireEvent.click(createButton())
    fireEvent.keyDown(sheet(), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'New assistant' }))
    expect(field('Display name').value).toBe('Bea')
    expect(createButton().disabled).toBe(true)
    expect(within(sheet()).getByRole('status').textContent).toContain('Creating your assistant')
    fireEvent.submit(field('Display name').closest('form')!)
    expect(createAgent).toHaveBeenCalledOnce()

    await act(async () => finish({ principal: 'bea', roomId: '!bea:test' }))
    expect(onCreated).toHaveBeenCalledOnce()
    expect(command).toHaveBeenCalledWith({ kind: 'select', roomId: '!bea:test' })
    expect(screen.queryByRole('dialog')).toBeNull()
    // The next sheet starts empty.
    fireEvent.click(screen.getByRole('button', { name: 'New assistant' }))
    expect(field('Display name').value).toBe('')
  })

  it('treats a cloud-placed assistant with no local room as created, and opens nothing', async () => {
    const createAgent = vi.fn<MatrixUiBridge['createAgent']>().mockResolvedValue({ principal: 'bea' })
    const { command, onCreated } = setup({ createAgent })

    fireEvent.click(screen.getByRole('button', { name: 'New assistant' }))
    fireEvent.change(field('Display name'), { target: { value: 'Bea' } })
    fireEvent.click(createButton())

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(onCreated).toHaveBeenCalledOnce()
    // The cloud owns its room; this Mac has nothing local to select and reports no failure.
    expect(command).not.toHaveBeenCalled()
  })

  it('treats a cloud-placed import with no local room as created, and opens nothing', async () => {
    const { command, importAgent, onCreated } = setup()
    vi.mocked(importAgent).mockResolvedValue({ principal: 'alfred' })

    fireEvent.click(screen.getByRole('button', { name: 'New assistant' }))
    fireEvent.change(field('Display name'), { target: { value: 'Alfred' } })
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Advanced' }))
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Import a prepared profile…' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(importAgent).toHaveBeenCalledExactlyOnceWith('Alfred')
    expect(onCreated).toHaveBeenCalledOnce()
    // The cloud owns its room; this Mac has nothing local to select and reports no failure.
    expect(command).not.toHaveBeenCalled()
    expect(screen.queryByText(/finish creating the assistant/u)).toBeNull()
  })

  it('confirms a paid profile import as an import and shows the received price', async () => {
    const { createAgent, importAgent } = setup()
    vi.mocked(importAgent)
      .mockResolvedValueOnce({ refused: { hire: 1234567 } })
      .mockResolvedValueOnce({ principal: 'alfred' })

    fireEvent.click(screen.getByRole('button', { name: 'New assistant' }))
    fireEvent.change(field('Display name'), { target: { value: 'Alfred' } })
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Advanced' }))
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Import a prepared profile…' }))

    await waitFor(() => expect(within(sheet()).getByText(/1,234,567 Protons \/ 30 days/u)).toBeTruthy())
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Hire' }))

    await waitFor(() => expect(importAgent).toHaveBeenNthCalledWith(2, 'Alfred', true))
    expect(createAgent).not.toHaveBeenCalled()
  })

  it('folds importing a prepared profile under Advanced, with one line of help', () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: 'New assistant' }))
    const advanced = within(sheet()).getByRole('button', { name: 'Advanced' })
    expect(advanced.getAttribute('aria-expanded')).toBe('false')
    expect(within(sheet()).queryByRole('button', { name: 'Import a prepared profile…' })).toBeNull()
    fireEvent.click(advanced)
    expect(advanced.getAttribute('aria-expanded')).toBe('true')
    expect(within(sheet()).getByRole('button', { name: 'Import a prepared profile…' })).toBeTruthy()
    expect(
      within(sheet()).getByText("Uses the name above. The profile's own instructions replace your answers.")
    ).toBeTruthy()
  })

  it('keeps the answers when the native picker is cancelled', async () => {
    const { createAgent, importAgent } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'New assistant' }))
    fireEvent.change(field('Display name'), { target: { value: 'Alfred' } })
    fireEvent.change(field('Who they are'), { target: { value: 'Calm.' } })
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Advanced' }))
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Import a prepared profile…' }))
    await waitFor(() => expect(importAgent).toHaveBeenCalledExactlyOnceWith('Alfred'))
    await waitFor(() =>
      expect(
        (within(sheet()).getByRole('button', { name: 'Import a prepared profile…' }) as HTMLButtonElement).disabled
      ).toBe(false)
    )
    expect(field('Who they are').value).toBe('Calm.')
    expect(createAgent).not.toHaveBeenCalled()
  })
})
