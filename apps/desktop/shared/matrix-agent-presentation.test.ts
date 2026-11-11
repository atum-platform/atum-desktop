import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { DESKTOP_LOCALES } from './desktop-locale'
import { matrixAgentStatusText } from './matrix-agent-status-copy'
import {
  matrixAgentLocalizedText,
  matrixAnswerWarning,
  matrixResultStatusNotice,
  matrixStatusLine,
  matrixWarningSplit
} from './matrix-agent-status-marker'
import { matrixProgressMarker, matrixProgressPresentation } from './matrix-progress-marker'
import { matrixProgressLineText, matrixToolActivityCopy } from './matrix-status-line-copy'

/** Synthetic conformance inputs of the frozen agent-turns/1.5 pack (fixtures/agent-turns-v1.5/PROVENANCE.md). */
const pack = join(__dirname, 'fixtures/agent-turns-v1.5')
const fixture = (name: string) => JSON.parse(readFileSync(join(pack, name), 'utf8')) as Record<string, unknown>
const named = (prefix: string) => readdirSync(pack).filter(name => name.startsWith(prefix))

/** What a projection reads: the latest content of an edit, the content of an original. */
const shown = (content: Record<string, unknown>) => (content['m.new_content'] as Record<string, unknown>) ?? content

describe('the working line descriptor (agent-turns/1.5 A12, A13)', () => {
  it('decides every vector of the pack: render or fall back to the body', () => {
    const { vectors } = fixture('presentation-descriptor.vectors.json') as {
      vectors: { name: string; kind: never; phase: never; descriptor: unknown; decision: 'render' | 'fallback' }[]
    }

    for (const vector of vectors) {
      const decided = matrixProgressPresentation({ 'io.atum.presentation': vector.descriptor }, vector)

      expect(decided ? 'render' : 'fallback', vector.name).toBe(vector.decision)
    }
  })

  it('reads the descriptor beside the unchanged marker of every accepted fixture, and none of a rejected one', () => {
    for (const name of named('progress-presentation-')) {
      const content = shown(fixture(name))
      const marker = matrixProgressMarker(content)

      // The closed marker is read exactly as before: the descriptor is never inside it.
      expect(marker, name).toEqual(content['io.atum.progress'])
      expect(Boolean(matrixProgressPresentation(content, marker!)), name).toBe(!name.includes('rejected'))
    }
  })

  it('words the line in the reader’s language and keeps the checklist rows as the agent wrote them', () => {
    const content = shown(fixture('progress-presentation-todo.content.json'))
    const marker = matrixProgressMarker(content)!
    const presentation = matrixProgressPresentation(content, marker)

    expect(matrixProgressLineText(content.body as string, marker, presentation, 'en')).toBe('1 of 2 done\n✓ Đọc lịch\n• Tóm tắt')
    expect(matrixProgressLineText(content.body as string, marker, presentation, 'ja')).toBe('2件中1件完了\n✓ Đọc lịch\n• Tóm tắt')
  })

  it('shows the reported symptom in English, and the same event in every language without a new event', () => {
    const content = shown(fixture('progress-presentation-tool-activity.content.json'))
    const marker = matrixProgressMarker(content)!
    const presentation = matrixProgressPresentation(content, marker)
    const body = content.body as string

    expect(matrixProgressLineText(body, marker, presentation, 'en')).toBe(matrixToolActivityCopy.en.run)

    for (const locale of DESKTOP_LOCALES) {
      expect(matrixProgressLineText(body, marker, presentation, locale)).toBe(matrixToolActivityCopy[locale].run)
    }
  })

  it('names the Mac a wait is on, from the marker', () => {
    for (const name of ['progress-presentation-device-wait.content.json', 'progress-presentation-touch-id.content.json']) {
      const content = shown(fixture(name))
      const marker = matrixProgressMarker(content)!
      const text = matrixProgressLineText(content.body as string, marker, matrixProgressPresentation(content, marker), 'en')

      expect(text, name).toContain(marker.device!)
      expect(text, name).not.toBe(content.body)
    }
  })

  it('falls back to the body for a rejected descriptor, and for a line without one', () => {
    for (const name of named('progress-presentation-').filter(file => file.includes('rejected'))) {
      const content = shown(fixture(name))
      const marker = matrixProgressMarker(content)!

      expect(matrixProgressLineText(content.body as string, marker, matrixProgressPresentation(content, marker), 'en'), name)
        .toBe(content.body)
    }

    expect(matrixProgressLineText('Đang chạy tác vụ…', { device: undefined }, undefined, 'en')).toBe('Đang chạy tác vụ…')
  })
})

describe('outcome notices, scheduled lines and answer warnings (A14, A15)', () => {
  it('reads the code and details of every accepted result notice, and nothing of a rejected one', () => {
    for (const name of named('result-status-')) {
      const content = fixture(name)

      expect(Boolean(matrixResultStatusNotice(content)), name).toBe(!name.includes('rejected'))
    }
  })

  it('reads every accepted scheduled line, and nothing of a rejected one', () => {
    for (const name of named('status-line-')) {
      const content = fixture(name)

      expect(Boolean(matrixStatusLine(content)), name).toBe(!name.includes('rejected'))
    }
  })

  it('splits an answer from its warning only as the contract allows', () => {
    for (const name of named('result-answer-warning')) {
      expect(Boolean(matrixAnswerWarning(fixture(name))), name).toBe(!name.includes('rejected'))
    }

    const { vectors } = fixture('result-warning-split.vectors.json') as {
      vectors: { name: string; body: string; warning_from: number; decision: 'split' | 'whole' }[]
    }

    for (const vector of vectors) {
      expect(matrixWarningSplit(vector.body, vector.warning_from) ? 'split' : 'whole', vector.name).toBe(vector.decision)
    }
  })

  it('keeps the answer byte for byte and words only the warning', () => {
    const content = fixture('result-answer-warning.content.json')
    const answerWarning = matrixAnswerWarning(content)!
    const text = matrixAgentLocalizedText({ body: content.body as string, answerWarning }, 'en')!

    expect(text).toBe(`Mình đã tóm tắt xong video và lưu ghi chú.\n\n${matrixAgentStatusText('saved_to_drive', 'en')}`)
  })

  it('words a notice from its details: the Mac, the routine and whether the agent carries on', () => {
    const away = fixture('result-status-device-unreachable.content.json')
    const routine = fixture('status-line-routine-failed.content.json')

    expect(matrixAgentLocalizedText({ body: away.body as string, cloudStatus: matrixResultStatusNotice(away) }, 'en'))
      .toBe('MacBook Air is off or locked. I’ll carry on when it’s back, or tell me “do it in the cloud” and I’ll do it right away.')
    expect(matrixAgentLocalizedText({ body: routine.body as string, statusLine: matrixStatusLine(routine) }, 'en'))
      .toContain('Your routine “Hỏi thăm” didn’t finish')
  })

  it('keeps the body of an older notice whose sentence names something its code alone cannot', () => {
    // A notice from a sender before 1.5: the Mac is only in the body, so the code alone would drop it.
    const body = 'Mình đã dừng việc trên đám mây và đang làm tiếp trên MacBook Air.'

    expect(matrixAgentLocalizedText({ body, cloudStatus: { code: 'resuming_on_device' } }, 'en')).toBeUndefined()
    expect(matrixAgentLocalizedText({ body: 'Việc theo lịch lần này chưa làm xong.', cloudStatus: { code: 'failed' } }, 'en'))
      .toBeUndefined()

    // The plain sentence of such a code, and every code that interpolates nothing, are reworded.
    expect(matrixAgentLocalizedText({ body: matrixAgentStatusText('failed', 'vi'), cloudStatus: { code: 'failed' } }, 'en'))
      .toBe(matrixAgentStatusText('failed', 'en'))
    expect(matrixAgentLocalizedText({ body: 'Đã dừng.', cloudStatus: { code: 'stopped' } }, 'ja')).toBe('停止しました。')
  })

  it('has a sentence for every code in every language', () => {
    for (const name of [...named('result-status-'), ...named('status-line-')].filter(file => !file.includes('rejected'))) {
      const content = fixture(name)
      const status = matrixResultStatusNotice(content) ?? matrixStatusLine(content)!

      for (const locale of DESKTOP_LOCALES) {
        expect(matrixAgentStatusText(status.code, locale, status.details).trim(), `${name} ${locale}`).not.toBe('')
      }
    }
  })
})
