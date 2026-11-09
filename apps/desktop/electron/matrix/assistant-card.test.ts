import { describe, expect, it, vi } from 'vitest'

import type { AtumAssistantDefinitionWrite } from '../../shared/atum-agent-portability'
import { PRIMARY_ASSISTANT_KEEPS_NAME } from '../../shared/matrix-assistant-name'

import { MatrixAgentDefinitionError, type MatrixAgentDefinitionSnapshot } from './agent-definition'
import { MATRIX_PRIMARY_CARD_SOUL, MatrixAssistantCards, matrixPrimaryCardSoul } from './assistant-card'
import { ATUM_ASSISTANT_SOUL, matrixPrimarySoul } from './atum-soul'

const LAN = '00000000-0000-4000-8000-bd7662a5eeb4'
const ATUM = '00000000-0000-4000-8000-b454f82c5857'
const LAN_ID = '00000000-0000-4000-8000-f6222a1106ee'
const ATUM_ID = '00000000-0000-4000-8000-f1d11edf5c5c'

function snapshot(
  id: string,
  displayName: string,
  soul: string | null,
  revisions: { definition: number; identity: number } = { definition: 2, identity: 1 }
): MatrixAgentDefinitionSnapshot {
  return {
    assistant: {
      id,
      principal: id === LAN_ID ? LAN : ATUM,
      identityId: id,
      displayName,
      avatar: '🌙|3',
      avatarUrl: null,
      isDefault: id === ATUM_ID,
      lifecycleRevision: 1,
      status: 'active',
      identityRevision: revisions.identity,
      definitionRevision: soul === null ? 0 : revisions.definition
    },
    definition:
      soul === null
        ? null
        : {
            schemaVersion: 1,
            soul,
            modelAlias: 'nhat-thuc',
            reasoning: { effort: 'high' } as never,
            skills: [{ name: 'gmail', sha256: 'a'.repeat(64) }]
          },
    definitionRevision: soul === null ? 0 : revisions.definition,
    identityRevision: revisions.identity
  }
}

function cards(
  records: Record<string, MatrixAgentDefinitionSnapshot>,
  write?: (input: AtumAssistantDefinitionWrite) => MatrixAgentDefinitionSnapshot,
  appNames?: () => readonly string[]
) {
  const writes: AtumAssistantDefinitionWrite[] = []
  const saved = vi.fn()
  const avatars = vi.fn(async (agent: { assistantId: string; principal: string }, avatar: unknown) => {
    const current = records[agent.assistantId] ?? snapshot(agent.assistantId, 'Assistant', '')
    const next = {
      ...current,
      assistant: {
        ...current.assistant,
        avatarUrl: avatar === null ? null : 'https://cdn.atum.test/avatar.webp'
      }
    }
    records[agent.assistantId] = next

    return next
  })

  const value = new MatrixAssistantCards({
    appNames,
    agents: () => [
      { principal: LAN, assistantId: LAN_ID, isDefault: false, name: records[LAN_ID]?.assistant.displayName ?? 'Lan' },
      { principal: ATUM, assistantId: ATUM_ID, isDefault: true, name: 'Atum' },
      {
        principal: '00000000-0000-4000-8000-fbfe405ca65f',
        assistantId: '00000000-0000-4000-8000-a9703d75e616',
        isDefault: false,
        name: 'Mai'
      }
    ],
    read: async id => records[id]!,
    write: async (id, input) => {
      writes.push(input)

      const next = write
        ? write(input)
        : snapshot(id, input.displayName, input.definition.soul, { definition: 3, identity: 2 })

      records[id] = next

      return next
    },
    avatar: avatars,
    saved
  })

  return { cards: value, writes, avatars, saved }
}

describe('the assistant card, natively', () => {
  it('renames with one write: the new name, its persona heading, everything else as stored', async () => {
    const soul = '# Lan\n\n## What you do\n\nMeetings.\n\n## Rules\n\nKeep it short.'
    const { cards: subject, writes, saved } = cards({ [LAN_ID]: snapshot(LAN_ID, 'Lan', soul) })

    const result = await subject.save({
      principal: LAN,
      expectedDefinitionRevision: 2,
      expectedIdentityRevision: 1,
      displayName: '  Lan   Anh '
    })

    expect(result).toMatchObject({ ok: true, card: { displayName: 'Lan Anh', definitionRevision: 3 } })
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({
      expectedDefinitionRevision: 2,
      expectedIdentityRevision: 1,
      displayName: 'Lan Anh',
      avatar: '🌙|3',
      definition: {
        soul: soul.replace('# Lan\n', '# Lan Anh\n'),
        modelAlias: 'nhat-thuc',
        reasoning: { effort: 'high' },
        skills: [{ name: 'gmail', sha256: 'a'.repeat(64) }]
      }
    })
    expect(saved).toHaveBeenCalledOnce()
  })

  it('refuses Atum’s names, look-alikes, duplicates and invisible characters before writing', async () => {
    const { cards: subject, writes } = cards({ [LAN_ID]: snapshot(LAN_ID, 'Lan', '') })
    const base = { principal: LAN, expectedDefinitionRevision: 2, expectedIdentityRevision: 1 }

    await expect(subject.save({ ...base, displayName: 'MOON' })).resolves.toEqual({ ok: false, error: 'reserved' })
    await expect(subject.save({ ...base, displayName: 'Mòon' })).resolves.toEqual({ ok: false, error: 'reserved' })
    await expect(subject.save({ ...base, displayName: 'mai' })).resolves.toEqual({ ok: false, error: 'duplicate' })
    await expect(subject.save({ ...base, displayName: 'Lan\u200B' })).resolves.toEqual({ ok: false, error: 'invalid' })
    // The window is not trusted to have checked: other scripts, look-alikes, hidden characters,
    // fake marks, Atum's names inside a longer name or behind a glued shape.
    await expect(subject.save({ ...base, displayName: '\u0410tum' })).resolves.toEqual({ ok: false, error: 'invalid' })
    await expect(subject.save({ ...base, displayName: '\uA4EEtum' })).resolves.toEqual({ ok: false, error: 'invalid' })
    await expect(subject.save({ ...base, displayName: '\u{1F170}\uFE0Ftum' })).resolves.toEqual({
      ok: false,
      error: 'invalid'
    })
    await expect(subject.save({ ...base, displayName: 'Founder Atum' })).resolves.toEqual({
      ok: false,
      error: 'reserved'
    })
    await expect(subject.save({ ...base, displayName: 'M\u53E3\u53E3n' })).resolves.toEqual({
      ok: false,
      error: 'reserved'
    })
    await expect(subject.save({ ...base, displayName: 'AncIy' })).resolves.toEqual({ ok: false, error: 'reserved' })
    await expect(subject.save({ ...base, displayName: '\u3055\u304F\u3089\uBBFC\uC218' })).resolves.toEqual({
      ok: false,
      error: 'invalid'
    })
    await expect(subject.save({ ...base, displayName: '\uFF21\uFF54\uFF55\uFF4D' })).resolves.toEqual({
      ok: false,
      error: 'reserved'
    })
    await expect(subject.save({ ...base, displayName: 'Atum Support' })).resolves.toEqual({
      ok: false,
      error: 'reserved'
    })
    await expect(subject.save({ ...base, displayName: 'Mo\u00ADon' })).resolves.toEqual({ ok: false, error: 'invalid' })
    await expect(subject.save({ ...base, displayName: 'Moo\u200En' })).resolves.toEqual({ ok: false, error: 'invalid' })
    await expect(subject.save({ ...base, displayName: 'Lan \u2713' })).resolves.toEqual({ ok: false, error: 'invalid' })
    await expect(subject.save({ ...base, displayName: '\u2800' })).resolves.toEqual({ ok: false, error: 'invalid' })
    await expect(subject.save({ ...base, displayName: 'M\u0430i' })).resolves.toEqual({ ok: false, error: 'invalid' })
    await expect(subject.save({ ...base, displayName: 'MAI' })).resolves.toEqual({ ok: false, error: 'duplicate' })
    expect(writes).toHaveLength(0)
  })

  it('refuses the name an app in the current catalog goes by, read when the name is saved', async () => {
    const names: string[] = []
    const { cards: subject, writes } = cards({ [LAN_ID]: snapshot(LAN_ID, 'Lan', '') }, undefined, () => names)
    const base = { principal: LAN, expectedDefinitionRevision: 2, expectedIdentityRevision: 1 }

    // The catalog gains an app after this Mac started: nothing here knows it by name.
    names.push('Demoza', 'eTax Mobile')

    for (const displayName of ['Demoza', 'démôza', 'Demoza Official', 'ETAX MOBILE']) {
      await expect(subject.save({ ...base, displayName }), displayName).resolves.toEqual({
        ok: false,
        error: 'reserved'
      })
    }

    expect(writes).toHaveLength(0)

    // A person's name with the app's in it is the owner's to give, as Andy's and Moon's are.
    await expect(subject.save({ ...base, displayName: 'Demoza Nguyễn' })).resolves.toMatchObject({ ok: true })
    expect(writes).toHaveLength(1)
  })

  it('renames the primary only as owner decision D1 allows', async () => {
    const { cards: subject, writes } = cards({ [ATUM_ID]: snapshot(ATUM_ID, 'Atum', '') })

    const result = await subject.save({
      principal: ATUM,
      expectedDefinitionRevision: 2,
      expectedIdentityRevision: 1,
      displayName: 'Sao'
    })

    if (PRIMARY_ASSISTANT_KEEPS_NAME) {
      expect(result).toEqual({ ok: false, error: 'locked' })
      expect(writes).toHaveLength(0)
    } else {
      // No persona of its own is written: the built-in one now goes by the new name.
      expect(result).toMatchObject({
        ok: true,
        card: { displayName: 'Sao', inherited: true, soul: matrixPrimaryCardSoul('Sao') }
      })
      expect(writes[0]).toMatchObject({ displayName: 'Sao', definition: { soul: '' } })
      expect(matrixPrimaryCardSoul('Sao')).toBe(`# Sao\n\n${matrixPrimarySoul('Sao')}`)
    }
  })

  it('lets the primary go back to Atum, and no other assistant take it', async () => {
    const { cards: subject, writes } = cards({
      [ATUM_ID]: snapshot(ATUM_ID, 'Sao', ''),
      [LAN_ID]: snapshot(LAN_ID, 'Lan', '')
    })

    await expect(
      subject.save({ principal: LAN, expectedDefinitionRevision: 2, expectedIdentityRevision: 1, displayName: 'Atum' })
    ).resolves.toEqual({ ok: false, error: 'reserved' })

    const back = await subject.save({
      principal: ATUM,
      expectedDefinitionRevision: 2,
      expectedIdentityRevision: 1,
      displayName: 'Atum'
    })

    expect(back).toMatchObject(
      PRIMARY_ASSISTANT_KEEPS_NAME ? { ok: false, error: 'locked' } : { ok: true, card: { displayName: 'Atum' } }
    )
    expect(writes).toHaveLength(PRIMARY_ASSISTANT_KEEPS_NAME ? 0 : 1)
  })

  it('renames the primary’s own persona: its heading and Atum’s first line, nothing else', async () => {
    const stored = `# Atum\n\n${ATUM_ASSISTANT_SOUL}\n\n## What you do\n\nPlan my week, like Atum would.`
    const { cards: subject, writes } = cards({ [ATUM_ID]: snapshot(ATUM_ID, 'Atum', stored) })

    const result = await subject.save({
      principal: ATUM,
      expectedDefinitionRevision: 2,
      expectedIdentityRevision: 1,
      displayName: 'Sao'
    })

    if (PRIMARY_ASSISTANT_KEEPS_NAME) {
      expect(result).toEqual({ ok: false, error: 'locked' })
    } else {
      expect(writes[0]!.definition.soul).toBe(
        `# Sao\n\n${matrixPrimarySoul('Sao')}\n\n## What you do\n\nPlan my week, like Atum would.`
      )
    }
  })

  it('keeps the persona’s heading on the stored name, whatever heading the window sent', async () => {
    const stored = '# Lan Anh\n\n## What you do\n\nMeetings.'
    const { cards: subject, writes } = cards({ [LAN_ID]: snapshot(LAN_ID, 'Lan Anh', stored) })

    // Built before the rename landed (a queued save, an Undo of an older edit): "# Lan".
    await subject.save({
      principal: LAN,
      expectedDefinitionRevision: 2,
      expectedIdentityRevision: 1,
      soul: '# Lan\n\n## What you do\n\nMeetings and email.'
    })

    expect(writes[0]!.definition.soul).toBe('# Lan Anh\n\n## What you do\n\nMeetings and email.')
  })

  it('shows the primary its built-in persona until one is written', async () => {
    const { cards: subject } = cards({
      [ATUM_ID]: snapshot(ATUM_ID, 'Atum', null),
      [LAN_ID]: snapshot(LAN_ID, 'Lan', '')
    })

    await expect(subject.read(ATUM)).resolves.toMatchObject({
      ok: true,
      card: { soul: MATRIX_PRIMARY_CARD_SOUL, inherited: true, isDefault: true, definitionRevision: 0 }
    })
  })

  it('answers a stale card with the latest record, and writes nothing', async () => {
    const records = { [LAN_ID]: snapshot(LAN_ID, 'Lan B', '# Lan B', { definition: 5, identity: 3 }) }
    const { cards: subject, writes } = cards(records)

    await expect(
      subject.save({
        principal: LAN,
        expectedDefinitionRevision: 2,
        expectedIdentityRevision: 1,
        displayName: 'Lan Anh'
      })
    ).resolves.toMatchObject({ ok: false, error: 'conflict', card: { displayName: 'Lan B', definitionRevision: 5 } })
    expect(writes).toHaveLength(0)
  })

  it('maps the platform’s refusals: a lost race is a conflict, a refused name is reserved', async () => {
    const conflict = cards({ [LAN_ID]: snapshot(LAN_ID, 'Lan', '') }, () => {
      throw new MatrixAgentDefinitionError('conflict')
    })

    await expect(
      conflict.cards.save({
        principal: LAN,
        expectedDefinitionRevision: 2,
        expectedIdentityRevision: 1,
        displayName: 'Lan Anh'
      })
    ).resolves.toMatchObject({ ok: false, error: 'conflict', card: { displayName: 'Lan' } })

    const refused = cards({ [LAN_ID]: snapshot(LAN_ID, 'Lan', '') }, () => {
      throw new MatrixAgentDefinitionError('invalid')
    })

    await expect(
      refused.cards.save({
        principal: LAN,
        expectedDefinitionRevision: 2,
        expectedIdentityRevision: 1,
        displayName: 'Taylor Swift'
      })
    ).resolves.toEqual({ ok: false, error: 'reserved' })

    const offline = cards({ [LAN_ID]: snapshot(LAN_ID, 'Lan', '') }, () => {
      throw new MatrixAgentDefinitionError('unavailable')
    })

    await expect(
      offline.cards.save({
        principal: LAN,
        expectedDefinitionRevision: 2,
        expectedIdentityRevision: 1,
        soul: '# Lan\n\nHi.'
      })
    ).resolves.toEqual({ ok: false, error: 'offline' })
  })

  it('writes nothing when nothing changed, and nothing for an unknown or malformed request', async () => {
    const { cards: subject, writes } = cards({ [LAN_ID]: snapshot(LAN_ID, 'Lan', '# Lan') })

    await expect(
      subject.save({ principal: LAN, expectedDefinitionRevision: 2, expectedIdentityRevision: 1, displayName: 'Lan' })
    ).resolves.toMatchObject({ ok: true })
    await expect(
      subject.save({ principal: 'nobody', expectedDefinitionRevision: 2, expectedIdentityRevision: 1, soul: '' })
    ).resolves.toEqual({
      ok: false,
      error: 'invalid'
    })
    await expect(subject.read('00000000-0000-4000-8000-e8d95748107a')).resolves.toEqual({ ok: false, error: 'missing' })
    expect(writes).toHaveLength(0)
  })

  it('writes and clears an owned agent avatar through the canonical card callback', async () => {
    const { cards: subject, avatars } = cards({ [LAN_ID]: snapshot(LAN_ID, 'Lan', '# Lan') })
    const bytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])

    await expect(subject.avatar({ principal: LAN, avatar: { type: 'image/webp', bytes } })).resolves.toEqual({
      ok: true,
      avatarUrl: 'https://cdn.atum.test/avatar.webp'
    })
    expect(avatars).toHaveBeenCalledWith(
      expect.objectContaining({ principal: LAN, assistantId: LAN_ID }),
      { type: 'image/webp', bytes },
      expect.any(AbortSignal)
    )
    await expect(subject.avatar({ principal: LAN, avatar: null })).resolves.toEqual({ ok: true, avatarUrl: null })
    await expect(subject.avatar({ principal: 'not-a-principal', avatar: null })).resolves.toEqual({
      ok: false,
      error: 'invalid'
    })
    expect(avatars).toHaveBeenCalledTimes(2)
  })
})
