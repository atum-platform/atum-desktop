import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, expect, test } from 'vitest'

import { EncryptedStore } from '../encrypted-store'

import { matrixDriveImportPatterns } from './drive-exclusions'
import { executeNativeDriveImport } from './drive-import-native'
import type { NativeDriveImportInput } from './drive-import-native'
import { readMatrixWorkspaceDriveRoots } from './workspace-root-facts'

const native = process.platform === 'darwin' || process.platform === 'linux'

const python = native
  ? execFileSync('python3', ['-I', '-B', '-S', '-c', 'import sys;print(sys.executable)'], { encoding: 'utf8' }).trim()
  : ''

let home: string
let drive: string
let source: string
let input: NativeDriveImportInput

beforeEach(() => {
  home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'atum-drive-import-')))
  drive = path.join(home, 'Atum', 'Drive')
  source = path.join(home, 'Documents', 'Project')
  mkdirSync(drive, { recursive: true })
  mkdirSync(source, { recursive: true })
  const binding = statSync(drive)
  input = {
    mode: 'plan',
    home,
    target: { root: drive, dev: binding.dev, ino: binding.ino, ownerKey: 'synthetic-account' },
    sources: [source],
    patterns: matrixDriveImportPatterns(),
    total: 1_073_741_824
  }
})

// Removing a sixty-thousand-entry fixture tree can outlast the default hook timeout on a busy runner.
afterEach(() => rmSync(home, { recursive: true, force: true }), 60_000)

test.skipIf(!native)(
  'direct file selections cannot evade private ancestor or other Drive binding protection',
  async () => {
    for (const parent of ['.ssh', '.git', 'node_modules']) {
      const folder = path.join(home, parent)
      mkdirSync(folder)
      const file = path.join(folder, 'ordinary-name')
      writeFileSync(file, 'synthetic private bytes')
      expect(await executeNativeDriveImport(python, { ...input, sources: [file] })).toMatchObject({
        state: 'refused',
        reason: 'protected'
      })
    }

    const otherDrive = path.join(home, 'Other Drive')
    mkdirSync(otherDrive)
    writeFileSync(path.join(otherDrive, '.atum-drive-binding.json'), '{}')
    writeFileSync(path.join(otherDrive, 'ordinary-name'), 'work')
    expect(
      await executeNativeDriveImport(python, { ...input, sources: [path.join(otherDrive, 'ordinary-name')] })
    ).toMatchObject({ state: 'refused', reason: 'in_drive' })
    expect(await executeNativeDriveImport(python, { ...input, sources: [otherDrive] })).toMatchObject({
      state: 'refused',
      reason: 'in_drive'
    })
    expect(existsSync(path.join(home, 'Atum', '.import'))).toBe(false)
  }
)

test.skipIf(!native).each(['history', 'legacy-binding'])('a direct file under a sealed %s Drive is refused without staging', async mode => {
  const remembered = path.join(home, 'Remembered Drive')
  mkdirSync(remembered)
  const file = path.join(remembered, 'ordinary-work.txt')
  writeFileSync(file, 'synthetic remembered work')

  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }

  const roots = new EncryptedStore(path.join(home, 'user-data', 'device', 'drive-roots.json'), safeStorage)
  const bindings = new EncryptedStore(path.join(home, 'user-data', 'drive.json'), safeStorage)

  if (mode === 'history') {
    roots.setItem('roots', JSON.stringify([remembered]))
  } else {
    const stat = statSync(remembered)

    bindings.setItem('drive-root:inactive-account', JSON.stringify({ root: remembered, dev: stat.dev, ino: stat.ino }))
  }

  const result = await executeNativeDriveImport(python, {
    ...input, sources: [file], protectedRoots: readMatrixWorkspaceDriveRoots(roots, bindings)
  })

  expect(result).toMatchObject({ state: 'refused', reason: 'protected' })
  expect(existsSync(path.join(home, 'Atum', '.import'))).toBe(false)
  expect(readdirSync(drive)).toEqual([])
  expect(readFileSync(file, 'utf8')).toBe('synthetic remembered work')
})

test.skipIf(!native)('a Drive path replaced by a link after copying cannot receive the completed stage', async () => {
  writeFileSync(path.join(source, 'report.txt'), 'work')
  const plan = await executeNativeDriveImport(python, input)
  const external = path.join(home, 'external')
  mkdirSync(external)

  const result = await executeNativeDriveImport(
    python,
    { ...input, mode: 'run', planId: randomUUID(), fingerprint: plan.fingerprint },
    undefined,
    () => {
      execFileSync(python, [
        '-I',
        '-B',
        '-S',
        '-c',
        'import os,sys;os.rename(sys.argv[1],sys.argv[1]+"-old");os.symlink(sys.argv[2],sys.argv[1])',
        drive,
        external
      ])

      return true
    }
  )

  expect(result).toMatchObject({ state: 'unavailable', added: 0 })
  expect(readdirSync(external)).toEqual([])
  expect(readdirSync(drive + '-old')).toEqual([])
  expect(readdirSync(path.join(home, 'Atum', '.import'))).toEqual([])
})

test.skipIf(!native)(
  'a sixty-thousand-entry selection is refused by the bounded read-only inventory',
  async () => {
    execFileSync(python, [
      '-I',
      '-B',
      '-S',
      '-c',
      'import os,sys\nfor i in range(60000):\n fd=os.open(os.path.join(sys.argv[1],str(i)),os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600);os.close(fd)',
      source
    ])
    const result = await executeNativeDriveImport(python, input)
    expect(result).toMatchObject({ state: 'refused', reason: 'too_many', added: 0 })
    expect(existsSync(path.join(home, 'Atum', '.import'))).toBe(false)
    expect(readdirSync(drive)).toEqual([])
  },
  120_000
)

test.skipIf(!native)(
  'unreadable source items are skipped while unreadable Drive size refuses the estimate',
  async () => {
    const readable = path.join(source, 'report.txt')
    const unreadable = path.join(source, 'private.txt')
    writeFileSync(readable, 'work')
    writeFileSync(unreadable, 'synthetic inaccessible')
    chmodSync(unreadable, 0)
    expect(await executeNativeDriveImport(python, input)).toMatchObject({
      state: 'planned',
      files: 1,
      skipped: { unreadable: 1 }
    })
    const inaccessible = path.join(drive, 'inaccessible')
    mkdirSync(inaccessible)
    chmodSync(inaccessible, 0)

    try {
      expect(await executeNativeDriveImport(python, input)).toMatchObject({ state: 'refused', reason: 'quota_unknown' })
    } finally {
      chmodSync(inaccessible, 0o700)
    }
  }
)

test.skipIf(!native)('read-only inventory skips secrets, app folders, symlink loops and special files', async () => {
  writeFileSync(path.join(source, 'report.txt'), 'kept')
  writeFileSync(path.join(source, '.env.production'), 'synthetic-secret')
  writeFileSync(path.join(source, 'TOKEN.txt'), 'synthetic-secret')
  mkdirSync(path.join(source, 'node_modules'))
  writeFileSync(path.join(source, 'node_modules', 'ignored'), 'ignored')
  symlinkSync(source, path.join(source, 'loop'))
  execFileSync('mkfifo', [path.join(source, 'pipe')])
  const result = await executeNativeDriveImport(python, input)
  expect(result).toMatchObject({
    state: 'planned',
    files: process.platform === 'darwin' ? 1 : 2,
    folders: 1,
    bytes: process.platform === 'darwin' ? 4 : 20,
    skipped: { code: 1, shortcuts: 1, special: 1 }
  })
  expect(result.skipped?.private).toBe(process.platform === 'darwin' ? 2 : 1)
  expect(existsSync(path.join(home, 'Atum', '.import'))).toBe(false)
  expect(readdirSync(drive)).toEqual([])
  expect(JSON.stringify(result)).not.toContain(home)

  const added = await executeNativeDriveImport(python, {
    ...input,
    mode: 'run',
    planId: randomUUID(),
    fingerprint: result.fingerprint
  })

  expect(added.state).toBe('completed')
  expect(readdirSync(path.join(drive, 'Project')).sort()).toEqual(
    process.platform === 'darwin' ? ['report.txt'] : ['TOKEN.txt', 'report.txt']
  )
})

test.skipIf(!native)(
  'private staging copies without moving originals and collisions never merge or overwrite',
  async () => {
    writeFileSync(path.join(source, 'report.txt'), 'new report')
    mkdirSync(path.join(drive, 'Project'))
    writeFileSync(path.join(drive, 'Project', 'report.txt'), 'original destination')
    const plan = await executeNativeDriveImport(python, input)
    expect(plan.state).toBe('planned')

    const result = await executeNativeDriveImport(python, {
      ...input,
      mode: 'run',
      planId: randomUUID(),
      fingerprint: plan.fingerprint
    })

    expect(result).toMatchObject({ state: 'completed', added: 1 })
    expect(readFileSync(path.join(source, 'report.txt'), 'utf8')).toBe('new report')
    expect(readFileSync(path.join(drive, 'Project', 'report.txt'), 'utf8')).toBe('original destination')
    expect(readFileSync(path.join(drive, 'Project (2)', 'report.txt'), 'utf8')).toBe('new report')
    expect(readdirSync(path.join(home, 'Atum', '.import'))).toEqual([])
  }
)

test.skipIf(!native)('the broker Agents tree is reserved even when it does not exist', async () => {
  const agents = path.join(home, 'Documents', 'Agents')
  mkdirSync(agents)
  writeFileSync(path.join(agents, 'work.txt'), 'work')
  const cfg = { ...input, sources: [agents] }
  const plan = await executeNativeDriveImport(python, cfg)

  const result = await executeNativeDriveImport(python, {
    ...cfg,
    mode: 'run',
    planId: randomUUID(),
    fingerprint: plan.fingerprint
  })

  expect(result.state).toBe('completed')
  expect(existsSync(path.join(drive, 'Agents'))).toBe(false)
  expect(readFileSync(path.join(drive, 'Agents (2)', 'work.txt'), 'utf8')).toBe('work')
})

test.skipIf(!native)(
  'cancellation during copy cleans only its private staging and exposes no partial folder',
  async () => {
    writeFileSync(path.join(source, 'report.txt'), 'work')
    const unrelated = path.join(home, 'Atum', '.import', 'unrelated')
    mkdirSync(unrelated, { recursive: true, mode: 0o700 })
    writeFileSync(path.join(unrelated, 'kept.txt'), 'not our stage')
    const plan = await executeNativeDriveImport(python, input)

    const result = await executeNativeDriveImport(python, {
      ...input,
      mode: 'run',
      planId: randomUUID(),
      fingerprint: plan.fingerprint,
      testCancelAfterCopy: 1
    })

    expect(result).toMatchObject({ state: 'cancelled', added: 0 })
    expect(readdirSync(drive)).toEqual([])
    expect(readFileSync(path.join(source, 'report.txt'), 'utf8')).toBe('work')
    expect(readdirSync(path.join(home, 'Atum', '.import'))).toEqual(['unrelated'])
  }
)

test.skipIf(!native)('fresh main account/root refusal after copying prevents every exclusive placement', async () => {
  writeFileSync(path.join(source, 'report.txt'), 'work')
  const plan = await executeNativeDriveImport(python, input)
  let rechecked = 0

  const result = await executeNativeDriveImport(
    python,
    { ...input, mode: 'run', planId: randomUUID(), fingerprint: plan.fingerprint },
    undefined,
    () => {
      rechecked++

      return false
    }
  )

  expect(rechecked).toBe(1)
  expect(result).toMatchObject({ state: 'cancelled', added: 0 })
  expect(readdirSync(drive)).toEqual([])
  expect(readdirSync(path.join(home, 'Atum', '.import'))).toEqual([])
})

test.skipIf(!native)('changed sources and exhausted quota refuse before placing anything', async () => {
  writeFileSync(path.join(source, 'report.txt'), 'work')
  const plan = await executeNativeDriveImport(python, input)
  writeFileSync(path.join(source, 'report.txt'), 'changed work')

  const result = await executeNativeDriveImport(python, {
    ...input,
    mode: 'run',
    planId: randomUUID(),
    fingerprint: plan.fingerprint
  })

  expect(result.state).toBe('changed')
  const fresh = await executeNativeDriveImport(python, input)

  const full = await executeNativeDriveImport(python, {
    ...input,
    mode: 'run',
    planId: randomUUID(),
    fingerprint: fresh.fingerprint,
    remaining: 1
  })

  expect(full.state).toBe('no_room')
  expect(readdirSync(drive)).toEqual([])
  expect(existsSync(path.join(home, 'Atum', '.import'))).toBe(false)
})

test.skipIf(!native).each(['home', 'drive', 'parent', 'protected'])(
  'selection of %s refuses without writing',
  async mode => {
    const selected = { home, drive, parent: path.join(home, 'Atum'), protected: source }[mode as 'home']

    const result = await executeNativeDriveImport(python, {
      ...input,
      sources: [selected],
      protectedRoots: mode === 'protected' ? [source] : []
    })

    expect(result.state).toBe('refused')
    expect(existsSync(path.join(home, 'Atum', '.import'))).toBe(false)
    expect(readdirSync(drive)).toEqual([])
  }
)

test.skipIf(!native)('a swapped root and a source ancestor link cannot redirect the native operation', async () => {
  writeFileSync(path.join(source, 'report.txt'), 'work')
  const external = path.join(home, 'Other')
  mkdirSync(external)
  const cfg = { ...input, target: { ...input.target!, ino: input.target!.ino + 1 } }
  expect((await executeNativeDriveImport(python, cfg)).state).toBe('changed')
  const alias = path.join(home, 'Alias')
  symlinkSync(path.dirname(source), alias)
  expect((await executeNativeDriveImport(python, { ...input, sources: [path.join(alias, 'Project')] })).state).toBe(
    'unavailable'
  )
  expect(readdirSync(external)).toEqual([])
  expect(readdirSync(drive)).toEqual([])
})

test.skipIf(!native)(
  'stale cleanup removes only marked private UUID stages, preserving unrelated and linked content',
  async () => {
    const parent = path.join(home, 'Atum', '.import')
    mkdirSync(parent, { mode: 0o700 })
    const old = randomUUID()
    const fresh = randomUUID()

    for (const [id, age] of [
      [old, 2 * 86400000],
      [fresh, 0]
    ] as const) {
      mkdirSync(path.join(parent, id), { mode: 0o700 })
      writeFileSync(
        path.join(parent, id, '.atum-import.json'),
        JSON.stringify({ version: 1, planId: id, createdAt: Date.now() - age }),
        { mode: 0o600 }
      )
    }

    const unrelated = randomUUID()
    mkdirSync(path.join(parent, unrelated), { mode: 0o700 })
    writeFileSync(path.join(parent, unrelated, 'kept'), 'unmarked')
    const link = randomUUID()
    symlinkSync(source, path.join(parent, link))
    writeFileSync(path.join(source, 'kept'), 'outside')
    const result = await executeNativeDriveImport(python, { mode: 'cleanup', home })
    expect(result.state).toBe('completed')
    expect(existsSync(path.join(parent, old))).toBe(false)
    expect(readdirSync(parent).sort()).toEqual([fresh, unrelated, link].sort())
    expect(readFileSync(path.join(source, 'kept'), 'utf8')).toBe('outside')
  }
)
