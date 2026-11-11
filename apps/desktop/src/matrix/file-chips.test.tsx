import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { cleanup, render, screen, within } from '@testing-library/react'
import { createClient, EventType, MatrixEvent, Room } from 'matrix-js-sdk'
import { afterEach, describe, expect, it } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { FileChip } from '../../shared/matrix-file-chips'

import { MatrixFileChip, MatrixFileChips } from './file-chips'
import { matrixMessage } from './message'

afterEach(cleanup)

// jsdom's import.meta.url is not a file URL: the fixtures resolve from the package root (vitest's cwd).
const root = resolve(process.cwd(), '../../packages/device-protocol/fixtures/agent-turns-v1.7/fixtures')
const load = (name: string) => JSON.parse(readFileSync(resolve(root, name), 'utf8'))

const owner = '@owner:example.test'
const agent = '@agent:example.test'
const roomId = '!files:example.test'

const chip = (state: FileChip['state'], overrides: Partial<FileChip> = {}): FileChip =>
  ({
    fileKey: `opaque_key_${state}`,
    name: 'Kế hoạch Q4.docx',
    place: 'Tài liệu › Q4',
    revision: 1,
    state,
    outcome: 'committed',
    ...overrides
  }) as FileChip

describe('file chip, all five states (Atum Kit .ak-file)', () => {
  const show = (file: FileChip, locale: 'vi' | 'en' = 'vi') => render(<MatrixFileChip file={file} locale={locale} />)

  it('saving: the card and its place, with the kit spinner named "Saving"', () => {
    show(chip('saving', { outcome: 'recovering', draftAvailable: false }), 'en')
    const card = screen.getByRole('listitem')
    expect(card.className).toBe('ak-file')
    expect(card.textContent).toContain('Tài liệu › Q4')
    expect(screen.getByRole('status', { name: 'Saving' }).className).toBe('ak-spinner')
  })

  it('saved: the plain card, nothing in its trailing slot', () => {
    show(chip('saved'))
    const card = screen.getByRole('listitem')
    expect(card.className).toBe('ak-file')
    expect(card.textContent).toBe('Kế hoạch Q4.docxTài liệu › Q4')
    expect(within(card).queryByRole('button')).toBeNull()
  })

  it('saved as a copy: the copy’s real name and one info button that says why', () => {
    show(chip('saved_as_copy', { name: 'Báo giá (bản 2).xlsx', outcome: 'committed_with_siblings' }))
    expect(screen.getByText('Báo giá (bản 2).xlsx')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Vì sao có bản này' }).className).toContain('ak-iconbtn--sm')
  })

  it('not confirmed: muted, says so, and offers no "save again"', () => {
    show(chip('not_confirmed', { outcome: 'terminal_unknown', draftAvailable: false }))
    const card = screen.getByRole('listitem')
    expect(card.className).toBe('ak-file ak-file--muted')
    expect(card.textContent).toBe('Kế hoạch Q4.docxChưa xác nhận')
    expect(within(card).queryByRole('button')).toBeNull()
  })

  it('expired: inert, still only "not confirmed", never "lost"', () => {
    show(chip('expired', { outcome: 'draft_evicted', draftAvailable: false }), 'en')
    const card = screen.getByRole('listitem')
    expect(card.className).toBe('ak-file ak-file--inert')
    expect(card.textContent).toBe('Kế hoạch Q4.docxNot confirmed')
    expect(card.textContent?.toLowerCase()).not.toContain('lost')
  })

  it('lists every file an answer made, in order, with no sentence about saving', () => {
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixFileChips files={[chip('saved'), chip('saving', { fileKey: 'opaque_key_second', name: 'b.pdf' })]} />
      </I18nProvider>
    )
    const list = screen.getByRole('list', { name: 'Files' })
    expect(within(list).getAllByRole('listitem').map(item => item.dataset.matrixFileChip)).toEqual(['saved', 'saving'])
    expect(list.textContent).not.toMatch(/Drive|saved to/iu)
  })
})

describe('the SDK host projects chips from the room (history and live)', () => {
  let count = 0

  const roomEvent = (type: string, sender: string, content: Record<string, unknown>, id = `$e${++count}`) =>
    new MatrixEvent({ type, room_id: roomId, event_id: id, sender, origin_server_ts: count, content })

  async function room(...events: MatrixEvent[]) {
    const client = createClient({ baseUrl: 'https://matrix.test', userId: owner })
    const target = new Room(roomId, client, owner)
    await target.addLiveEvents(events, { addToState: false })
    await new Promise(resolve => setTimeout(resolve, 0))

    return target
  }

  const question = () => roomEvent(EventType.RoomMessage, owner, { msgtype: 'm.text', body: 'Make the plan' }, '$trigger')

  const answer = (content = load('files-owner_private-recovering-answer.json')) =>
    roomEvent(EventType.RoomMessage, agent, content, '$answer')

  const update = (outcome: string, revision: number, sender = agent) => {
    const content = load(`files-owner_private-${outcome}-update.json`)
    content['io.atum.files'].answerEventId = '$answer'
    content['m.relates_to'].event_id = '$answer'
    content['io.atum.files'].file.revision = revision

    return roomEvent('io.atum.files.update', sender, content)
  }

  const project = (target: Room, id: string) => matrixMessage(target.findEventById(id)!, owner, new Set(), target)

  it('settles a saving chip by its update, keeps the words, and the update is not a message', async () => {
    const target = await room(question(), answer(), update('committed', 1))

    expect(project(target, '$answer')).toMatchObject({
      body: 'Here is the plan.',
      files: { triggerEventId: '$trigger', triggerSender: owner, files: [{ state: 'saved' }] }
    })
    expect(project(target, '$answer')).not.toHaveProperty('edited')
    expect(project(target, target.getLiveTimeline().getEvents().at(-1)!.getId()!)).toBeNull()
  })

  it('ignores an update another member sent', async () => {
    const target = await room(question(), answer(), update('committed', 1, '@mallory:example.test'))
    expect(project(target, '$answer')?.files?.files[0]?.state).toBe('saving')
  })

  it('renders an old answer exactly as before: its words, its sentence, no chips', async () => {
    const legacy = {
      msgtype: 'm.text',
      body: 'Here is the plan.\n\nĐã lưu vào Atum Drive.',
      'io.atum.result': { status: 'saved_to_drive' },
      'm.relates_to': { 'm.in_reply_to': { event_id: '$trigger' } }
    }

    const target = await room(question(), answer(legacy as never))
    const projected = project(target, '$answer')

    expect(projected?.body).toBe(legacy.body)
    expect(projected).not.toHaveProperty('files')
  })

  it('ignores a chip a person sends, and an owner’s own message is never read for chips', async () => {
    const spoof = roomEvent(EventType.RoomMessage, '@mallory:example.test', load('files-owner_private-committed-answer.json'), '$spoof')
    const own = roomEvent(EventType.RoomMessage, owner, load('files-owner_private-committed-answer.json'), '$own')
    const target = await room(question(), spoof, own)

    // The spoof projects (the wire is valid) but the window admits it only for the bound agent.
    expect(project(target, '$spoof')?.files?.files[0]?.state).toBe('saved')
    expect(project(target, '$own')).not.toHaveProperty('files')
  })
})
