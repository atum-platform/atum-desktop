import { describe, expect, it } from 'vitest'

import { ASSISTANT_ABOUT_MAX_CHARS, matrixAssistantAboutSummary } from './matrix-assistant-about'
import { parsePersona } from './matrix-assistant-persona'

const template = (what: string) => matrixAssistantAboutSummary({ kind: 'template', what, instructions: '' })
const custom = (instructions: string) => matrixAssistantAboutSummary({ kind: 'custom', what: '', instructions })

describe('the About summary', () => {
  it('keeps the template field as written prose', () => {
    expect(template('Keeps my calendar tidy, drafts replies to work email and reminds me before meetings.')).toBe(
      'Keeps my calendar tidy, drafts replies to work email and reminds me before meetings.'
    )
  })

  it('takes only the first prose paragraph of a hand-written persona, past its heading', () => {
    expect(custom("## Role\n\nYou are Lan, Minh's research partner.\n\n## Rules\n\nKeep citations exact.")).toBe(
      "You are Lan, Minh's research partner."
    )
  })

  it('strips Markdown marks: emphasis, code ticks, links, quotes', () => {
    expect(template('> Handles **work email** and `calendar` for _Minh_, see [the docs](https://example.test).')).toBe(
      'Handles work email and calendar for Minh, see the docs.'
    )
  })

  it('keeps snake_case and math-like words intact', () => {
    expect(template('Watches the shopee_orders sheet, 2 * 3 times a day.')).toBe('Watches the shopee_orders sheet, 2 * 3 times a day.')
  })

  it('reads a list as one line of items', () => {
    expect(template('- Keeps my calendar\n- Drafts replies\n- Reminds me before meetings')).toBe(
      'Keeps my calendar · Drafts replies · Reminds me before meetings'
    )
  })

  it('drops code blocks, commands and lines that are only paths', () => {
    expect(
      custom(
        '```bash\nnpm run build\n```\n\n~/Projects/atum/notes.md\n$ ls -la\n    indented code\nLooks after the supplier orders.\n`/var/log/app.log`'
      )
    ).toBe('Looks after the supplier orders.')
  })

  it('is empty when there is nothing to read', () => {
    expect(template('')).toBe('')
    expect(custom('# Heading only\n\n```\ncode\n```\n')).toBe('')
  })

  it('joins Chinese and Japanese lines without inventing spaces', () => {
    expect(template('帮我整理日程，\n回复工作邮件。')).toBe('帮我整理日程，回复工作邮件。')
    expect(template('毎朝の予定を\nまとめます。')).toBe('毎朝の予定をまとめます。')
  })

  it('keeps Vietnamese diacritics and collapses whitespace', () => {
    expect(template('  Lo   lịch họp\nvà email   công việc.  ')).toBe('Lo lịch họp và email công việc.')
  })

  it('cuts a very long text at a word, with an ellipsis', () => {
    const summary = template(`${'word '.repeat(200)}end`)

    expect(Array.from(summary).length).toBeLessThanOrEqual(ASSISTANT_ABOUT_MAX_CHARS + 1)
    expect(summary.endsWith('word…')).toBe(true)
  })

  it('reads a parsed persona of each kind', () => {
    const lan = parsePersona('# Lan\n\n## Who you are\n\nĐiềm tĩnh.\n\n## What you do\n\nLo lịch họp.', { inherited: false, primary: false })
    expect(matrixAssistantAboutSummary(lan)).toBe('Lo lịch họp.')

    const mai = parsePersona('# Mai\n\nYou are Mai, a hand-written research partner.\n\n## Rules\n\nKeep citations exact.', {
      inherited: false,
      primary: false
    })
    expect(matrixAssistantAboutSummary(mai)).toBe('You are Mai, a hand-written research partner.')
  })
})
