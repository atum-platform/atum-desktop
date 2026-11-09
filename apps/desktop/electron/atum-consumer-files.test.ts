import assert from 'node:assert/strict'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, test } from 'vitest'

import {
  ATUM_CONSUMER_FILES_IPC_CHANNELS,
  AtumConsumerFilesService,
  consumerFileOpenKind,
  registerAtumConsumerFilesIpc
} from './atum-consumer-files'

const cleanups: string[] = []

afterEach(() => {
  for (const directory of cleanups.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

function fixture() {
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'atum-consumer-files-')))
  cleanups.push(sandbox)
  const home = join(sandbox, 'home')
  const outside = join(sandbox, 'outside')
  mkdirSync(join(home, 'Documents', 'Reports', 'node_modules'), { recursive: true })
  mkdirSync(join(home, 'Desktop'), { recursive: true })
  mkdirSync(join(home, 'Downloads'), { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(home, 'Documents', 'notes.md'), '# hello')
  writeFileSync(join(home, 'Documents', 'budget.xlsx'), 'binary')
  writeFileSync(join(home, 'Documents', 'report.docx'), 'PK')
  writeFileSync(join(home, 'Documents', 'legacy.doc'), 'doc')
  writeFileSync(join(home, 'Documents', '.hidden.txt'), 'secret')
  writeFileSync(join(home, 'Documents', 'Reports', 'q3 report.pdf'), 'pdf')
  writeFileSync(join(home, 'Documents', 'Reports', 'node_modules', 'report-lib.js'), 'js')
  writeFileSync(join(home, 'Desktop', 'photo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  writeFileSync(join(outside, 'leak.txt'), 'outside')
  symlinkSync(outside, join(home, 'escape'))
  mkdirSync(join(home, '.ssh'), { recursive: true })
  writeFileSync(join(home, '.ssh', 'id_ed25519'), 'key')
  mkdirSync(join(home, '.aws'), { recursive: true })
  writeFileSync(join(home, '.aws', 'credentials'), 'aws')
  writeFileSync(join(home, 'Documents', '.env'), 'SECRET=1')
  writeFileSync(join(home, '.zshrc'), 'rc')
  mkdirSync(join(home, '.config', 'app'), { recursive: true })
  writeFileSync(join(home, '.config', 'app', 'settings.json'), '{}')
  symlinkSync(join(home, 'Documents', 'notes.md'), join(home, 'Desktop', 'notes-link.md'))

  const calls: string[] = []
  const leaseOwners: string[] = []

  const service = new AtumConsumerFilesService({
    importDocx: async filePath => {
      calls.push(`import:${filePath}`)

      return {
        descriptor: { displayName: 'report.md', fileRef: `lease:${filePath}.md` },
        sourceDisplayName: 'report.docx'
      }
    },
    leases: { openLocal: (filePath, options) => {
      leaseOwners.push(options.ownerId)

      return { displayName: filePath.split('/').pop()!, fileRef: `lease:${filePath}` }
    } },
    roots: () => ({
      desktop: join(home, 'Desktop'),
      documents: join(home, 'Documents'),
      downloads: join(home, 'Downloads'),
      home
    }),
    thumbnail: async (target, size) => {
      calls.push(`thumb:${target}:${size}`)

      return target.endsWith('.png') ? 'data:image/png;base64,THUMB' : null
    },
    shell: {
      openPath: async target => {
        calls.push(`open:${target}`)

        return ''
      },
      showItemInFolder: target => {
        calls.push(`reveal:${target}`)
      },
      trashItem: async target => {
        calls.push(`trash:${target}`)
        rmSync(target, { force: true, recursive: true })
      }
    }
  })

  return { calls, home, leaseOwners, outside, service }
}

test('lists a folder Finder-style: folders first, dot entries hidden, metadata attached', async () => {
  const { home, service } = fixture()
  const result = await service.list(join(home, 'Documents'))

  assert.equal(result.error, undefined)
  assert.deepEqual(
    result.entries.map(entry => [entry.name, entry.isDirectory, entry.extension]),
    [
      ['Reports', true, ''],
      ['budget.xlsx', false, '.xlsx'],
      ['legacy.doc', false, '.doc'],
      ['notes.md', false, '.md'],
      ['report.docx', false, '.docx']
    ]
  )
  const notes = result.entries.find(entry => entry.name === 'notes.md')!
  assert.equal(notes.size, 7)
  assert.ok(typeof notes.modifiedMs === 'number' && notes.modifiedMs > 0)
  assert.equal(result.entries.find(entry => entry.name === 'Reports')!.size, null)
})

test('confines every path to the home folder, including symlink escapes and relative paths', async () => {
  const { home, outside, service } = fixture()

  assert.deepEqual(await service.list(outside), { entries: [], error: 'CONSUMER_FILES_OUTSIDE_HOME' })
  assert.deepEqual(await service.list(join(home, 'escape')), { entries: [], error: 'CONSUMER_FILES_OUTSIDE_HOME' })
  assert.deepEqual(await service.list('Documents'), { entries: [], error: 'CONSUMER_FILES_INVALID_PATH' })
  assert.deepEqual(await service.list(join(home, 'missing')), { entries: [], error: 'CONSUMER_FILES_MISSING' })
  assert.deepEqual(await service.open(join(home, 'escape', 'leak.txt'), '7'), {
    code: 'CONSUMER_FILES_OUTSIDE_HOME',
    kind: 'error'
  })
  assert.equal(service.reveal(outside), false)
  await assert.rejects(service.trash(outside), /CONSUMER_FILES_OUTSIDE_HOME/)
  await assert.rejects(service.trash(home), /CONSUMER_FILES_OUTSIDE_HOME/)
  await assert.rejects(service.rename(join(outside, 'leak.txt'), 'renamed.txt'), /CONSUMER_FILES_OUTSIDE_HOME/)
})

test('searches below a folder by name, skipping dependency folders and hidden entries', async () => {
  const { home, service } = fixture()
  const result = await service.search(join(home, 'Documents'), 'REPORT')

  assert.equal(result.truncated, false)
  assert.deepEqual(
    result.entries.map(entry => entry.name),
    ['Reports', 'q3 report.pdf', 'report.docx']
  )
  assert.deepEqual(await service.search(join(home, 'Documents'), '   '), { entries: [], truncated: false })
  assert.deepEqual((await service.search(join(home, 'Documents'), 'hidden')).entries, [])
})

test('opens text through the lease, images as bounded data URLs, and other files as read-only cards', async () => {
  const { calls, home, service } = fixture()

  assert.deepEqual(await service.open(join(home, 'Documents', 'notes.md'), '7'), {
    descriptor: { displayName: 'notes.md', fileRef: `lease:${join(home, 'Documents', 'notes.md')}` },
    kind: 'text'
  })

  const image = await service.open(join(home, 'Desktop', 'photo.png'), '7')
  assert.equal(image.kind, 'image')
  assert.ok(image.kind === 'image' && image.dataUrl.startsWith('data:image/png;base64,iVBORw'))
  assert.ok(image.kind === 'image' && image.size === 4)

  assert.equal((await service.open(join(home, 'Documents', 'budget.xlsx'), '7')).kind, 'card')
  assert.deepEqual(calls, [])
  // Word documents are imported into the workspace and opened in the pane;
  // legacy binary .doc still hands off to the OS.
  assert.deepEqual(await service.open(join(home, 'Documents', 'report.docx'), '7'), {
    descriptor: { displayName: 'report.md', fileRef: `lease:${join(home, 'Documents', 'report.docx')}.md` },
    imported: 'report.docx',
    kind: 'text'
  })
  assert.equal((await service.open(join(home, 'Documents', 'legacy.doc'), '7')).kind, 'card')
  assert.deepEqual(calls, [`import:${join(home, 'Documents', 'report.docx')}`])
  await service.openNative(join(home, 'Documents', 'legacy.doc'))
  assert.equal(calls.at(-1), `open:${join(home, 'Documents', 'legacy.doc')}`)
  assert.deepEqual(await service.open(join(home, 'Documents'), '7'), { code: 'CONSUMER_FILES_NOT_A_FILE', kind: 'error' })

  assert.equal(consumerFileOpenKind('a.JPG'), 'image')
  assert.equal(consumerFileOpenKind('a.py'), 'text')
  assert.equal(consumerFileOpenKind('a.pptx'), 'native')
  assert.equal(consumerFileOpenKind('Q3.PDF'), 'pdf')
})

test('without a lease authority, text falls back to the legacy preview path', async () => {
  const { home, service } = fixture()

  const legacy = new AtumConsumerFilesService({
    leases: null,
    roots: () => service.roots(),
    shell: { openPath: async () => '', showItemInFolder: () => undefined, trashItem: async () => undefined }
  })

  assert.deepEqual(await legacy.open(join(home, 'Documents', 'notes.md'), '7'), { kind: 'legacy' })

  const revoked = new AtumConsumerFilesService({
    leases: {
      openLocal: () => {
        throw new Error('CAPABILITY_REVOKED')
      }
    },
    roots: () => service.roots(),
    shell: { openPath: async () => '', showItemInFolder: () => undefined, trashItem: async () => undefined }
  })

  assert.deepEqual(await revoked.open(join(home, 'Documents', 'notes.md'), '7'), {
    code: 'CAPABILITY_REVOKED',
    kind: 'error'
  })
})

test('renames within the folder, refuses separators and collisions, and trashes through the OS', async () => {
  const { calls, home, service } = fixture()
  const notes = join(home, 'Documents', 'notes.md')

  await assert.rejects(service.rename(notes, '../escape.md'), /CONSUMER_FILES_INVALID_NAME/)
  await assert.rejects(service.rename(notes, 'budget.xlsx'), /CONSUMER_FILES_EXISTS/)
  assert.deepEqual(await service.rename(notes, 'notes.md'), { path: notes })
  assert.deepEqual(await service.rename(notes, 'todo.md'), { path: join(home, 'Documents', 'todo.md') })
  assert.ok((await service.list(join(home, 'Documents'))).entries.some(entry => entry.name === 'todo.md'))

  assert.equal(await service.trash(join(home, 'Documents', 'todo.md')), true)
  assert.deepEqual(calls, [`trash:${join(home, 'Documents', 'todo.md')}`])
  assert.ok(!(await service.list(join(home, 'Documents'))).entries.some(entry => entry.name === 'todo.md'))

  assert.equal(service.reveal(join(home, 'Desktop', 'photo.png')), true)
  assert.equal(calls.at(-1), `reveal:${join(home, 'Desktop', 'photo.png')}`)
})

test('IPC registration runs every channel through the trusted-sender check', async () => {
  const { home, leaseOwners, service } = fixture()
  const handlers = new Map<string, (...args: unknown[]) => unknown>()

  registerAtumConsumerFilesIpc(
    { handle: (channel, handler) => handlers.set(channel, handler as never) } as never,
    service,
    event => {
      if ((event as { trusted?: boolean }).trusted !== true) {
        throw new Error('atum_account_sender_not_allowed')
      }
    }
  )

  assert.deepEqual([...handlers.keys()].sort(), Object.values(ATUM_CONSUMER_FILES_IPC_CHANNELS).sort())

  const list = handlers.get(ATUM_CONSUMER_FILES_IPC_CHANNELS.list)!
  assert.throws(() => list({ trusted: false }, join(home, 'Documents')), /atum_account_sender_not_allowed/)
  const trusted = (await list({ trusted: true }, join(home, 'Documents'))) as { entries: unknown[] }
  assert.equal(trusted.entries.length, 5)
  assert.deepEqual(handlers.get(ATUM_CONSUMER_FILES_IPC_CHANNELS.roots)!({ trusted: true }), service.roots())
  const open = handlers.get(ATUM_CONSUMER_FILES_IPC_CHANNELS.open)!
  assert.throws(() => open({ trusted: false }, join(home, 'Documents', 'notes.md')), /atum_account_sender_not_allowed/u)
  await open({ sender: { id: 17 }, trusted: true }, join(home, 'Documents', 'notes.md'), 'forged-owner')
  assert.deepEqual(leaseOwners, ['17'])
})

test('blocks credential-bearing paths on every operation, as the legacy channels did', async () => {
  const { calls, home, service } = fixture()

  const sensitive = [
    join(home, '.ssh', 'id_ed25519'),
    join(home, '.aws', 'credentials'),
    join(home, 'Documents', '.env')
  ]

  for (const target of sensitive) {
    assert.deepEqual(await service.open(target, '7'), { code: 'CONSUMER_FILES_SENSITIVE', kind: 'error' })
    assert.equal((await service.openNative(target)).ok, false)
    assert.equal(service.reveal(target), false)
    await assert.rejects(service.rename(target, 'renamed'), /CONSUMER_FILES_(SENSITIVE|HIDDEN)/)
    await assert.rejects(service.trash(target), /CONSUMER_FILES_(SENSITIVE|HIDDEN)/)
  }

  assert.deepEqual(await service.list(join(home, '.ssh')), { entries: [], error: 'CONSUMER_FILES_SENSITIVE' })
  await assert.rejects(service.rename(join(home, 'Documents', 'notes.md'), '.env'), /CONSUMER_FILES_INVALID_NAME/)
  assert.deepEqual(calls, [])
  assert.ok(existsSync(join(home, '.ssh', 'id_ed25519')))
})

test('hidden entries the panel never shows cannot be opened, renamed or trashed', async () => {
  const { calls, home, service } = fixture()

  assert.deepEqual(await service.open(join(home, '.zshrc'), '7'), { code: 'CONSUMER_FILES_HIDDEN', kind: 'error' })
  assert.equal(service.reveal(join(home, '.zshrc')), false)
  await assert.rejects(service.trash(join(home, '.zshrc')), /CONSUMER_FILES_HIDDEN/)
  await assert.rejects(service.trash(join(home, '.config', 'app', 'settings.json')), /CONSUMER_FILES_HIDDEN/)
  await assert.rejects(
    service.rename(join(home, '.config', 'app', 'settings.json'), 'other.json'),
    /CONSUMER_FILES_HIDDEN/
  )
  // A visible file below a hidden ancestor (a tool's working folder) still opens.
  assert.equal((await service.open(join(home, '.config', 'app', 'settings.json'), '7')).kind, 'text')
  assert.deepEqual(calls, [])
})

test('rename and trash act on a symlink itself, never on what it points to', async () => {
  const { calls, home, service } = fixture()
  const link = join(home, 'Desktop', 'notes-link.md')
  const target = join(home, 'Documents', 'notes.md')

  assert.deepEqual(await service.rename(link, 'alias.md'), { path: join(home, 'Desktop', 'alias.md') })
  assert.ok(lstatSync(join(home, 'Desktop', 'alias.md')).isSymbolicLink())
  assert.ok(existsSync(target))

  assert.equal(await service.trash(join(home, 'Desktop', 'alias.md')), true)
  assert.deepEqual(calls, [`trash:${join(home, 'Desktop', 'alias.md')}`])
  assert.ok(existsSync(target))
})

test('a case-only rename is not a collision', async () => {
  const { home, service } = fixture()
  const notes = join(home, 'Documents', 'notes.md')

  assert.deepEqual(await service.rename(notes, 'Notes.md'), { path: join(home, 'Documents', 'Notes.md') })
  assert.ok((await service.list(join(home, 'Documents'))).entries.some(entry => entry.name === 'Notes.md'))
})

test('creates folders in place with the same name rules as rename', async () => {
  const { home, service } = fixture()

  assert.deepEqual(await service.mkdir(join(home, 'Documents'), 'Invoices'), {
    path: join(home, 'Documents', 'Invoices')
  })
  assert.ok(
    (await service.list(join(home, 'Documents'))).entries.some(entry => entry.name === 'Invoices' && entry.isDirectory)
  )
  await assert.rejects(service.mkdir(join(home, 'Documents'), 'Invoices'), /CONSUMER_FILES_EXISTS/)
  await assert.rejects(service.mkdir(join(home, 'Documents'), '../x'), /CONSUMER_FILES_INVALID_NAME/)
  await assert.rejects(service.mkdir(join(home, 'Documents'), '.hidden'), /CONSUMER_FILES_INVALID_NAME/)
  await assert.rejects(service.mkdir(join(home, 'Documents'), 'id_rsa'), /CONSUMER_FILES_SENSITIVE/)
  await assert.rejects(service.mkdir(join(home, 'escape'), 'x'), /CONSUMER_FILES_OUTSIDE_HOME/)
})

test('thumbnails come from the OS provider, bounded in size and confined like every read', async () => {
  const { calls, home, service } = fixture()

  assert.equal(await service.thumbnail(join(home, 'Desktop', 'photo.png'), 9999), 'data:image/png;base64,THUMB')
  assert.equal(calls.at(-1), `thumb:${join(home, 'Desktop', 'photo.png')}:256`)
  assert.equal(await service.thumbnail(join(home, 'Documents', 'budget.xlsx'), 96), null)
  assert.equal(await service.thumbnail(join(home, 'escape', 'leak.txt'), 96), null)
  assert.equal(await service.thumbnail(join(home, '.ssh', 'id_ed25519'), 96), null)
  assert.ok(!calls.some(call => call.includes('leak.txt') || call.includes('id_ed25519')))
})

test('a PDF opens as a one-tab viewer token that resolves to the file and can be revoked', async () => {
  const { home, service } = fixture()
  const pdf = join(home, 'Documents', 'Reports', 'q3 report.pdf')
  const opened = await service.open(pdf, '7')

  assert.equal(opened.kind, 'pdf')
  // The token is opaque by construction and carries no part of the path.
  assert.match(opened.kind === 'pdf' ? opened.token : '', /^[A-Za-z0-9_-]{24}$/u)
  const token = opened.kind === 'pdf' ? opened.token : ''

  assert.equal(service.resolveView(token), pdf)
  assert.equal(service.resolveView('not-a-token'), null)
  assert.equal(service.releaseView(token), true)
  assert.equal(service.resolveView(token), null)
  assert.equal(service.releaseView(token), false)
})

test('an account transition clears every outstanding PDF viewer token', async () => {
  const { home, service } = fixture()
  const pdf = join(home, 'Documents', 'Reports', 'q3 report.pdf')
  const first = await service.open(pdf, '7')
  const second = await service.open(pdf, '7')
  assert.equal(first.kind, 'pdf')
  assert.equal(second.kind, 'pdf')

  service.clearViews()

  assert.equal(service.resolveView(first.kind === 'pdf' ? first.token : ''), null)
  assert.equal(service.resolveView(second.kind === 'pdf' ? second.token : ''), null)
})

test('a viewer token stops resolving once its file is replaced', async () => {
  const { home, service } = fixture()
  const pdf = join(home, 'Documents', 'Reports', 'q3 report.pdf')
  const other = join(home, 'Documents', 'other.pdf')
  writeFileSync(other, 'other-pdf')
  const opened = await service.open(pdf, '7')
  const token = opened.kind === 'pdf' ? opened.token : ''

  // Same path, different object: the token must not follow it.
  rmSync(pdf)
  symlinkSync(other, pdf)
  assert.equal(service.resolveView(token), null)

  rmSync(pdf)
  writeFileSync(pdf, 'replaced')
  const reopened = await service.open(pdf, '7')
  assert.equal(service.resolveView(reopened.kind === 'pdf' ? reopened.token : ''), pdf)
})

test('expired and surplus viewer tokens are pruned at issuance', async () => {
  const { home, service } = fixture()
  const pdf = join(home, 'Documents', 'Reports', 'q3 report.pdf')
  const first = await service.open(pdf, '7')
  const firstToken = first.kind === 'pdf' ? first.token : ''

  for (let index = 0; index < 70; index += 1) {
    await service.open(pdf, '7')
  }

  assert.equal(service.resolveView(firstToken), null)
  const latest = await service.open(pdf, '7')
  assert.equal(service.resolveView(latest.kind === 'pdf' ? latest.token : ''), pdf)
})

test('a viewer token dies with the file it was issued for', async () => {
  const { home, service } = fixture()
  const pdf = join(home, 'Documents', 'Reports', 'q3 report.pdf')
  const opened = await service.open(pdf, '7')
  const token = opened.kind === 'pdf' ? opened.token : ''

  assert.equal(service.resolveView(token), pdf)
  await service.rename(pdf, 'renamed.pdf')
  assert.equal(service.resolveView(token), null)
})

test('a viewer token is bound to the file identity: a same-name replacement stops resolving', async () => {
  const { home, service } = fixture()
  const pdf = join(home, 'Documents', 'Reports', 'q3 report.pdf')
  const opened = await service.open(pdf, '7')
  const token = opened.kind === 'pdf' ? opened.token : ''
  assert.equal(service.resolveView(token), pdf)

  // Same path, different inode. The replacement is created while the original
  // still exists so the two can never share an inode number — Linux reuses a
  // freed inode readily, so delete-then-write is not a replacement there.
  const replacement = join(home, 'Documents', 'Reports', 'incoming.pdf')
  writeFileSync(replacement, 'a different document')
  renameSync(replacement, pdf)
  assert.equal(service.resolveView(token), null)
  assert.equal(service.releaseView(token), false)
})

test('resolving keeps an open document alive past the idle TTL', async () => {
  const { home, service } = fixture()
  const pdf = join(home, 'Documents', 'Reports', 'q3 report.pdf')
  const opened = await service.open(pdf, '7')
  const token = opened.kind === 'pdf' ? opened.token : ''
  const registry = (service as unknown as { views: Map<string, { expiresAt: number }> }).views
  const issuedAt = registry.get(token)!.expiresAt

  // Age the token to the brink, then resolve: an open viewer is not idle.
  registry.get(token)!.expiresAt = Date.now() + 1000
  assert.equal(service.resolveView(token), pdf)
  assert.ok(registry.get(token)!.expiresAt >= issuedAt - 5, 'TTL slid forward on resolve')
})

test('rename and trash tell the caller which absolute paths moved, so document metadata can follow', async () => {
  const { home } = fixture()
  const moved: Array<[string, string]> = []
  const trashed: string[] = []

  const service = new AtumConsumerFilesService({
    onRenamed: (from, to) => moved.push([from, to]),
    onTrashed: target => trashed.push(target),
    roots: () => ({
      desktop: join(home, 'Desktop'),
      documents: join(home, 'Documents'),
      downloads: join(home, 'Downloads'),
      home
    }),
    shell: { openPath: async () => '', showItemInFolder: () => undefined, trashItem: async () => undefined }
  })

  const renamed = await service.rename(join(home, 'Documents', 'notes.md'), 'plan.md')
  assert.deepEqual(moved, [[join(home, 'Documents', 'notes.md'), renamed.path]])
  await service.trash(renamed.path)
  assert.deepEqual(trashed, [renamed.path])
})


test('file capture is bounded, frozen, revoked on replacement, and never grants a PDF viewer for binary cards', async () => {
  const { home, service } = fixture()
  const target = join(home, 'Documents', 'budget.xlsx')
  const card = await service.open(target, '7')
  assert.ok(card.kind === 'card')
  const first = await service.capture(card.token)
  assert.equal(service.resolveView(card.token), null)
  writeFileSync(target, 'different contents')
  const second = await service.capture(card.token)
  assert.notEqual(first.dataUrl, second.dataUrl)
  assert.notEqual(first.revision, second.revision)
  service.releaseView(card.token)
  await assert.rejects(() => service.capture(card.token))

  const replacement = await service.open(target, '7')
  assert.ok(replacement.kind === 'card')
  rmSync(target)
  symlinkSync(join(home, '.ssh', 'id_ed25519'), target)
  await assert.rejects(() => service.capture(replacement.token))
})
