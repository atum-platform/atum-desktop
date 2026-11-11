import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'

import { I18nProvider, type Locale, useI18n } from '@/i18n'

import type { MatrixMessage } from '../../shared/matrix'
import { matrixProgressMarker, matrixProgressPresentation } from '../../shared/matrix-progress-marker'

import { MatrixAgentWorking } from './typing-indicator'

afterEach(cleanup)

let switchTo: (locale: Locale) => void = () => {}

function Switcher() {
  const { applyLocale } = useI18n()

  switchTo = locale => applyLocale(locale)

  return null
}

function line(content: Record<string, unknown>): MatrixMessage {
  const progress = matrixProgressMarker(content)!

  return {
    id: '$line',
    sender: '@assistant:test',
    body: content.body as string,
    timestamp: 1,
    own: false,
    encrypted: true,
    decryptionFailed: false,
    pending: false,
    failed: false,
    attachment: false,
    notice: true,
    progress,
    ...(matrixProgressPresentation(content, progress) ? { presentation: matrixProgressPresentation(content, progress) } : {})
  }
}

const marker = { profile: 'atum.agent-turns/1.3', scope: 'owner_private', phase: 'working', kind: 'todo', revision: 1 }

it('words the working line in the reader’s language and rewords it when the language changes, with no new event', () => {
  const working = line({
    msgtype: 'm.notice',
    body: 'Đang chạy tác vụ…\n✓ Đọc lịch\n• Tóm tắt',
    'io.atum.progress': marker,
    'io.atum.presentation': { version: 1, code: 'tool_activity', args: { activity: 'run' } }
  })

  render(
    <I18nProvider initialLocale="en">
      <Switcher />
      <MatrixAgentWorking id="$line" label="Working" line={working} name="Atum" typing />
    </I18nProvider>
  )

  expect(screen.getByText('Running a task…')).toBeTruthy()
  // The checklist rows are the agent's own words and stay as written.
  expect(screen.getByText('Đọc lịch')).toBeTruthy()
  expect(screen.getByText('Tóm tắt')).toBeTruthy()

  act(() => switchTo('ja'))
  expect(screen.getByText('処理を実行しています…')).toBeTruthy()
  expect(screen.queryByText('Running a task…')).toBeNull()

  act(() => switchTo('vi'))
  expect(screen.getByText('Đang chạy tác vụ…')).toBeTruthy()
})

it('shows the body of a line without a descriptor it can trust', () => {
  const working = line({
    msgtype: 'm.notice',
    body: 'Đang chạy tác vụ…',
    'io.atum.progress': marker,
    'io.atum.presentation': { version: 2, code: 'tool_activity', args: { activity: 'run' } }
  })

  render(
    <I18nProvider initialLocale="en">
      <MatrixAgentWorking id="$line" label="Working" line={working} name="Atum" typing />
    </I18nProvider>
  )

  expect(screen.getByText('Đang chạy tác vụ…')).toBeTruthy()
})
