/**
 * The composer's formatting row in Team Space (Slack's): each button writes the markdown every
 * Atum client already renders, around the selection, and says where the selection lands after.
 */
export type TeamSpaceFormat = 'bold' | 'italic' | 'strike' | 'link' | 'bullets' | 'numbers' | 'code' | 'codeBlock'

export interface FormattedText {
  text: string
  selectionStart: number
  selectionEnd: number
}

const WRAP: Partial<Record<TeamSpaceFormat, string>> = { bold: '**', italic: '_', strike: '~~', code: '`' }

/** The whole lines [start, end) touches: a list marks every line the selection covers. */
function lineRange(text: string, start: number, end: number): [number, number] {
  const from = text.lastIndexOf('\n', start - 1) + 1
  const last = end > start && text[end - 1] === '\n' ? end - 1 : end
  const newline = text.indexOf('\n', last)

  return [from, newline === -1 ? text.length : newline]
}

export function applyTeamSpaceFormat(text: string, start: number, end: number, format: TeamSpaceFormat): FormattedText {
  const from = Math.max(0, Math.min(start, end, text.length))
  const to = Math.min(text.length, Math.max(start, end))
  const selected = text.slice(from, to)
  const before = text.slice(0, from)
  const after = text.slice(to)
  const wrap = WRAP[format]

  if (wrap) {
    // Pressing it again on text already wrapped this way takes the marks off.
    if (before.endsWith(wrap) && after.startsWith(wrap) && (format !== 'italic' || !before.endsWith('__'))) {
      return {
        text: before.slice(0, -wrap.length) + selected + after.slice(wrap.length),
        selectionStart: from - wrap.length,
        selectionEnd: to - wrap.length
      }
    }

    return { text: before + wrap + selected + wrap + after, selectionStart: from + wrap.length, selectionEnd: to + wrap.length }
  }

  if (format === 'link') {
    // The words stay selected inside the brackets; with none, the cursor waits for them.
    const label = selected
    const next = `${before}[${label}](url)${after}`
    const urlStart = from + 1 + label.length + 2

    return { text: next, selectionStart: urlStart, selectionEnd: urlStart + 3 }
  }

  if (format === 'codeBlock') {
    const open = before && !before.endsWith('\n') ? '\n```\n' : '```\n'
    const close = after && !after.startsWith('\n') ? '\n```\n' : '\n```'
    const start = before.length + open.length

    return { text: before + open + selected + close + after, selectionStart: start, selectionEnd: start + selected.length }
  }

  // Lists: every covered line gets its marker ("- " or "1. ", "2. " …).
  const [lineStart, lineEnd] = lineRange(text, from, to)
  const lines = text.slice(lineStart, lineEnd).split('\n')
  const marked = lines.map((line, index) => (format === 'bullets' ? `- ${line}` : `${index + 1}. ${line}`)).join('\n')
  const next = text.slice(0, lineStart) + marked + text.slice(lineEnd)
  const added = marked.length - (lineEnd - lineStart)

  const marker = format === 'bullets' ? 2 : 3

  return from === to
    ? { text: next, selectionStart: from + marker, selectionEnd: from + marker }
    : { text: next, selectionStart: lineStart, selectionEnd: lineEnd + added }
}
