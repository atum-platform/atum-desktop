import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as Hermes from '@/hermes'
import type * as ProfileStore from '@/store/profile'

const getProfileSoul = vi.fn()
const updateProfileIdentity = vi.fn()
const updateProfileSoul = vi.fn()
const refreshProfiles = vi.fn()

vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<typeof Hermes>()),
  getProfileSoul,
  updateProfileIdentity,
  updateProfileSoul
}))

vi.mock('@/store/profile', async importOriginal => ({
  ...(await importOriginal<typeof ProfileStore>()),
  refreshProfiles
}))

const { agentSoulDocument } = await import('./create-agent')
const { editAtumAgent, loadAtumAgentInstructions, parseAgentSoulDocument } = await import('./edit-agent')

beforeEach(() => {
  getProfileSoul.mockReset()
  updateProfileIdentity.mockReset().mockResolvedValue({ avatar: '', display_name: '', ok: true })
  updateProfileSoul.mockReset().mockResolvedValue({ ok: true })
  refreshProfiles.mockReset().mockResolvedValue([])
})

describe('parseAgentSoulDocument', () => {
  it('reads back exactly what the create sheet wrote', () => {
    const document = agentSoulDocument({ job: 'Plans campaigns.\n\nDrafts posts.', name: 'Marketing', persona: 'Warm.' })

    expect(parseAgentSoulDocument(document)).toEqual({ job: 'Plans campaigns.\n\nDrafts posts.', persona: 'Warm.' })
  })

  it('treats a missing section or an empty document as empty answers', () => {
    expect(parseAgentSoulDocument(agentSoulDocument({ job: '', name: 'Nhà', persona: '' }))).toEqual({ job: '', persona: '' })
    expect(parseAgentSoulDocument('')).toEqual({ job: '', persona: '' })
    expect(parseAgentSoulDocument(agentSoulDocument({ job: 'Runs the house.', name: 'Nhà', persona: '' }))).toEqual({
      job: 'Runs the house.',
      persona: ''
    })
  })

  it('refuses a document a person wrote by hand rather than flattening it', () => {
    expect(parseAgentSoulDocument('You are a careful editor.\n\n## Who you are\n\nWarm.')).toBeNull()
    expect(parseAgentSoulDocument('# Marketing\n\n## Tone\n\nWarm.')).toBeNull()
    expect(parseAgentSoulDocument('# Marketing\n\n## Who you are\n\nA.\n\n## Who you are\n\nB.')).toBeNull()
    expect(parseAgentSoulDocument('# Marketing\n\nPreamble.\n\n## Who you are\n\nWarm.')).toBeNull()
  })
})

describe('loadAtumAgentInstructions', () => {
  it('reads an absent document as empty answers, never as hand-written', async () => {
    getProfileSoul.mockResolvedValue({ content: '', exists: false })

    expect(await loadAtumAgentInstructions('marketing')).toEqual({ job: '', persona: '' })
    expect(getProfileSoul).toHaveBeenCalledWith('marketing')
  })
})

describe('editAtumAgent', () => {
  it('saves the identity, then the instructions only when asked, then refreshes', async () => {
    await editAtumAgent({ avatar: '📣', id: 'marketing', instructions: { job: 'Plans.', name: 'x', persona: 'Warm.' } as never, name: '  Growth  ' })

    expect(updateProfileIdentity).toHaveBeenCalledWith('marketing', { avatar: '📣', display_name: 'Growth' })
    expect(updateProfileSoul).toHaveBeenCalledWith('marketing', agentSoulDocument({ job: 'Plans.', name: 'Growth', persona: 'Warm.' }))
    expect(refreshProfiles).toHaveBeenCalledOnce()
    expect(updateProfileIdentity.mock.invocationCallOrder[0]!).toBeLessThan(updateProfileSoul.mock.invocationCallOrder[0]!)
  })

  it('leaves the instructions alone when they were not shown or not changed', async () => {
    await editAtumAgent({ avatar: '', id: 'marketing', instructions: null, name: 'Growth' })

    expect(updateProfileIdentity).toHaveBeenCalledOnce()
    expect(updateProfileSoul).not.toHaveBeenCalled()
  })

  it('refuses an empty name and the master assistant before touching anything', async () => {
    await expect(editAtumAgent({ avatar: '', id: 'marketing', instructions: null, name: '   ' })).rejects.toThrow('agent_name_required')
    await expect(editAtumAgent({ avatar: '', id: 'default', instructions: null, name: 'Atum' })).rejects.toThrow('agent_not_editable')
    expect(updateProfileIdentity).not.toHaveBeenCalled()
  })

  it('accepts 40 characters and rejects 41 before writing an identity', async () => {
    await editAtumAgent({ avatar: '', id: 'marketing', instructions: null, name: 'x'.repeat(40) })
    expect(updateProfileIdentity).toHaveBeenCalledWith('marketing', { avatar: '', display_name: 'x'.repeat(40) })

    updateProfileIdentity.mockClear()
    await expect(editAtumAgent({ avatar: '', id: 'marketing', instructions: null, name: 'x'.repeat(41) })).rejects.toThrow(
      'agent_name_too_long'
    )
    expect(updateProfileIdentity).not.toHaveBeenCalled()
  })

  it('does not report a failed refresh as a failed edit', async () => {
    refreshProfiles.mockRejectedValue(new Error('offline'))

    await expect(editAtumAgent({ avatar: '', id: 'marketing', instructions: null, name: 'Growth' })).resolves.toBeUndefined()
  })
})
