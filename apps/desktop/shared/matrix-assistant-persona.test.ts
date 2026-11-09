import { describe, expect, it } from 'vitest'

import { parsePersona, renameSoulHeading, renderPersona } from './matrix-assistant-persona'

const TEMPLATE = '# Lan\n\n## Who you are\n\nĐiềm tĩnh.\n\n## What you do\n\nLo lịch họp.'

const SAMPLE_AGENT_CUSTOM =
  "# Sample Agent\n\nYou are Sample Agent, a personal assistant for the example user.\n\n## Working style\n\n- Keep the thread.\n- Be direct.\n"

const SAMPLE_AGENT_WITH_PERSONALITY =
  "# Sample Agent\n\nYou are Sample Agent, a personal assistant for the example user.\n\n## Working style\n\n- Keep the thread.\n\n## Who you are\n\nWarm, exact, and candid.\n\n## Memory\n\nRemember durable decisions.\n"

describe('assistant persona', () => {
  it('reads the new-assistant template as two fields', () => {
    expect(parsePersona(TEMPLATE)).toMatchObject({
      kind: 'template',
      heading: 'Lan',
      who: 'Điềm tĩnh.',
      what: 'Lo lịch họp.'
    })
  })

  it('round-trips: setting a field to what it already says writes the same text', () => {
    const parsed = parsePersona(TEMPLATE)

    expect(renderPersona(parsed, { name: 'Lan', what: 'Lo lịch họp.' })).toBe(TEMPLATE)
  })

  it('changes only the edited section and keeps every other section byte for byte', () => {
    const soul = `${TEMPLATE}\n\n## Rules\n\n- Never  book   Fridays.\n- Ask first.\n`
    const next = renderPersona(parsePersona(soul), { name: 'Lan', who: 'Vui vẻ.' })

    expect(next).toContain('## Who you are\n\nVui vẻ.\n\n## What you do')
    expect(next).toContain('## Rules\n\n- Never  book   Fridays.\n- Ask first.')
    expect(next.startsWith('# Lan\n\n## Who you are')).toBe(true)
  })

  it('drops a section emptied, and adds a missing one in the template’s order', () => {
    const onlyWhat = renderPersona(parsePersona(TEMPLATE), { name: 'Lan', who: '' })

    expect(onlyWhat).toBe('# Lan\n\n## What you do\n\nLo lịch họp.')

    const both = renderPersona(parsePersona(onlyWhat), { name: 'Lan', who: 'Điềm tĩnh.' })

    expect(both).toContain('## What you do\n\nLo lịch họp.')
    expect(both).toContain('## Who you are\n\nĐiềm tĩnh.')
  })

  it('writes a persona from nothing, and nothing back when every field is cleared', () => {
    const fresh = renderPersona(parsePersona(''), { name: 'Mai', what: 'Viết email.' })

    expect(fresh).toBe('# Mai\n\n## What you do\n\nViết email.')
    expect(renderPersona(parsePersona(fresh), { name: 'Mai', what: '' })).toBe('')
  })

  it('keeps an inherited persona’s text above the fields (the primary’s own)', () => {
    const base = '# Atum\n\nYou are Atum, the person’s own assistant.'
    const parsed = parsePersona(base, { inherited: true })

    expect(parsed).toMatchObject({ kind: 'template', who: '', what: '' })
    expect(renderPersona(parsed, { name: 'Atum', what: 'Plan my week.' })).toBe(
      `${base}\n\n## What you do\n\nPlan my week.`
    )
  })

  it('keeps custom instructions and gives them back unchanged', () => {
    const custom = '# Lan\n\nYou are a calm planner.\n\n## Rules\n\nShort answers.'
    const parsed = parsePersona(custom)

    expect(parsed).toMatchObject({
      kind: 'custom',
      instructions: 'You are a calm planner.\n\n## Rules\n\nShort answers.'
    })
    expect(renderPersona(parsed, { name: 'Lan' })).toBe(custom)
    expect(renderPersona(parsePersona('Be brief.'), { name: 'Lan', instructions: 'Be kind.' })).toBe('Be kind.')
  })

  it('round-trips Sample Agent-style custom text without a personality section', () => {
    const parsed = parsePersona(SAMPLE_AGENT_CUSTOM)

    expect(parsed).toMatchObject({
      kind: 'custom',
      heading: 'Sample Agent',
      who: '',
      instructions:
        "You are Sample Agent, a personal assistant for the example user.\n\n## Working style\n\n- Keep the thread.\n- Be direct."
    })
    const composed = renderPersona(parsed, { name: 'Sample Agent' })

    expect(composed).toBe(SAMPLE_AGENT_CUSTOM)
    expect(renderPersona(parsePersona(composed), { name: 'Sample Agent' })).toBe(SAMPLE_AGENT_CUSTOM)
  })

  it('round-trips Sample Agent-style custom text with personality kept out of the main field', () => {
    const parsed = parsePersona(SAMPLE_AGENT_WITH_PERSONALITY)

    expect(parsed).toMatchObject({
      kind: 'custom',
      who: 'Warm, exact, and candid.',
      instructions:
        "You are Sample Agent, a personal assistant for the example user.\n\n## Working style\n\n- Keep the thread.\n\n## Memory\n\nRemember durable decisions."
    })
    const composed = renderPersona(parsed, { name: 'Sample Agent' })

    expect(composed).toBe(SAMPLE_AGENT_WITH_PERSONALITY)
    expect(renderPersona(parsePersona(composed), { name: 'Sample Agent' })).toBe(SAMPLE_AGENT_WITH_PERSONALITY)
  })

  it('changes only a custom personality section', () => {
    const next = renderPersona(parsePersona(SAMPLE_AGENT_WITH_PERSONALITY), {
      name: 'Sample Agent',
      who: 'Calm under pressure.'
    })

    expect(next).toBe(SAMPLE_AGENT_WITH_PERSONALITY.replace('Warm, exact, and candid.', 'Calm under pressure.'))
  })

  it('adds a custom personality and preserves it when the main field is replaced', () => {
    const withPersonality = renderPersona(parsePersona(SAMPLE_AGENT_CUSTOM), {
      name: 'Sample Agent',
      who: 'Warm, exact, and candid.'
    })

    expect(withPersonality).toBe(`${SAMPLE_AGENT_CUSTOM}\n## Who you are\n\nWarm, exact, and candid.`)

    const replaced = renderPersona(parsePersona(withPersonality), {
      name: 'Sample Agent',
      instructions: 'A new hand-written brief.\n\n## Boundaries\n\nAsk before sending.'
    })

    expect(replaced).toBe(
      '# Sample Agent\n\nA new hand-written brief.\n\n## Boundaries\n\nAsk before sending.\n\n## Who you are\n\nWarm, exact, and candid.'
    )
  })

  it('shows the primary’s built-in persona as the same two fields any other assistant has', () => {
    const nameLine =
      'You are Sample Agent, the person’s own assistant in the Atum app. If they give you another name, use it from then on and remember it.'
    const stored = `${nameLine}\n\nYou can do real work for them.\n\nBe warm, brief and capable.`
    const parsed = parsePersona(stored, { primary: true })

    expect(parsed.kind).toBe('primary')
    expect(parsed.who).toBe('')
    expect(parsed.what).toBe('You can do real work for them.\n\nBe warm, brief and capable.')
    // Untouched: the exact bytes, so a save that changes nothing writes nothing.
    expect(renderPersona(parsed, { name: 'Sample Agent' })).toBe(stored)

    const withPersonality = renderPersona(parsed, { name: 'Sample Agent', who: 'Điềm tĩnh.' })

    expect(withPersonality).toBe(`${stored}\n\n## Who you are\n\nĐiềm tĩnh.`)
    expect(parsePersona(withPersonality, { primary: true })).toMatchObject({
      kind: 'primary',
      who: 'Điềm tĩnh.',
      what: 'You can do real work for them.\n\nBe warm, brief and capable.'
    })
  })

  it('keeps the primary’s name line when only “what it does” changes, and drops an emptied body', () => {
    const nameLine =
      'You are Sample Agent, the person’s own assistant in the Atum app. If they want to call you something else, tell them they can change your picture and how you work from your card, and that your name stays Sample Agent.'
    const stored = `# Sample Agent\n\n${nameLine}\n\nYou can do real work for them.`
    const parsed = parsePersona(stored, { primary: true })

    expect(renderPersona(parsed, { name: 'Sample Agent', what: 'Keeps my calendar.' })).toBe(
      `# Sample Agent\n\n${nameLine}\n\nKeeps my calendar.`
    )
    expect(renderPersona(parsed, { name: 'Sample Agent', what: '' })).toBe(`# Sample Agent\n\n${nameLine}`)
  })

  it('leaves a hand-written persona in one field even for the primary', () => {
    const custom = '# Sample Agent\n\nMy own words.\n\n## Rules\n\nShort answers.'

    expect(parsePersona(custom, { primary: true })).toMatchObject({
      kind: 'custom',
      instructions: 'My own words.\n\n## Rules\n\nShort answers.'
    })
    expect(parsePersona('Be brief.', { primary: true }).kind).toBe('custom')
  })

  it('renames only the heading line', () => {
    const soul = `${TEMPLATE}\n\n## Notes\n\nLan likes tea.\n`

    expect(renameSoulHeading(soul, 'Lan Anh')).toBe(soul.replace('# Lan\n', '# Lan Anh\n'))
    expect(renameSoulHeading('No heading here.', 'Lan Anh')).toBe('No heading here.')
    expect(renameSoulHeading('', 'Lan Anh')).toBe('')
  })
})
