import { describe, expect, it, vi } from 'vitest'

import type * as HermesClient from '@/hermes'
import type * as ProfileStore from '@/store/profile'

const createProfile = vi.fn()
const updateProfileSoul = vi.fn()
const refreshProfiles = vi.fn()

vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<typeof HermesClient>()),
  createProfile,
  updateProfileSoul
}))
vi.mock('@/store/profile', async importOriginal => ({
  ...(await importOriginal<typeof ProfileStore>()),
  refreshProfiles
}))

const { agentIdFromName, agentSoulDocument, availableAgentId, createAtumAgent } = await import('./create-agent')
const { ATUM_MANAGED_BY } = await import('./agents')

const agent = (id: string) => ({
  id,
  identityId: '',
  lifecycleRevision: 0,
  title: id,
  avatar: '',
  description: '',
  isDefault: false,
  isManaged: true,
  pinned: false
})

describe('agentIdFromName', () => {
  it('folds Vietnamese tone marks instead of dropping the letters', () => {
    // A user typing their own language must not end up with an id of hyphens.
    expect(agentIdFromName('Trợ lý Marketing')).toBe('tro-ly-marketing')
    expect(agentIdFromName('Đặt vé')).toBe('dat-ve')
    expect(agentIdFromName('Kế hoạch tuần')).toBe('ke-hoach-tuan')
  })

  it('produces a usable id from punctuation, spacing, and case', () => {
    expect(agentIdFromName('  Marketing   Helper  ')).toBe('marketing-helper')
    expect(agentIdFromName('Alfred!!!')).toBe('alfred')
    expect(agentIdFromName('R&D / Ops')).toBe('r-d-ops')
  })

  it('always starts with a letter or digit, whatever it was given', () => {
    // The backend rejects an id that does not, so a name of pure symbols or a
    // leading digit-less string must still yield something it will accept.
    for (const name of ['🌙', '---', '...', '!!!', '   ']) {
      expect(agentIdFromName(name)).toMatch(/^[a-z0-9]/u)
    }

    expect(agentIdFromName('2026 planner')).toBe('2026-planner')
  })

  it('stays short enough for the backend to accept', () => {
    expect(agentIdFromName('x'.repeat(200)).length).toBeLessThanOrEqual(48)
  })
})

describe('availableAgentId', () => {
  it('lets a person make two agents with the same name', () => {
    expect(availableAgentId('Marketing', [])).toBe('marketing')
    expect(availableAgentId('Marketing', ['marketing'])).toBe('marketing-2')
    expect(availableAgentId('Marketing', ['marketing', 'marketing-2'])).toBe('marketing-3')
  })

  it('never collides with the master assistant', () => {
    expect(availableAgentId('Default', [])).toBe('default-2')
  })
})

describe('agentSoulDocument', () => {
  it('puts who the agent is and what it does in one file, under its own headings', () => {
    const soul = agentSoulDocument({ job: 'Plans campaigns.', name: 'Marketing', persona: 'Warm and brief.' })

    expect(soul).toBe('# Marketing\n\n## Who you are\n\nWarm and brief.\n\n## What you do\n\nPlans campaigns.\n')
  })

  it('omits a heading the user left blank rather than writing an empty section', () => {
    expect(agentSoulDocument({ job: '', name: 'Alfred', persona: 'Formal.' })).toBe(
      '# Alfred\n\n## Who you are\n\nFormal.\n'
    )
    expect(agentSoulDocument({ job: '', name: 'Bare', persona: '  ' })).toBe('# Bare\n')
  })
})

describe('createAtumAgent', () => {
  it('creates the profile from the id, stamps it as Atum-made, and clones the master', async () => {
    createProfile.mockResolvedValueOnce({ name: 'tro-ly-marketing', ok: true, path: '/p' })
    updateProfileSoul.mockResolvedValueOnce({ ok: true })

    const result = await createAtumAgent(
      { avatar: '📣', job: 'Plans campaigns.', name: '  Trợ lý Marketing  ', persona: 'Warm.' },
      []
    )

    expect(createProfile).toHaveBeenCalledWith({
      avatar: '📣',
      clone_from: 'default',
      display_name: 'Trợ lý Marketing',
      managed_by: ATUM_MANAGED_BY,
      // The filesystem-safe id, never the display name.
      name: 'tro-ly-marketing'
    })
    expect(updateProfileSoul).toHaveBeenCalledWith('tro-ly-marketing', expect.stringContaining('## Who you are'))
    expect(refreshProfiles).toHaveBeenCalled()
    expect(result).toEqual({ id: 'tro-ly-marketing' })
  })

  it('writes the instructions to the id the server actually made, not the one we guessed', async () => {
    createProfile.mockResolvedValueOnce({ name: 'marketing-7', ok: true, path: '/p' })
    updateProfileSoul.mockResolvedValueOnce({ ok: true })

    const result = await createAtumAgent({ avatar: '', job: 'j', name: 'Marketing', persona: 'p' }, [])

    expect(updateProfileSoul).toHaveBeenCalledWith('marketing-7', expect.any(String))
    expect(result.id).toBe('marketing-7')
  })

  it('picks a free id when the name is already taken', async () => {
    createProfile.mockResolvedValueOnce({ name: 'marketing-2', ok: true, path: '/p' })
    updateProfileSoul.mockResolvedValueOnce({ ok: true })

    await createAtumAgent({ avatar: '', job: '', name: 'Marketing', persona: '' }, [agent('marketing')])

    expect(createProfile).toHaveBeenCalledWith(expect.objectContaining({ name: 'marketing-2' }))
  })

  it('still reports success when only the list refresh fails', async () => {
    // The agent exists and has its instructions by then. Failing here told the
    // user nothing had been made, so they tried again and got a second agent.
    createProfile.mockClear()
    updateProfileSoul.mockClear()
    createProfile.mockResolvedValueOnce({ name: 'marketing', ok: true, path: '/p' })
    updateProfileSoul.mockResolvedValueOnce({ ok: true })
    refreshProfiles.mockRejectedValueOnce(new Error('backend unreachable'))

    await expect(createAtumAgent({ avatar: '', job: 'j', name: 'Marketing', persona: 'p' }, [])).resolves.toEqual({
      id: 'marketing'
    })
  })

  it('refuses a blank name before it touches the backend', async () => {
    createProfile.mockClear()

    await expect(createAtumAgent({ avatar: '', job: 'j', name: '   ', persona: 'p' }, [])).rejects.toThrow(
      'agent_name_required'
    )
    expect(createProfile).not.toHaveBeenCalled()
  })

  it('accepts 40 characters and rejects 41 before creating a profile', async () => {
    createProfile.mockClear()
    createProfile.mockResolvedValueOnce({ name: 'x', ok: true, path: '/p' })
    updateProfileSoul.mockResolvedValueOnce({ ok: true })

    await expect(createAtumAgent({ avatar: '', job: '', name: 'x'.repeat(40), persona: '' }, [])).resolves.toEqual({ id: 'x' })
    expect(createProfile).toHaveBeenCalledWith(expect.objectContaining({ display_name: 'x'.repeat(40) }))

    createProfile.mockClear()
    await expect(createAtumAgent({ avatar: '', job: '', name: 'x'.repeat(41), persona: '' }, [])).rejects.toThrow(
      'agent_name_too_long'
    )
    expect(createProfile).not.toHaveBeenCalled()
  })

  it('surfaces a creation failure without pretending an agent exists', async () => {
    createProfile.mockClear()
    updateProfileSoul.mockClear()
    createProfile.mockRejectedValueOnce(new Error('profile exists'))

    await expect(createAtumAgent({ avatar: '', job: 'j', name: 'Marketing', persona: 'p' }, [])).rejects.toThrow(
      'profile exists'
    )
    expect(updateProfileSoul).not.toHaveBeenCalled()
  })

  it('surfaces an instructions failure, because the agent DOES exist by then', async () => {
    createProfile.mockClear()
    createProfile.mockResolvedValueOnce({ name: 'marketing', ok: true, path: '/p' })
    updateProfileSoul.mockRejectedValueOnce(new Error('disk full'))

    // The caller must be told, so it can say the agent was made but its
    // instructions were not, rather than implying nothing happened.
    await expect(createAtumAgent({ avatar: '', job: 'j', name: 'Marketing', persona: 'p' }, [])).rejects.toThrow(
      'disk full'
    )
    expect(createProfile).toHaveBeenCalled()
  })
})
