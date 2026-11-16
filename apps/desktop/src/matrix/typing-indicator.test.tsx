import { act, cleanup, render } from '@testing-library/react'
import { MatrixEvent } from 'matrix-js-sdk'
import { afterEach, describe, expect, it } from 'vitest'

import { I18nProvider, type Locale, useI18n } from '@/i18n'

import type { MatrixMessage } from '../../shared/matrix'

import { matrixAgentDeskNow } from './agent-desk-model'
import { matrixMessage } from './message'
import { MatrixAgentWorking } from './typing-indicator'

afterEach(cleanup)

const AGENT = '@assistant:test'

const working = { profile: 'atum.agent-turns/1.3', scope: 'owner_private', phase: 'working', kind: 'todo', revision: 0 }

const heartbeat = { ...working, kind: 'heartbeat', heartbeat: true, revision: 3 }

const waiting = { ...working, phase: 'waiting', kind: 'device', revision: 4 }

/** The presentation plugin's line as the desktop reads it: the real parser, from wire content. */
function line(content: Record<string, unknown>): MatrixMessage {
  const event = new MatrixEvent({
    type: 'm.room.message',
    room_id: '!room:test',
    event_id: '$line',
    sender: AGENT,
    origin_server_ts: 1,
    content: { msgtype: 'm.notice', body: '', 'm.relates_to': { 'm.in_reply_to': { event_id: '$ask' } }, ...content }
  })

  return matrixMessage(event, '@owner:test', new Set())!
}

let switchTo: (locale: Locale) => void = () => {}

function Switcher() {
  const { applyLocale } = useI18n()

  switchTo = locale => applyLocale(locale)

  return null
}

function show(message: MatrixMessage, locale: Locale) {
  return render(
    <I18nProvider initialLocale={locale}>
      <Switcher />
      <MatrixAgentWorking id={AGENT} label="Working" line={message} name="Atum" typing />
    </I18nProvider>
  )
}

const shownLine = () => document.querySelector('[data-matrix-progress-line]')?.textContent ?? null

describe('the working line says what the plugin sent as a code, in the reader’s language', () => {
  it.each([
    ['en', 'Reading…'],
    ['vi', 'Đang đọc…']
  ] as const)('a tool category (%s)', (locale, words) => {
    show(line({ 'io.atum.progress': working, 'io.atum.presentation': { version: 1, code: 'tool_activity', args: { activity: 'read' } } }), locale)
    expect(shownLine()).toBe(words)
  })

  it.each([
    ['en', 'Still working · 4 min'],
    ['vi', 'Vẫn đang làm · 4 phút']
  ] as const)('a quiet stretch (%s)', (locale, words) => {
    show(line({ 'io.atum.progress': heartbeat, 'io.atum.presentation': { version: 1, code: 'heartbeat', args: { elapsed_minutes: 4 } } }), locale)
    expect(shownLine()).toBe(words)
  })

  it.each([
    ['en', 'Waiting for your OK…'],
    ['vi', 'Đang chờ bạn đồng ý…']
  ] as const)('a wait on the approval card (%s)', (locale, words) => {
    show(line({ 'io.atum.progress': waiting, 'io.atum.presentation': { version: 1, code: 'approval_wait', args: {} } }), locale)
    expect(shownLine()).toBe(words)
  })

  it('rewords the line when the reader switches language, with no new event', () => {
    show(line({ 'io.atum.progress': working, 'io.atum.presentation': { version: 1, code: 'tool_activity', args: { activity: 'web' } } }), 'en')
    expect(shownLine()).toBe('Looking it up on the web…')
    act(() => switchTo('vi'))
    expect(shownLine()).toBe('Đang tra cứu trên web…')
  })

  it('keeps the agent’s own todo items as written', () => {
    show(line({ body: '✓ Đọc lịch\n• Tóm tắt', 'io.atum.progress': working }), 'en')
    const text = document.querySelector('[data-matrix-agent-working]')?.textContent ?? ''

    expect(text).toContain('Đọc lịch')
    expect(text).toContain('Tóm tắt')
  })
})

describe('a code this build does not know shows nothing but the typing indicator', () => {
  it.each([
    ['an unknown code', { version: 1, code: 'mac_is_sleepy', args: {} }],
    ['a future version', { version: 2, code: 'tool_activity', args: { activity: 'read' } }],
    ['an unknown category', { version: 1, code: 'tool_activity', args: { activity: 'teleport' } }],
    ['a raw tool name', { version: 1, code: 'tool_activity', args: { activity: 'run', tool: 'terminal' } }],
    ['a code on a line of another phase', { version: 1, code: 'approval_wait', args: {} }],
    ['no descriptor at all', undefined]
  ])('%s', (_name, descriptor) => {
    const message = line({ 'io.atum.progress': working, ...(descriptor ? { 'io.atum.presentation': descriptor } : {}) })

    expect(message.progress).toBeDefined()
    expect(message.presentation).toBeUndefined()
    show(message, 'en')
    expect(document.querySelector('[data-matrix-agent-working]')).toBeTruthy()
    expect(shownLine()).toBeNull()
    expect(document.body.textContent).not.toMatch(/[{}]|tool_activity|approval_wait|mac_is_sleepy/u)
  })
})

describe('the agent desk words the same line', () => {
  const input = (message: MatrixMessage, locale?: Locale) => ({
    roomId: '!room:test',
    agentId: AGENT,
    messages: [message],
    ...(locale ? { locale } : {})
  })

  it('says the approval wait in the reader’s language', () => {
    const wait = line({ 'io.atum.progress': waiting, 'io.atum.presentation': { version: 1, code: 'approval_wait', args: {} } })

    expect(matrixAgentDeskNow(input(wait, 'vi'))).toMatchObject({ state: 'waiting', line: 'Đang chờ bạn đồng ý…' })
    expect(matrixAgentDeskNow(input(wait, 'en'))).toMatchObject({ state: 'waiting', line: 'Waiting for your OK…' })
  })

  it('says the step in the reader’s language, and nothing for an empty line', () => {
    const step = line({ 'io.atum.progress': working, 'io.atum.presentation': { version: 1, code: 'tool_activity', args: { activity: 'run' } } })

    expect(matrixAgentDeskNow(input(step, 'en'))).toMatchObject({ state: 'working', line: 'Running a task…' })
    expect(matrixAgentDeskNow(input(line({ 'io.atum.progress': working }), 'en'))).not.toHaveProperty('line')
  })
})
