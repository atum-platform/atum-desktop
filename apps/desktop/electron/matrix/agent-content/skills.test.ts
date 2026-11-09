import { describe, expect, it, vi } from 'vitest'

import type { AtumSkillBundle } from '../../../shared/atum-agent-content'
import type { AtumPortableSkillRef } from '../../../shared/atum-agent-portability'
import { MatrixAgentDefinitionError } from '../agent-definition'

import {
  MATRIX_AGENT_SKILL_BATCH_BYTES,
  MatrixAgentContentInvalid,
  parseMatrixAgentSkillsReport,
  syncMatrixAgentSkills
} from './skills'

const hash = (n: number) => n.toString(16).padStart(64, '0')
const ref = (n: number): AtumPortableSkillRef => ({ name: `skills/s${n}`, sha256: hash(n) })

function bundle(n: number, bytes = 16): AtumSkillBundle {
  return { schema_version: 1, sha256: hash(n), files: [{ path: 'SKILL.md', content_base64: 'A'.repeat(bytes) }] }
}

/** A home that holds whatever it was given, and reports every skill it was asked about. */
function home(initial: Record<string, string> = {}) {
  const states = new Map(Object.entries(initial))

  const report = (skills: AtumPortableSkillRef[]) => ({
    ok: true,
    receipt: 'ok',
    skills: skills.map(skill => ({
      name: skill.name,
      sha256: skill.sha256,
      state: states.get(skill.name) ?? 'missing'
    }))
  })

  const install = vi.fn(async ({ skills, bundles }: { skills: AtumPortableSkillRef[]; bundles: AtumSkillBundle[] }) => {
    const value = report(skills)

    for (const row of value.skills) {
      if (row.state === 'missing' && bundles.some(each => each.sha256 === row.sha256)) {
        states.set(row.name, 'installed')
        Object.assign(row, { state: 'installed', detail: 'new' })
      }
    }

    return value
  })

  return { check: vi.fn(async ({ skills }: { skills: AtumPortableSkillRef[] }) => report(skills)), install }
}

describe('bringing declared skills to this Mac', () => {
  it('downloads exactly what is missing, installs it, and keeps what is here', async () => {
    const skills = [ref(1), ref(2), ref(3)]
    const local = home({ 'skills/s1': 'bundled_version' })
    const fetch = vi.fn(async (sha256: string) => bundle(parseInt(sha256, 16)))

    const report = await syncMatrixAgentSkills(skills, { ...local, fetch, live: () => true })

    expect(fetch.mock.calls.map(([sha256]) => sha256)).toEqual([hash(2), hash(3)])
    expect(local.install).toHaveBeenCalledTimes(1)
    expect(report?.skills.map(skill => [skill.name, skill.state, skill.detail])).toEqual([
      ['skills/s1', 'bundled_version', undefined],
      ['skills/s2', 'installed', 'new'],
      ['skills/s3', 'installed', 'new']
    ])
  })

  it('makes nothing to do cost one check and no download', async () => {
    const local = home({ 'skills/s1': 'installed' })
    const fetch = vi.fn()

    await syncMatrixAgentSkills([ref(1)], { ...local, fetch, live: () => true })
    expect(fetch).not.toHaveBeenCalled()
    expect(local.install).not.toHaveBeenCalled()
  })

  it('keeps one failed download from holding up the others, and says which failed and why', async () => {
    const local = home()

    const fetch = vi.fn(async (sha256: string) => {
      if (sha256 === hash(2)) {
        throw new MatrixAgentDefinitionError('unavailable')
      }

      if (sha256 === hash(3)) {
        throw new MatrixAgentDefinitionError('conflict')
      }

      return bundle(parseInt(sha256, 16))
    })

    const report = await syncMatrixAgentSkills([ref(1), ref(2), ref(3), ref(4)], { ...local, fetch, live: () => true })

    expect(report?.skills.map(skill => [skill.state, skill.detail])).toEqual([
      ['installed', 'new'],
      ['unavailable', 'unavailable'],
      ['unavailable', 'conflict'],
      ['installed', 'new']
    ])
  })

  it('stops downloading once the grant is refused', async () => {
    const local = home()

    const fetch = vi.fn(async () => {
      throw new MatrixAgentDefinitionError('denied')
    })

    const skills = Array.from({ length: 10 }, (_, n) => ref(n + 1))

    const report = await syncMatrixAgentSkills(skills, { ...local, fetch, live: () => true })

    expect(fetch).toHaveBeenCalledTimes(4)
    expect(new Set(report?.skills.map(skill => `${skill.state}:${skill.detail}`))).toEqual(
      new Set(['unavailable:denied'])
    )
    expect(local.install).not.toHaveBeenCalled()
  })

  it('still installs what came before a refusal in a later group, and asks for nothing after it', async () => {
    const local = home()

    const fetch = vi.fn(async (sha256: string) => {
      if (parseInt(sha256, 16) >= 6) {
        throw new MatrixAgentDefinitionError('denied')
      }

      return bundle(parseInt(sha256, 16))
    })

    const skills = Array.from({ length: 12 }, (_, n) => ref(n + 1))
    const report = await syncMatrixAgentSkills(skills, { ...local, fetch, live: () => true })

    expect(fetch).toHaveBeenCalledTimes(8)
    expect(report?.skills.map(skill => `${skill.state}:${skill.detail ?? ''}`)).toEqual([
      ...Array.from({ length: 5 }, () => 'installed:new'),
      ...Array.from({ length: 7 }, () => 'unavailable:denied')
    ])
  })

  it('downloads a bundle once for every declared name that uses it', async () => {
    const local = home()
    const fetch = vi.fn(async (sha256: string) => bundle(parseInt(sha256, 16)))
    const shared = [ref(1), { name: 'skills/also-s1', sha256: hash(1) }]

    const report = await syncMatrixAgentSkills(shared, { ...local, fetch, live: () => true })

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(local.install.mock.calls[0]?.[0].bundles).toHaveLength(1)
    expect(report?.skills.map(skill => skill.state)).toEqual(['installed', 'installed'])
  })

  it('installs large content in bounded batches', async () => {
    const local = home()
    const large = Math.floor(MATRIX_AGENT_SKILL_BATCH_BYTES / 3)
    const fetch = vi.fn(async (sha256: string) => bundle(parseInt(sha256, 16), large))

    const report = await syncMatrixAgentSkills([ref(1), ref(2), ref(3), ref(4), ref(5)], {
      ...local,
      fetch,
      live: () => true
    })

    const sizes = local.install.mock.calls.map(([request]) => Buffer.byteLength(JSON.stringify(request.bundles)))
    expect(local.install.mock.calls.length).toBeGreaterThan(1)
    expect(Math.max(...sizes)).toBeLessThanOrEqual(MATRIX_AGENT_SKILL_BATCH_BYTES + 1024)
    expect(report?.skills.every(skill => skill.state === 'installed')).toBe(true)
  })

  it('stops without installing when the agent is retired or the account signs out mid-download', async () => {
    const local = home()
    let live = true

    const fetch = vi.fn(async (sha256: string) => {
      live = false

      return bundle(parseInt(sha256, 16))
    })

    await expect(
      syncMatrixAgentSkills([ref(1), ref(2)], { ...local, fetch, live: () => live })
    ).resolves.toBeUndefined()
    expect(local.install).not.toHaveBeenCalled()

    const idle = home()
    await expect(syncMatrixAgentSkills([ref(1)], { ...idle, fetch, live: () => false })).resolves.toBeUndefined()
    expect(idle.check).not.toHaveBeenCalled()
  })

  it('keeps the receipt reset the check found after the installs', async () => {
    const local = home()
    local.check.mockImplementationOnce(async ({ skills }) => ({
      ok: true,
      receipt: 'reset',
      skills: skills.map(skill => ({ ...skill, state: 'missing' }))
    }))

    const report = await syncMatrixAgentSkills([ref(1)], {
      ...local,
      fetch: async () => bundle(1),
      live: () => true
    })

    expect(report?.receiptReset).toBe(true)
  })
})

describe("the home's report", () => {
  const requested = [ref(1), ref(2)]
  const row = (n: number, extra: Record<string, unknown> = {}) => ({ ...ref(n), state: 'installed', ...extra })

  it('accepts exactly the requested skills in known states', () => {
    expect(
      parseMatrixAgentSkillsReport(
        { ok: true, receipt: 'ok', skills: [row(1), row(2, { state: 'different', detail: 'local_edit' })] },
        requested
      ).skills
    ).toEqual([row(1), row(2, { state: 'different', detail: 'local_edit' })])
  })

  it.each([
    ['a failure', { ok: false, error: 'agent_content_busy' }],
    ['another skill', { ok: true, receipt: 'ok', skills: [row(1), row(3)] }],
    ['another hash', { ok: true, receipt: 'ok', skills: [row(1), { ...row(2), sha256: hash(9) }] }],
    ['a skill twice', { ok: true, receipt: 'ok', skills: [row(1), row(1)] }],
    ['an unknown state', { ok: true, receipt: 'ok', skills: [row(1), row(2, { state: 'mostly' })] }],
    ['an unknown detail', { ok: true, receipt: 'ok', skills: [row(1), row(2, { detail: 'maybe' })] }],
    [
      'a state only main assigns',
      { ok: true, receipt: 'ok', skills: [row(1), row(2, { state: 'unavailable', detail: 'denied' })] }
    ],
    ['an unknown receipt', { ok: true, receipt: 'fine', skills: [row(1), row(2)] }]
  ])('refuses %s', (_label, value) => {
    expect(() => parseMatrixAgentSkillsReport(value, requested)).toThrow(MatrixAgentContentInvalid)
  })
})
