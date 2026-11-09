import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, expect, test } from 'vitest'

import type { AtumSkillBundle } from '../../../shared/atum-agent-content'
import type { AtumPortableSkillRef } from '../../../shared/atum-agent-portability'
import type { MatrixEnrollment } from '../../../shared/matrix'
import { MatrixAgentDefinitionError, type MatrixAgentDefinitionSnapshot } from '../agent-definition'
import { seedMatrixAgentSoul } from '../agent-lifecycle'
import { MatrixAgentRuntime } from '../agent-runtime'
import { matrixHermesHome } from '../hermes-runtime'
import { type MatrixMainAgentContentSource, matrixMainAgentContentTarget } from '../main-agent-content'

import { MatrixAgentContent, type MatrixAgentContentTarget } from './index'

/**
 * Two Macs, one agent (G1-09), with the real Hermes helper and real files; the account is an
 * in-memory map of the bundles the first Mac uploaded. Opt in with the repository's Python:
 * `ATUM_SYNC_PYTHON=<repo>/.venv/bin/python npx vitest run --project electron electron/matrix/agent-content`.
 */
const python = process.env.ATUM_SYNC_PYTHON
const repository = fileURLToPath(new URL('../../../../../', import.meta.url))
const scratch = mkdtempSync(path.join(tmpdir(), 'atum-two-macs-'))
const shippedBefore = process.env.HERMES_BUNDLED_SKILLS

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })

  if (shippedBefore === undefined) {
    delete process.env.HERMES_BUNDLED_SKILLS
  } else {
    process.env.HERMES_BUNDLED_SKILLS = shippedBefore
  }
})

const PRINCIPAL = '00000000-0000-4000-8000-f1d11edf5c5c'
const ASSISTANT = '00000000-0000-4000-8000-fbfe405ca65f'

function skill(directory: string, name: string, body: string, extra: Record<string, Buffer> = {}) {
  mkdirSync(directory, { recursive: true })
  writeFileSync(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}.\n---\n${body}`)

  for (const [relative, raw] of Object.entries(extra)) {
    mkdirSync(path.dirname(path.join(directory, relative)), { recursive: true })
    writeFileSync(path.join(directory, relative), raw)
  }
}

function home(label: string) {
  const root = path.join(scratch, label, 'home')
  mkdirSync(path.join(root, 'cron'), { recursive: true })
  writeFileSync(path.join(root, 'SOUL.md'), 'Keep it short.\n')
  writeFileSync(path.join(root, 'config.yaml'), 'model:\n  provider: my-own\n  default: local\n')
  writeFileSync(path.join(root, 'cron', 'jobs.json'), '{"jobs":[]}')

  return root
}

function exportBundles(directories: string[]): AtumSkillBundle[] {
  const out = execFileSync(
    python!,
    [
      '-B',
      '-c',
      'import json,sys\nfrom pathlib import Path\nfrom hermes_cli.atum_skill_bundles import export_skill_bundle\n' +
        'print(json.dumps([export_skill_bundle(Path(p)) for p in sys.argv[1:]]))',
      ...directories
    ],
    { cwd: repository, env: { ...process.env, PYTHONPATH: repository }, maxBuffer: 64 * 1024 * 1024 }
  )

  return JSON.parse(out.toString('utf8'))
}

function definition(skills: AtumPortableSkillRef[]): MatrixAgentDefinitionSnapshot {
  return {
    assistant: {
      id: ASSISTANT,
      identityId: ASSISTANT,
      principal: PRINCIPAL,
      displayName: 'Main',
      avatar: '',
      avatarUrl: null,
      isDefault: false,
      lifecycleRevision: 1,
      status: 'active',
      identityRevision: 1,
      definitionRevision: 3
    },
    definition: { schemaVersion: 1, soul: 'Keep it short.', modelAlias: 'binh-minh', reasoning: null, skills },
    definitionRevision: 3,
    identityRevision: 1
  }
}

test.skipIf(!python)("a second Mac recovers an agent's skills from the account with the first Mac gone", async () => {
  const shipped = path.join(scratch, 'shipped')
  skill(path.join(shipped, 'productivity', 'notes'), 'notes', 'Current shipped notes.\n')
  process.env.HERMES_BUNDLED_SKILLS = shipped

  // The first Mac: this Mac's older copy of a shipped skill, and two of the agent's own.
  const first = home('first')
  const names = ['productivity/notes', 'writing/brief', 'tiếng-việt/ghi-chú']
  skill(path.join(first, 'skills', 'productivity', 'notes'), 'notes', 'Older shipped notes.\n')
  skill(path.join(first, 'skills', 'writing', 'brief'), 'brief', 'Write briefs.\n', {
    'templates/brief.md': Buffer.from('# Brief\n')
  })
  skill(path.join(first, 'skills', 'tiếng-việt', 'ghi-chú'), 'ghi-chu', 'Ghi chú.\n', {
    'tài-liệu/ảnh.bin': Buffer.from([0, 255, 16, 1])
  })
  const uploaded = exportBundles(names.map(name => path.join(first, 'skills', ...name.split('/'))))
  const account = new Map(uploaded.map(bundle => [bundle.sha256, bundle]))
  const declared = names.map((name, index) => ({ name, sha256: uploaded[index]!.sha256 }))
  rmSync(path.join(scratch, 'first'), { recursive: true, force: true })

  const second = home('second')
  const untouched = ['SOUL.md', 'config.yaml', 'cron/jobs.json'].map(file => readFileSync(path.join(second, file)))
  const log: string[] = []
  const content = new MatrixAgentContent({ log: line => log.push(line) })
  const downloads: string[] = []

  const agent: MatrixAgentContentTarget = {
    principal: PRINCIPAL,
    assistantId: ASSISTANT,
    home: second,
    runtime: { python: python!, source: repository, profiles: scratch },
    live: () => true,
    definition: async () => definition(declared),
    skill: async sha256 => {
      downloads.push(sha256)
      const bundle = account.get(sha256)

      if (!bundle) {
        throw new MatrixAgentDefinitionError('missing')
      }

      return structuredClone(bundle)
    }
  }

  await content.sync(agent)

  expect(content.status(PRINCIPAL)).toMatchObject({
    state: 'differs',
    persona: 'matches',
    definitionRevision: 3,
    skills: { declared: 3, installed: 2, installedNow: 2, bundled_version: 1 }
  })
  // The shipped skill is this Mac's own business: never downloaded, never written.
  expect(downloads.sort()).toEqual([declared[1]!.sha256, declared[2]!.sha256].sort())
  expect(existsSync(path.join(second, 'skills', 'productivity'))).toBe(false)
  expect(readFileSync(path.join(second, 'skills', 'writing', 'brief', 'templates', 'brief.md'), 'utf8')).toBe(
    '# Brief\n'
  )
  expect([...readFileSync(path.join(second, 'skills', 'tiếng-việt', 'ghi-chú', 'tài-liệu', 'ảnh.bin'))]).toEqual([
    0, 255, 16, 1
  ])
  expect(['SOUL.md', 'config.yaml', 'cron/jobs.json'].map(file => readFileSync(path.join(second, file)))).toEqual(
    untouched
  )
  expect(log.at(-1)).toBe(
    `[Matrix] agent ${ASSISTANT.slice(0, 8)} content r3: 3 skills (2 installed (2 new), 1 shipped at this Mac's version); persona matches: differs`
  )

  // Again: nothing new, nothing downloaded.
  downloads.length = 0
  await content.sync(agent)
  expect(downloads).toEqual([])
  expect(content.status(PRINCIPAL)?.skills).toMatchObject({ installed: 2, installedNow: 0 })

  // Removed here: stays removed on the next setup.
  rmSync(path.join(second, 'skills', 'writing', 'brief'), { recursive: true })
  await content.sync(agent)
  expect(content.status(PRINCIPAL)?.skills).toMatchObject({ installed: 1, suppressed: 1 })
  expect(existsSync(path.join(second, 'skills', 'writing', 'brief'))).toBe(false)

  // Another agent whose content the account cannot fully provide still gets the rest, and a
  // corrupt receipt in its home neither blocks it nor this agent.
  const other = home('other')
  mkdirSync(path.join(other, '.atum-agent-content'), { recursive: true })
  writeFileSync(path.join(other, '.atum-agent-content', 'skills.json'), '{"torn')
  // Refused whole (a secret-bearing path, a digest its files do not have), never stripped.
  const unsupported = { ...structuredClone(uploaded[1]!), sha256: 'f'.repeat(64) }
  unsupported.files[0]!.path = '.env'
  const otherContent = new MatrixAgentContent({ log: () => {} })

  await otherContent.sync({
    ...agent,
    principal: '00000000-0000-4000-8000-a9703d75e616',
    home: other,
    definition: async () => definition([...declared.slice(2), { name: 'gone/skill', sha256: 'f'.repeat(64) }]),
    skill: async sha256 => (sha256 === declared[2]!.sha256 ? structuredClone(account.get(sha256)!) : unsupported)
  })
  expect(otherContent.statuses()[0]).toMatchObject({
    state: 'incomplete',
    skills: { declared: 2, installed: 1, unsupported: 1, receiptReset: true }
  })
  expect(
    readdirSync(path.join(other, '.atum-agent-content')).some(file => file.startsWith('skills.json.corrupt-'))
  ).toBe(true)
  expect(existsSync(path.join(other, 'skills', 'gone'))).toBe(false)
})

test.skipIf(!python)(
  'promoted named Main retains its imported home while fresh-device root Main materializes the same portable tools',
  async () => {
    const portable = path.join(scratch, 'default-role-portable', 'skills', 'custom', 'main-tool')
    skill(portable, 'main-tool', "Use Main's existing tool.\n", {
      'scripts/tool.py': Buffer.from('print("Main tool")\n')
    })
    const bundle = exportBundles([portable])[0]!
    const declared = [{ name: 'custom/main-tool', sha256: bundle.sha256 }]
    const canonical = definition(declared)
    canonical.assistant.isDefault = true

    const enrolled = (executorId: string): MatrixEnrollment => ({
      state: 'ready',
      identity: {
        issuer: 'https://id.test/',
        subject: 'owner',
        principal: '00000000-0000-4000-8000-f2da1f9533d4',
        agentPrincipal: PRINCIPAL,
        executorId,
        userId: '@main:test',
        deviceId: executorId,
        expiresAt: Date.now() + 3_600_000
      }
    })

    const run = async (custody: 'root' | 'named', executorId: string) => {
      const agent =
        custody === 'root' ? new MatrixAgentRuntime('agent') : new MatrixAgentRuntime(`agent:${PRINCIPAL}`, PRINCIPAL)

      agent.agentPrincipal = PRINCIPAL
      agent.assistantId = ASSISTANT
      const runtime = { python: python!, source: repository, profiles: path.join(scratch, `default-role-${custody}`) }
      const enrollment = enrolled(executorId)
      const downloads: string[] = []

      const source: MatrixMainAgentContentSource = {
        defaultAgent: custody === 'root' ? agent : new MatrixAgentRuntime('agent'),
        agents: new Map(custody === 'root' ? [] : [[PRINCIPAL, agent]]),
        account: () => ({
          appScope: () => ({ accountKey: 'test-account', generation: 1 }),
          agentDefinition: async () => structuredClone(canonical),
          agentSkill: async (_id, sha256) => {
            downloads.push(sha256)

            return structuredClone(bundle)
          }
        }),
        runtime: () => runtime,
        closing: () => false,
        enrollment: () => enrollment
      }

      const target = matrixMainAgentContentTarget(source, agent)!
      expect(target.home).toBe(matrixHermesHome(runtime, enrollment.identity!.principal, executorId))

      if (custody === 'named') {
        mkdirSync(path.join(target.home, 'cron'), { recursive: true })
        writeFileSync(path.join(target.home, 'SOUL.md'), "Main's imported persona.\n")
        writeFileSync(path.join(target.home, 'config.yaml'), 'model:\n  provider: own-model\n')
        writeFileSync(path.join(target.home, 'cron', 'jobs.json'), '{"jobs":[{"id":"existing-job"}]}')
        skill(path.join(target.home, 'skills', 'local', 'kept-tool'), 'kept-tool', 'Keep this imported tool.\n')
      }

      const protectedFiles =
        custody === 'named' ? ['SOUL.md', 'config.yaml', 'cron/jobs.json', 'skills/local/kept-tool/SKILL.md'] : []

      const before = protectedFiles.map(file => readFileSync(path.join(target.home, file)))
      // Production's separate seeding path uses this same create-only helper; promotion must
      // never replace an imported persona, while a fresh root home gets the canonical one.
      await seedMatrixAgentSoul(target.home, async () => canonical.definition!.soul)
      const content = new MatrixAgentContent({ log: () => {} })
      await content.sync(target)

      expect(content.status(PRINCIPAL)).toMatchObject({
        state: custody === 'root' ? 'complete' : 'differs',
        persona: custody === 'root' ? 'matches' : 'differs',
        skills: { declared: 1, installed: 1, installedNow: 1 }
      })
      expect(downloads).toEqual([bundle.sha256])
      expect(readFileSync(path.join(target.home, 'skills', 'custom', 'main-tool', 'scripts', 'tool.py'), 'utf8')).toBe(
        'print("Main tool")\n'
      )
      expect(protectedFiles.map(file => readFileSync(path.join(target.home, file)))).toEqual(before)

      if (custody === 'root') {
        expect(readFileSync(path.join(target.home, 'SOUL.md'), 'utf8')).toBe('Keep it short.\n')
      }

      return target.home
    }

    const namedHome = await run('named', '00000000-0000-4000-8000-c8f367a876b2')
    const rootHome = await run('root', '00000000-0000-4000-8000-e8d95748107a')
    expect(rootHome).not.toBe(namedHome)
  }
)
