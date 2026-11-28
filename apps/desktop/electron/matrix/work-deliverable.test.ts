import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { afterEach, expect, it, vi } from 'vitest'

import { workSessionPaths } from '../work/session/paths'

import type { NativeWorkDriveTarget } from './drive-import-native'
import { type WorkDeliverableResult, WorkDeliverables } from './work-deliverable'
import { WorkDeliverableHost } from './work-deliverable-host'

const python = process.env.WORK_DOCX_PYTHON ?? 'python3'
const native = it.skipIf(!['darwin', 'linux'].includes(process.platform))
const result: WorkDeliverableResult = { path: 'Memo.docx', format: 'docx', preview: null }
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {rmSync(root, { recursive: true, force: true })}
})

function setup(prepare = true) {
  const home = mkdtempSync(path.join(realpathSync(tmpdir()), 'work-deliverable-'))
  roots.push(home)
  const root = path.join(home, 'Drive')
  const output = path.join(home, 'output')
  const folder = path.join(root, 'Agents', 'Research', 'deliverables')
  const source = path.join(output, result.path)
  mkdirSync(folder, { recursive: true })
  mkdirSync(output)

  if (prepare) {
    execFileSync(python, ['-I', '-B', '-c', `
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], 'w') as file:
    file.writestr('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
    file.writestr('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
    file.writestr('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>')
`, source])
  }

  const { dev, ino } = lstatSync(root)

  const target = vi.fn<() => NativeWorkDriveTarget | undefined>(() => ({
    root, dev, ino, ownerKey: 'owner:1', bindingKey: 'owner-drive'
  }))

  const remaining = vi.fn<() => number | undefined>()

  const manifestFor = vi.fn(async (paths: readonly string[]) => ({
    root,
    files: new Map(paths.map(relative => [relative, {
      etag: '"v1"',
      size: lstatSync(path.join(root, relative)).size,
      resource: { storage: 'storage', space: 'personal', opaque: 'resource' }
    }]))
  }))

  const workspace = vi.fn(async () => '/Agents/Research')
  const open = vi.fn(async () => {})
  const receiver = () => new WorkDeliverables(home, python, { workspace, target, remaining, manifestFor, open })
  const pin = async () => (await receiver().pin(randomUUID(), 'research-agent', output))!

  return { home, root, output, folder, source, target, remaining, manifestFor, workspace, open, receiver, pin }
}

native('places only under the enrolled assistant folder and uses a sibling on collision', async () => {
  const s = setup()
  writeFileSync(path.join(s.folder, 'Memo.docx'), 'original')
  const scope = await s.pin()
  expect(s.workspace).toHaveBeenCalledWith('research-agent')
  const receiver = s.receiver()

  expect(await receiver.receive(scope, result)).toEqual({ state: 'saved', name: 'Memo (2).docx', artifactId: scope.artifactId })
  expect(readFileSync(path.join(s.folder, 'Memo.docx'), 'utf8')).toBe('original')
  expect(readFileSync(path.join(s.folder, 'Memo (2).docx'))).toEqual(readFileSync(s.source))
  await receiver.open(scope, result)
  expect(s.open).toHaveBeenCalledWith('Agents/Research/deliverables/Memo (2).docx', expect.objectContaining({ ino: expect.any(Number) }))
})

native('refuses output symlinks and replaced assistant directories', async () => {
  const s = setup()
  const scope = await s.pin()
  const outside = path.join(s.home, 'outside.docx')
  renameSync(s.source, outside)
  symlinkSync(outside, s.source)
  expect((await s.receiver().receive(scope, result)).state).toBe('invalid')
  expect(readdirSync(s.folder)).toEqual([])

  const moved = s.folder + '-moved'
  renameSync(s.folder, moved)
  symlinkSync(moved, s.folder)
  expect((await s.receiver().receive(scope, result)).state).toBe('invalid')
  expect(readdirSync(moved)).toEqual([])
})

native('rejects a folder symlink at admission and a replacement during the native handoff', async () => {
  const s = setup()
  const scope = await s.pin()
  const moved = s.folder + '-moved'
  s.target.mockImplementationOnce(() => scope.target).mockImplementationOnce(() => {
    renameSync(s.folder, moved)
    mkdirSync(s.folder)

    return scope.target
  })
  expect((await s.receiver().receive(scope, result)).state).toBe('changed')
  expect(readdirSync(moved)).toEqual([])
  expect(readdirSync(s.folder)).toEqual([])

  renameSync(s.folder, s.folder + '-replacement')
  symlinkSync(moved, s.folder)
  await expect(s.pin()).rejects.toThrow('work_deliverable_directory_invalid')
})

native('refuses a different Drive owner generation or root identity', async () => {
  const s = setup()
  const scope = await s.pin()
  s.target.mockReturnValueOnce({ ...scope.target, ownerKey: 'owner:2' })
  expect((await s.receiver().receive(scope, result)).state).toBe('changed')

  const moved = s.root + '-moved'
  s.target.mockImplementationOnce(() => scope.target).mockImplementationOnce(() => {
    renameSync(s.root, moved)
    mkdirSync(s.folder, { recursive: true })

    return scope.target
  })
  expect((await s.receiver().receive(scope, result)).state).toBe('changed')
  expect(readdirSync(s.folder)).toEqual([])
  expect(readdirSync(path.join(moved, 'Agents/Research/deliverables'))).toEqual([])
})

native('keeps the prepared copy on quota refusal and reconciles a committed rename across receivers', async () => {
  const s = setup()
  const scope = await s.pin()
  s.remaining.mockReturnValueOnce(0)
  expect((await s.receiver().receive(scope, result)).state).toBe('no_room')
  expect(readdirSync(s.folder)).toEqual([])
  rmSync(s.source)

  s.manifestFor.mockResolvedValueOnce({ root: s.root, files: new Map() })
  expect((await s.receiver().receive(scope, result)).state).toBe('syncing')
  const restored = { ...scope, mainInstance: randomUUID() }
  s.target.mockReturnValue({ ...scope.target, ownerKey: 'owner:0' })
  expect((await s.receiver().receive(restored, result)).state).toBe('saved')
  expect(readdirSync(s.folder)).toEqual(['Memo.docx'])
  s.target.mockReturnValueOnce({ ...scope.target, ownerKey: 'different:0', bindingKey: 'other-drive' })
  expect((await s.receiver().status(restored, result)).state).toBe('changed')
  writeFileSync(path.join(s.folder, 'Memo.docx'), 'edited')
  expect((await s.receiver().receive(restored, result)).state).toBe('changed')
  expect(readdirSync(s.folder)).toEqual(['Memo.docx'])
})

native('cannot start a new placement from an earlier process without a durable intent', async () => {
  const s = setup()
  const scope = await s.pin()

  expect((await s.receiver().receive({ ...scope, mainInstance: randomUUID() }, result)).state).toBe('retry')
  expect(readdirSync(s.folder)).toEqual([])
})

native('rejects malformed output, traversal and a stopped placement', async () => {
  const s = setup()
  const scope = await s.pin()
  expect((await s.receiver().receive(scope, { ...result, path: '../Memo.docx' })).state).toBe('invalid')
  expect((await s.receiver().receive(scope, result, AbortSignal.abort())).state).toBe('cancelled')
  writeFileSync(s.source, 'not a Word archive')
  expect((await s.receiver().receive(scope, result)).state).toBe('invalid')
  expect(readdirSync(s.folder)).toEqual([])
})

function settlementFixture() {
  const s = setup()
  const owner = { key: 'owner', root: path.join(s.home, 'work-account') }
  const scratch = path.join(workSessionPaths(owner).home, 'scratch', 'weekly-memo')
  const id = { threadId: 'thread-1', runId: 'run-1', artifactId: randomUUID() }
  const outputRoot = path.join(scratch, `.work-output-${id.artifactId}`)
  mkdirSync(scratch, { recursive: true })
  mkdirSync(outputRoot, { mode: 0o700 })
  const contents = readFileSync(s.source)
  writeFileSync(path.join(outputRoot, result.path), contents)
  const pin = { ...id, type: 'work-deliverable-pin', outputRoot }
  const settle = { ...id, type: 'work-deliverable-settled', result }
  const agents = vi.fn(async () => ['research-agent'])
  const host = () => new WorkDeliverableHost(s.receiver(), agents)
  const signal = new AbortController().signal

  return { ...s, owner, contents, id, pin, settle, agents, host, signal }
}

native('places an authenticated Work settlement, acknowledges sync and replays without an extra file', async () => {
  const s = settlementFixture()
  const first = s.host()
  const send = (message: unknown) => first.message(s.owner, message, () => true, s.signal)
  const { artifactId } = s.id

  expect(await first.status(s.owner, s.id)).toBeNull()
  expect(await send(s.pin)).toEqual({ type: 'work-deliverable-pinned', artifactId, accepted: true })
  expect(s.workspace).toHaveBeenCalledExactlyOnceWith('research-agent')

  s.manifestFor.mockResolvedValueOnce({ root: s.root, files: new Map() })
  expect(await send(s.settle)).toEqual({
    type: 'work-deliverable-ack', artifactId, status: { state: 'syncing', artifactId, name: 'Memo.docx' }
  })
  expect(readFileSync(path.join(s.folder, 'Memo.docx'))).toEqual(s.contents)
  s.manifestFor.mockResolvedValueOnce({ root: s.root, files: new Map() })
  expect(await first.open(s.owner, s.id, () => true)).toBe(false)
  expect(s.open).not.toHaveBeenCalled()

  const restarted = s.host()
  const saved = { state: 'saved', artifactId, name: 'Memo.docx' }
  expect(await restarted.status(s.owner, s.id)).toEqual(saved)
  expect(await restarted.open(s.owner, s.id, () => true)).toBe(true)
  expect(s.open).toHaveBeenCalledWith('Agents/Research/deliverables/Memo.docx', expect.objectContaining({ ino: expect.any(Number) }))

  const replay = (message: unknown) => restarted.message(s.owner, message, () => true, s.signal)
  const acknowledgements = await Promise.all([replay(s.settle), replay(s.settle)])
  expect(acknowledgements).toEqual(Array(2).fill({ type: 'work-deliverable-ack', artifactId, status: saved }))
  expect(readdirSync(s.folder)).toEqual(['Memo.docx'])
  expect(await restarted.status(s.owner, { ...s.id, runId: 'unrelated-run' })).toBeNull()
  expect(await restarted.open({ ...s.owner, key: 'other' }, s.id, () => true)).toBe(false)
})

native('refuses unadmitted, out-of-Scratch, stale owner and ambiguous-assistant settlements', async () => {
  const s = settlementFixture()
  const host = s.host()
  const send = (message: unknown, current = () => true) => host.message(s.owner, message, current, s.signal)
  const { artifactId } = s.id
  const refusal = { type: 'work-deliverable-pinned', artifactId, accepted: false }

  expect(await send(s.settle)).toMatchObject({ status: { state: 'invalid' } })
  expect(await send({ ...s.pin, outputRoot: s.output })).toEqual(refusal)
  expect(await send(s.pin, () => false)).toEqual(refusal)
  expect(s.agents).not.toHaveBeenCalled()

  let active = true
  s.agents.mockImplementationOnce(async () => {
    active = false

    return ['research-agent']
  })
  expect(await send(s.pin, () => active)).toEqual(refusal)
  expect(s.workspace).not.toHaveBeenCalled()

  s.agents.mockResolvedValueOnce(['research-agent', 'another-agent'])
  expect(await send(s.pin)).toEqual(refusal)
  expect(await send(s.settle)).toMatchObject({ status: { state: 'drive_unavailable' } })
  expect(await host.open(s.owner, s.id, () => true)).toBe(false)
  expect(readdirSync(s.folder)).toEqual([])
})

it.skipIf(!process.env.WORK_DOCX_PYTHON)('dry-runs the actual runtime memo through placement and editable reopen', async () => {
  const s = setup(false)
  const memo = path.join(s.home, 'memo.json')
  writeFileSync(memo, JSON.stringify({
    title: 'Weekly operations memo',
    sections: [
      { heading: 'Summary', paragraphs: ['The team completed the inventory.'],
        table: { headers: ['Item', 'Status'], rows: [['Inventory', 'Complete']] } },
      { heading: 'Next steps', page_break: true, paragraphs: ['Confirm the next review date.'] }
    ]
  }))
  const script = fileURLToPath(new URL('../../scripts/work-memo.py', import.meta.url))
  execFileSync(python, ['-I', '-B', script, memo, s.source])

  if (process.env.WORK_DOCX_SOFFICE) {
    const profile = pathToFileURL(path.join(s.home, 'office-profile')).href
    execFileSync(process.env.WORK_DOCX_SOFFICE, [
      `-env:UserInstallation=${profile}`, '--headless', '--convert-to', 'pdf', '--outdir', s.home, s.source
    ], { timeout: 45_000 })

    const pages = execFileSync('pdftotext', ['-layout', path.join(s.home, 'Memo.pdf'), '-'], { encoding: 'utf8' })
      .split('\f').filter(page => page.trim())

    expect(pages).toHaveLength(2)
    expect(pages[0]).toContain('Weekly operations memo')
    expect(pages[0]).toContain('Complete')
    expect(pages[1]).toContain('Confirm the next review date.')
  }

  const scope = await s.pin()
  expect((await s.receiver().receive(scope, result)).state).toBe('saved')
  execFileSync(python, ['-I', '-B', '-c', `
import sys
from docx import Document
doc = Document(sys.argv[1])
assert [p.text for p in doc.paragraphs if p.style.name == 'Heading 1'] == ['Summary', 'Next steps']
assert doc.tables[0].cell(1, 1).text == 'Complete'
`, path.join(s.folder, result.path)])
}, 55_000)
