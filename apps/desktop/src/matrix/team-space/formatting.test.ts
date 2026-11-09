import { describe, expect, it } from 'vitest'

import { applyTeamSpaceFormat } from './formatting'

/** Apply a format to the text with the selection marked by [ and ]. */
function format(marked: string, kind: Parameters<typeof applyTeamSpaceFormat>[3]) {
  const start = marked.indexOf('[')
  const end = marked.indexOf(']') - 1
  const text = marked.replace('[', '').replace(']', '')
  const result = applyTeamSpaceFormat(text, start, end, kind)

  return result.text.slice(0, result.selectionStart) + '[' + result.text.slice(result.selectionStart, result.selectionEnd) + ']' +
    result.text.slice(result.selectionEnd)
}

describe('the Team Space formatting row', () => {
  it('wraps the selection and keeps it selected inside the marks', () => {
    expect(format('ship it [today] please', 'bold')).toBe('ship it **[today]** please')
    expect(format('ship it [today]', 'italic')).toBe('ship it _[today]_')
    expect(format('[old plan]', 'strike')).toBe('~~[old plan]~~')
    expect(format('run [npm ci]', 'code')).toBe('run `[npm ci]`')
  })

  it('puts the cursor between the marks when nothing is selected', () => {
    expect(format('note: []', 'bold')).toBe('note: **[]**')
  })

  it('takes the marks off when pressed again on wrapped text', () => {
    expect(format('ship it **[today]** please', 'bold')).toBe('ship it [today] please')
    expect(format('~~[old plan]~~', 'strike')).toBe('[old plan]')
  })

  it('makes a link of the words and selects the address to type', () => {
    expect(format('see [the brief]', 'link')).toBe('see [the brief]([url])')
    expect(format('see []', 'link')).toBe('see []([url])')
  })

  it('marks every line the selection covers as a list', () => {
    expect(format('[one\ntwo]', 'bullets')).toBe('[- one\n- two]')
    expect(format('intro\n[one\ntwo]\nend', 'numbers')).toBe('intro\n[1. one\n2. two]\nend')
    expect(format('o[]ne', 'bullets')).toBe('- o[]ne')
  })

  it('fences a code block on its own lines', () => {
    expect(format('[x = 1]', 'codeBlock')).toBe('```\n[x = 1]\n```')
    expect(format('run: [x = 1] now', 'codeBlock')).toBe('run: \n```\n[x = 1]\n```\n now')
  })
})
