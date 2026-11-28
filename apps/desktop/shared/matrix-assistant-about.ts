import type { ParsedPersona } from './matrix-assistant-persona'

/** The longest summary kept; the card clamps it to three lines on screen. */
export const ASSISTANT_ABOUT_MAX_CHARS = 280

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff00-\uffef]/u
const BULLET = /^\s*(?:[-*+•]|\d{1,3}[.)])\s+/u
const HEADING = /^\s{0,3}#{1,6}(?:\s|$)/u
const RULE = /^\s{0,3}(?:[-*_]\s*){3,}$/u
const FENCE = /^\s{0,3}(?:```|~~~)/u

/** A line that is only a path, a command or code: nothing a person reads as "what it does". */
function codeOnly(line: string): boolean {
  const text = line.trim()

  return (
    /^`[^`]+`[.,;:]?$/u.test(text) ||
    /^\$\s/u.test(text) ||
    // One token with a slash or backslash: a path or a URL standing alone.
    (/^[^\s]+$/u.test(text) && /[\\/]/u.test(text)) ||
    /^[{}[\]()<>]+[,;]?$/u.test(text)
  )
}

/** Markdown's inline marks off: links keep their words, emphasis and code ticks go. */
function plain(line: string): string {
  return line
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/`([^`]*)`/gu, '$1')
    .replace(/(\*\*|__)(.+?)\1/gu, '$2')
    .replace(/(^|[\s(])[*_]([^\s*_][^*_]*?)[*_](?=[\s).,;:!?]|$)/gu, '$1$2')
    .replace(/~~(.+?)~~/gu, '$1')
    .replace(/^\s*>\s?/u, '')
}

/** Lines joined as prose: a space between words, nothing between two CJK characters. */
function join(parts: readonly { text: string; bullet: boolean }[]): string {
  let out = ''
  let previousBullet = false

  for (const { text, bullet } of parts) {
    if (!out) {
      out = text
    } else if (bullet && previousBullet) {
      out += /[.!?…。！？;；:：,，]$/u.test(out) ? ` ${text}` : ` · ${text}`
    } else if (CJK.test(out.slice(-1)) && CJK.test(text[0] ?? '')) {
      out += text
    } else {
      out += ` ${text}`
    }

    previousBullet = bullet
  }

  return out.replace(/\s+/gu, ' ').trim()
}

/** Prose paragraphs of a text: code blocks, headings, rules and path-only lines dropped. */
function paragraphs(source: string): string[] {
  const out: string[] = []
  let current: { text: string; bullet: boolean }[] = []
  let fenced = false

  const flush = () => {
    const text = join(current)

    if (text) {
      out.push(text)
    }

    current = []
  }

  for (const raw of source.replace(/\r\n?/gu, '\n').split('\n')) {
    if (FENCE.test(raw)) {
      fenced = !fenced
      flush()

      continue
    }

    if (fenced) {
      continue
    }

    if (!raw.trim() || HEADING.test(raw) || RULE.test(raw)) {
      flush()

      continue
    }

    // Four spaces in (outside a list) is a code block in Markdown.
    if (/^(?: {4}|\t)/u.test(raw) && !BULLET.test(raw)) {
      continue
    }

    const bullet = BULLET.test(raw)
    const text = plain(raw.replace(BULLET, '')).trim()

    if (!text || codeOnly(text)) {
      continue
    }

    current.push({ text, bullet })
  }

  flush()

  return out
}

/** Cut at a word (or anywhere in CJK) before the cap, with an ellipsis. */
function clamp(text: string): string {
  const chars = Array.from(text)

  if (chars.length <= ASSISTANT_ABOUT_MAX_CHARS) {
    return text
  }

  const head = chars.slice(0, ASSISTANT_ABOUT_MAX_CHARS).join('')
  const space = head.lastIndexOf(' ')
  const cut = space > ASSISTANT_ABOUT_MAX_CHARS * 0.6 ? head.slice(0, space) : head

  return `${cut.replace(/[\s.,;:·]+$/u, '')}…`
}

/**
 * The card's About text (agent card revamp 2026-11-28): what the assistant helps with, as a person
 * reads it. The template's "what it helps with" field (the primary's built-in paragraph too) whole;
 * for a hand-written persona only its first paragraph of prose. Markdown marks, headings, code and
 * lines that are only paths go; whitespace collapses. Empty means nothing to show ("Not set yet.").
 * The raw text is only ever shown in the editor.
 */
export function matrixAssistantAboutSummary(persona: Pick<ParsedPersona, 'kind' | 'what' | 'instructions'>): string {
  const found = paragraphs(persona.kind === 'custom' ? persona.instructions : persona.what)
  const text = persona.kind === 'custom' ? (found[0] ?? '') : found.join(' ')

  return clamp(text)
}
