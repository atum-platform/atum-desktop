// Real AW reader/store -> native supervisor -> pinned GBrain/PGLite proof.
// Admission and source revisions are synthetic fixtures, NOT SDK visibility or
// an allocated live reader. No token, installed home, model, send or cloud path.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, statfs } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { build } from 'esbuild'

import { corpus, retrievalRequest } from '../vendor/local-brain/test/fixtures/corpus.mjs'
import { stageLocalBrain, writeSignedLocalBrainReceipt } from './stage-local-brain.mjs'

const desktop = path.resolve(import.meta.dirname, '..')
const disk = await statfs(desktop)
if (disk.bavail * disk.bsize < 1024 ** 3) throw new Error('awareness_local_proof_disk_floor')
// Bundle the actual extensionless TypeScript imports, not a reimplementation.
const compiled = await build({
  stdin: {
    contents: `export { AwarenessReader } from './electron/matrix/awareness/reader.ts';
export { awarenessFileStore } from './electron/matrix/awareness/store.ts';
export { awarenessLocalTransport } from './electron/matrix/awareness/local-transport.ts';
export { MatrixLocalBrain } from './electron/matrix/local-brain.ts';`,
    resolveDir: desktop,
    loader: 'ts'
  },
  platform: 'node', format: 'esm', bundle: true, packages: 'external', write: false
})
const { AwarenessReader, awarenessFileStore, awarenessLocalTransport, MatrixLocalBrain } =
  await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)
const resources = path.join(desktop, 'build/local-brain', `${process.platform}-${process.arch}`)
await stageLocalBrain({ targetRoot: resources })
// The production receipt is written after nested signing; this source-only
// proof has no signing mutation and records the bytes it launches.
await writeSignedLocalBrainReceipt({ targetRoot: resources })
const userData = await mkdtemp(path.join(os.tmpdir(), 'atum-aw-local-proof-'))
const children = []
const pids = []
const brain = new MatrixLocalBrain({
  resources, userData, nodePath: process.execPath, runAsNode: false,
  startupTimeoutMs: 120_000, requestTimeoutMs: 30_000, stopTimeoutMs: 5_000,
  log: code => console.log(JSON.stringify({ providerCode: code })),
  spawn: (...args) => {
    const child = spawn(...args)
    children.push(child)
    return child
  }
})
const A = { accountKey: 'a'.repeat(64), generation: 1 }
const B = { accountKey: 'b'.repeat(64), generation: 2 }
let current = null
let loseMethod = null
const sent = []
const provider = {
  ready: owner => brain.ready(owner),
  stop: () => brain.stop(),
  call: (owner, method, params) => {
    if (method === 'brain.ingest' || method === 'brain.withdraw') {
      sent.push({ method, params: structuredClone(params) })
    }
    if (method === loseMethod) {
      loseMethod = null
      children.at(-1).stdout.pause()
    }
    return brain.call(owner, method, params)
  }
}
const data = corpus().anDecision
const revision = {
  source: data.source, object: data.object, author: data.author,
  eventTime: data.eventTime, content: data.content
}
// A synthetic scan's timestamp frontier, not an SDK token or an event counter.
const batch = { source: revision.source, revisions: [revision], after: null, through: revision.eventTime, complete: false }
const file = path.join(userData, 'reader-a', 'metadata.json')
const signal = () => new AbortController().signal
const transport = owner => awarenessLocalTransport({ destination: 'local', brain: provider, owner, current: () => current })
const readerOptions = (port, create = false) => ({
  binding: 'synthetic-account-a/device-fixture', destination: 'local', create,
  store: awarenessFileStore(file), transport: port, requestTimeoutMs: 2_000,
  live: () => current?.accountKey === A.accountKey && current.generation === A.generation && brain.ready(A),
  readAccess: () => ({ active: true, keysAvailable: true, visibility: 'joined', readable: () => true })
})
const retrieve = owner => brain.call(owner, 'brain.retrieve', retrievalRequest({ class: 'private_owner' }, 'chốt ngày nhà đầu tư'))
const gone = pid => {
  try { process.kill(pid, 0); return false } catch (error) { if (error.code === 'ESRCH') return true; throw error }
}
let checks = 0
let reader
const trace = phase => console.log(JSON.stringify({ phase, checks }))
async function activate(owner) {
  current = owner
  await brain.activate(owner)
  const info = await brain.call(owner, 'brain.info')
  pids.push(info.pid, info.gbrain.pid)
  assert.equal(info.contract, 'atum.awareness/1'); checks++
  if (process.platform === 'darwin') { assert.equal(info.gbrain.sandboxed, true); checks++ }
}
try {
  trace('start')
  await activate(A)
  let port = transport(A)
  assert.deepEqual(Object.keys(port).sort(), ['coverage', 'fence', 'ingest', 'prepare', 'withdraw']); checks++
  reader = await AwarenessReader.open(readerOptions(port, true))
  await reader.register(revision.source)
  current = null
  await assert.rejects(port.prepare(signal()), { message: 'awareness_local_transport_unavailable' }); checks++
  await assert.rejects(reader.ingest(batch), { message: 'awareness_reader_stopped' }); checks++
  assert.equal(sent.length, 0); checks++
  current = A
  await port.prepare(signal())
  trace('lost-ingestion-receipt')
  loseMethod = 'brain.ingest'
  assert.equal((await reader.ingest(batch)).state, 'offline'); checks++
  assert.equal(brain.ready(A), false); checks++
  assert.deepEqual(reader.replayHint(revision.source), revision.object); checks++
  assert.equal(reader.coverage(revision.source).processedThrough, undefined); checks++
  reader.stop()
  await brain.stop()
  children.at(-1).stdout.resume()
  await activate(A)
  // The actual provider committed, although the AW reader never got its receipt.
  assert.ok((await retrieve(A)).items.some(item => item.citation.eventId === revision.object.id)); checks++
  port = transport(A)
  reader = await AwarenessReader.open(readerOptions(port))
  await reader.ingest(batch)
  assert.deepEqual(sent[1], sent[0]); checks++
  assert.equal(reader.replayHint(revision.source), undefined); checks++
  assert.equal(reader.coverage(revision.source).processedThrough, batch.through); checks++
  await reader.reportCoverage()
  const coverage = await brain.call(A, 'brain.coverage')
  assert.ok(coverage.entries.some(entry => entry.source.id === revision.source.id)); checks++
  trace('lost-withdrawal-receipt')
  loseMethod = 'brain.withdraw'
  assert.equal(await reader.withdraw({ kind: 'object', source: revision.source, objectId: revision.object.id }, 'forget'), false); checks++
  assert.equal(brain.ready(A), false); checks++
  reader.stop()
  await brain.stop()
  children.at(-1).stdout.resume()
  await activate(A)
  assert.deepEqual((await retrieve(A)).items, []); checks++
  port = transport(A)
  reader = await AwarenessReader.open(readerOptions(port))
  assert.equal(await reader.retryControls(), true); checks++
  assert.deepEqual(sent[3], sent[2]); checks++
  const count = sent.length
  await reader.ingest(batch)
  await reader.ingest({ ...batch, revisions: [{ ...revision, eventTime: revision.eventTime + 1, object: { kind: 'edit', id: '$synthetic-edit', revision: 2, replaces: revision.object.id }, content: { text: 'synthetic edit of a forgotten fact', attachments: [] } }], through: batch.through + 1 })
  assert.equal(sent.length, count); checks++
  assert.deepEqual((await retrieve(A)).items, []); checks++
  const metadata = await readFile(file, 'utf8')
  assert.equal(metadata.includes(revision.content.text), false); checks++
  assert.equal(metadata.includes('suppressionIds'), true); checks++
  await reader.observeFence({ v: 1, since: 100 })
  // Local reader observation does not publish a managed fence. RT owns the
  // actual local provider's native fence feed; exercise just its bounded port.
  assert.deepEqual((await brain.call(A, 'brain.info')).fence, { active: false, since: null }); checks++
  await port.fence({ v: 1, since: 100 }, signal())
  assert.deepEqual((await brain.call(A, 'brain.info')).fence, { active: true, since: 100 }); checks++
  reader.stop()
  trace('account-switch')
  await activate(B)
  await assert.rejects(port.prepare(signal()), { message: 'awareness_local_transport_unavailable' }); checks++
  assert.deepEqual((await retrieve(B)).items, []); checks++
  assert.equal(brain.ready(B), true); checks++
  await brain.stop()
  assert.ok(pids.every(gone)); checks++
  console.log(JSON.stringify({ proof: 'awareness-local-transport', checks, skipped: 0, admission: 'synthetic-only', sdkReader: false, managedReader: false }))
} catch (error) {
  // A data-URL module stack would dump the whole bundle into diagnostics.
  console.error(JSON.stringify({ proof: 'awareness-local-transport', result: 'failed', checks, error: String(error.message).slice(0, 300) }))
  process.exitCode = 1
} finally {
  reader?.stop()
  for (const child of children) child.stdout.resume()
  await brain.stop()
  assert.ok(pids.every(gone), 'owned provider and GBrain processes must leave before fixture deletion')
  await rm(userData, { recursive: true, force: true })
}
