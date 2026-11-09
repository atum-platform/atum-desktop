/**
 * An assistant's persona (its definition's `soul`, written to SOUL.md on each Mac), as the
 * assistant card edits it. The new-assistant questions write a small template:
 *
 *   # Name
 *
 *   ## Who you are
 *
 *   …
 *
 *   ## What you do
 *
 *   …
 *
 * The card shows those two sections as two fields. Everything else in the text — anything
 * before the first section, any other section — is kept byte for byte, so an imported or
 * hand-written persona never loses what the card does not show.
 */

export const PERSONA_WHO = 'Who you are'
export const PERSONA_WHAT = 'What you do'

interface PersonaSection {
  title: string
  /** The section exactly as written: its `## ` line, its body and the space after it. */
  raw: string
}

export interface ParsedPersona {
  /**
   * `template`: the two fields; `primary`: the primary assistant's built-in persona, shown as the
   * same two fields (its first line names the assistant); `custom`: hand-written text shown in
   * the same two fields without turning its own sections into the template.
   */
  kind: 'template' | 'custom' | 'primary'
  /** The `# Name` line's name, when the text starts with one. */
  heading?: string
  /** Primary only: the built-in first line, exactly as written (the name line stays the
   * platform's to keep in step, so a card render never rewrites it). */
  nameLine?: string
  who: string
  what: string
  /** Custom only: the whole text after the heading line, except `Who you are` sections. */
  instructions: string
  /** Everything before the first section (the heading line included), exactly as written. */
  head: string
  sections: PersonaSection[]
}

const HEADING = /^# (.+)$/m
const SECTION = /^## (.+?)[ \t]*$/gm

/** The primary assistant's built-in first line, for any name and either D1 answer (atum-soul.ts
 * writes it; this only has to recognize it so the card shows the same two fields as any other
 * assistant). A hand-written persona that happens to start this way is still the owner's text. */
const PRIMARY_NAME_LINE =
  /^You are [^\n]{1,80}, the person’s own assistant in the Atum app\. (?:If they give you another name, use it from then on and remember it\.|If they want to call you something else, tell them they can change your picture and how you work from your card, and that your name stays [^\n]{1,80}\.)$/

/** The primary's built-in shape: an optional `# Name` line, the name line, then its body (and,
 * once the owner adds one, a `## Who you are` section). Its "what" is the body, which the card
 * shows in the same field any other assistant's "what" goes in. */
function primaryParts(
  soul: string,
  heading: string | undefined,
  sections: PersonaSection[]
): { nameLine: string; what: string } | undefined {
  const rest = heading !== undefined ? soul.replace(/^\s*# [^\r\n]*(?:\r?\n|$)/, '') : soul
  const line = rest.trimStart().split(/\r?\n/, 1)[0] ?? ''

  if (!PRIMARY_NAME_LINE.test(line)) {
    return undefined
  }

  const lineStart = soul.indexOf(line, heading !== undefined ? soul.indexOf('\n') + 1 : 0)

  if (lineStart < 0) {
    return undefined
  }

  const bodyStart = lineStart + line.length
  const bodyEnd = sections[0]?.raw ? soul.indexOf(sections[0]!.raw, bodyStart) : soul.length
  const body = soul.slice(bodyStart, bodyEnd < 0 ? soul.length : bodyEnd).trim()

  return { nameLine: line, what: body }
}

function sectionBody(section: PersonaSection): string {
  return section.raw.replace(/^## .*(?:\r?\n|$)/, '').trim()
}

function rawPersona(parsed: ParsedPersona): string {
  return `${parsed.head}${parsed.sections.map(each => each.raw).join('')}`
}

function withoutHeading(soul: string, heading: string | undefined): string {
  return heading === undefined ? soul.trim() : soul.replace(/^\s*# [^\r\n]*(?:\r?\n|$)/, '').trim()
}

/** Splits a persona into its head and its sections, without changing a byte of either. */
export function parsePersona(
  soul: string,
  options: { inherited?: boolean; primary?: boolean } = {}
): ParsedPersona {
  const starts = [...soul.matchAll(SECTION)].map(match => ({ index: match.index!, title: match[1]!.trim() }))
  const head = starts.length ? soul.slice(0, starts[0]!.index) : soul

  const sections = starts.map((start, index) => ({
    title: start.title,
    raw: soul.slice(start.index, starts[index + 1]?.index ?? soul.length)
  }))

  const headingMatch = soul.trimStart().startsWith('# ') ? HEADING.exec(soul) : null
  const heading = headingMatch?.[1]?.trim()
  const find = (title: string) => sections.find(section => section.title === title)

  // The primary's own persona is the same kind of tool as any other assistant's: two fields, a
  // "what" and a personality. It carries no `##` sections and starts with the name line instead,
  // so it is recognized here and offered as the template. A custom persona the person wrote keeps
  // its own text shape; only the built-in primary shape (and the platform's seed of it) becomes
  // primary.
  if (options.primary && !find(PERSONA_WHAT)) {
    const primary = primaryParts(soul, heading, sections)

    if (primary) {
      return {
        kind: 'primary',
        ...(heading !== undefined ? { heading } : {}),
        nameLine: primary.nameLine,
        who: find(PERSONA_WHO) ? sectionBody(find(PERSONA_WHO)!) : '',
        what: primary.what,
        instructions: '',
        head,
        sections
      }
    }
  }

  // A `Who you are` section can also be added to an otherwise hand-written persona by the card.
  // Keep that persona custom: the template is identified by its `What you do` section, or by the
  // Preserve user-visible identity, state and recovery behavior across connection changes.
  // sections must never become the template merely because it gains a personality.
  const headAfterHeading = withoutHeading(head, heading)

  const template =
    !soul.trim() ||
    options.inherited ||
    (heading !== undefined && Boolean(find(PERSONA_WHAT))) ||
    (heading !== undefined && !headAfterHeading && sections[0]?.title === PERSONA_WHO)

  const customText = `${head}${sections
    .filter(each => each.title !== PERSONA_WHO)
    .map(each => each.raw)
    .join('')}`

  return {
    kind: template ? 'template' : 'custom',
    ...(heading !== undefined ? { heading } : {}),
    who: find(PERSONA_WHO) ? sectionBody(find(PERSONA_WHO)!) : '',
    what: find(PERSONA_WHAT) ? sectionBody(find(PERSONA_WHAT)!) : '',
    instructions: template ? '' : withoutHeading(customText, heading),
    head,
    sections
  }
}

function section(title: string, body: string): string {
  return `## ${title}\n\n${body.trim()}`
}

function appendSection(soul: string, raw: string): string {
  if (!soul) {
    return raw
  }

  const newline = soul.includes('\r\n') ? '\r\n' : '\n'
  const gap = soul.endsWith(`${newline}${newline}`) ? '' : soul.endsWith(newline) ? newline : `${newline}${newline}`

  return `${soul}${gap}${raw}`
}

function renderCustomWho(parsed: ParsedPersona, who: string): string {
  let found = false
  let soul = parsed.head

  for (const each of parsed.sections) {
    if (each.title !== PERSONA_WHO) {
      soul += each.raw

      continue
    }

    if (found) {
      continue
    }

    found = true

    if (who === sectionBody(each)) {
      soul += each.raw
    } else if (who) {
      soul += `${section(PERSONA_WHO, who)}${separator(each.raw)}`
    }
  }

  return who && !found ? appendSection(soul, section(PERSONA_WHO, who)) : soul
}

function renderCustomMain(parsed: ParsedPersona, instructions: string): string {
  const original = rawPersona(parsed)
  const heading = parsed.heading === undefined ? undefined : /^(\s*# [^\r\n]*)/.exec(original)?.[1]
  const newline = original.includes('\r\n') ? '\r\n' : '\n'

  if (heading === undefined) {
    return instructions
  }

  return instructions ? `${heading}${newline}${newline}${instructions}` : heading
}

/**
 * The persona with the two fields set. Untouched sections and the head are kept exactly;
 * an emptied field drops its section; a new one is added in the template's order. With no
 * persona at all and nothing typed, the result is empty (the assistant keeps Atum's own).
 */
export function renderPersona(
  parsed: ParsedPersona,
  change: { name: string; who?: string; what?: string; instructions?: string }
): string {
  if (parsed.kind === 'primary') {
    const who = (change.who ?? parsed.who).trim()
    const what = (change.what ?? parsed.what).trim()
    const heading = parsed.heading !== undefined ? `# ${change.name}` : undefined
    const head = [heading, parsed.nameLine].filter((line): line is string => line !== undefined).join('\n\n')
    const body = what ? `\n\n${what}` : ''
    let sections = ''

    for (const each of parsed.sections) {
      if (each.title === PERSONA_WHO) {
        if (who === sectionBody(each)) {
          sections += each.raw
        } else if (who) {
          sections += `${section(PERSONA_WHO, who)}${separator(each.raw)}`
        }
      } else {
        sections += each.raw
      }
    }

    if (who && !parsed.sections.some(each => each.title === PERSONA_WHO)) {
      sections = `## ${PERSONA_WHO}\n\n${who}${sections ? `\n\n${sections.trimStart()}` : ''}`
    }

    return [`${head}${body}`, sections.trim()].filter(Boolean).join('\n\n').replace(/\s+$/, '')
  }

  if (parsed.kind === 'custom') {
    const original = rawPersona(parsed)
    const instructions = (change.instructions ?? parsed.instructions).trim()
    const who = (change.who ?? parsed.who).trim()
    const instructionsChanged = change.instructions !== undefined && instructions !== parsed.instructions.trim()
    const whoChanged = change.who !== undefined && who !== parsed.who.trim()

    if (!instructionsChanged && !whoChanged) {
      return original
    }

    if (!instructionsChanged) {
      return renderCustomWho(parsed, who)
    }

    let soul = renderCustomMain(parsed, instructions)

    if (whoChanged) {
      return who ? appendSection(soul, section(PERSONA_WHO, who)) : soul
    }

    for (const each of parsed.sections) {
      if (each.title === PERSONA_WHO) {
        soul = appendSection(soul, each.raw)
      }
    }

    return soul
  }

  const who = (change.who ?? parsed.who).trim()
  const what = (change.what ?? parsed.what).trim()
  const values: Record<string, string> = { [PERSONA_WHO]: who, [PERSONA_WHAT]: what }
  const parts: string[] = []
  const seen = new Set<string>()

  for (const each of parsed.sections) {
    if (each.title in values) {
      if (seen.has(each.title)) {
        continue
      }

      seen.add(each.title)
      const value = values[each.title]!

      // Unchanged: exactly as it was written.
      if (value === sectionBody(each)) {
        parts.push(each.raw)
      } else if (value) {
        parts.push(`${section(each.title, value)}${separator(each.raw)}`)
      }
    } else {
      parts.push(each.raw)
    }
  }

  // New sections, in the template's order: who before what, after anything already there.
  for (const title of [PERSONA_WHO, PERSONA_WHAT]) {
    if (!seen.has(title) && values[title]) {
      const before = parts.length ? parts.pop()! : undefined

      if (before !== undefined) {
        parts.push(before.replace(/\s*$/, '\n\n'))
      }

      parts.push(section(title, values[title]!))
    }
  }

  const head = parsed.head
  const onlyHeading = !head.trim() || /^\s*# [^\r\n]*\s*$/.test(head)

  // Nothing left but (at most) a heading: no persona, so the assistant keeps Atum's own.
  if (!parts.length && onlyHeading) {
    return ''
  }

  const lead = !head.trim() ? `# ${change.name}\n\n` : parts.length ? head.replace(/\s*$/, '\n\n') : head

  return `${lead}${parts.join('')}`.replace(/\s+$/, '')
}

function separator(raw: string): string {
  const match = /\s*$/.exec(raw)

  return match?.[0] ?? ''
}

/**
 * The persona after a rename: only its `# Old` heading line becomes `# New`. Every other
 * byte stays. A persona without a heading (or none at all) is unchanged.
 */
export function renameSoulHeading(soul: string, name: string): string {
  const leading = /^(\s*)# [^\r\n]*/.exec(soul)

  if (!leading) {
    return soul
  }

  return `${leading[1]}# ${name}${soul.slice(leading[0].length)}`
}
