import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { build } from 'esbuild'
import { afterEach, expect, it, vi } from 'vitest'

import { workSessionPaths } from '../work/session/paths'

import type { WorkDesignRenderer } from './drive-import-native'
import { WorkDeliverables } from './work-deliverable'
import { WorkDeliverableHost } from './work-deliverable-host'

const roots: string[] = []
const html = (title: string, size = 36) => `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<title>Community Flyer</title><style>body{margin:0;background:#0d2935;color:white;font-family:Arial}
main{padding:48px}h1{font-size:${size}px}@media(max-width:700px){main{padding:20px}}</style></head>
<body><main><h1>${title}</h1><p>Saturday at the library</p></main></body></html>`
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240" viewBox="0 0 320 240">' +
  '<rect width="320" height="240" fill="#155e75"/><text x="24" y="60" fill="white">Read, plan, share</text></svg>'

afterEach(() => {
  for (const root of roots.splice(0)) {rmSync(root, { recursive: true, force: true })}
})

function workspace() {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'work-design-test-'))
  roots.push(root)
  return root
}

function lab(render: WorkDesignRenderer) {
  const home = workspace()
  const root = path.join(home, 'Drive')
  const owner = { root: path.join(home, 'owner'), key: 'fixture' }
  const folder = path.join(root, 'Agents', 'Research', 'deliverables')
  const source = path.join(workSessionPaths(owner).home, 'scratch', 'thread')
  mkdirSync(folder, { recursive: true })
  const { dev, ino } = lstatSync(root)
  const target = () => ({ root, dev, ino, ownerKey: owner.key, bindingKey: 'binding' })
  const open = vi.fn(async () => {})
  const remaining = vi.fn<() => number | undefined>()
  let pngSynced = true
  const receiver = new WorkDeliverables(home, 'python3', {
    target, workspace: async () => '/Agents/Research', open, remaining,
    manifestFor: async paths => ({
      root,
      files: new Map(paths.filter(relative => pngSynced || !relative.endsWith('.png')).map(relative => [relative, {
        etag: '"clean"', size: lstatSync(path.join(root, relative)).size,
        resource: { storage: 'storage', space: 'space', opaque: 'file' }
      }]))
    })
  }, render)
  const host = new WorkDeliverableHost(receiver, async () => ['research'])
  const signal = new AbortController().signal
  const current = () => true

  async function admit(bytes: string, format: 'html' | 'svg') {
    const identity = { artifactId: randomUUID(), threadId: 'same-thread', runId: randomUUID() }
    const outputRoot = path.join(source, '.work-output-' + identity.artifactId)
    const filename = 'Design.' + format
    mkdirSync(outputRoot, { recursive: true, mode: 0o700 })
    writeFileSync(path.join(outputRoot, filename), bytes)
    const send = (value: object) => host.message(owner, { ...identity, ...value }, current, signal)
    expect(await send({ type: 'work-deliverable-pin', outputRoot })).toMatchObject({ accepted: true })
    return {
      settle: () => send({ type: 'work-deliverable-settled', result: { format, path: filename, preview: null } }),
      status: () => host.status(owner, identity),
      open: (asset: string) => host.open(owner, { ...identity, asset }, current)
    }
  }

  return { admit, folder, open, remaining, setPngSynced: (synced: boolean) => { pngSynced = synced } }
}

const posix = !['darwin', 'linux'].includes(process.platform)

it.skipIf(posix).each([
  ['script', html('<script>void(0)</script>'), 'html'],
  ['event handler', svg.replace('<rect ', '<rect onload="void(0)" '), 'svg'],
  ['external URL', html('Flyer').replace('margin:0', 'background-image:url(https://example.com/logo.png)'), 'html'],
  ['malformed markup', svg.replace('</svg>', ''), 'svg'],
  ['oversized input', html('x'.repeat(512 * 1024)), 'html'],
  ['oversized dimensions', svg.replace('width="320"', 'width="2049"'), 'svg']
] as const)('refuses %s before rendering or placement', async (_name, source, format) => {
  const render = vi.fn<WorkDesignRenderer>()
  const s = lab(render)
  const run = await s.admit(source, format)
  expect(await run.settle()).toMatchObject({ status: { state: 'invalid' } })
  expect(render).not.toHaveBeenCalled()
  expect(readdirSync(s.folder)).toEqual([])
})

it.skipIf(posix)('refuses an empty raster before publishing the editable source', async () => {
  const s = lab(async () => Buffer.alloc(0))
  const run = await s.admit(svg, 'svg')
  expect(await run.settle()).toMatchObject({ status: { state: 'invalid' } })
  expect(readdirSync(s.folder)).toEqual([])
})

const electron = process.env.WORK_DESIGN_ELECTRON
const resvg = process.env.WORK_DESIGN_RESVG
const runElectron = promisify(execFile)

it.skipIf(posix || !electron || !resvg)('settles native HTML and SVG raster proofs and a same-thread revision', async () => {
  const root = workspace()
  const entry = path.join(root, 'preview.cjs')
  await build({
    entryPoints: [path.join(import.meta.dirname, 'work-design-preview.test-support.ts')],
    outfile: entry, bundle: true, platform: 'node', external: ['electron']
  })
  const render = vi.fn<WorkDesignRenderer>(async (source, format, width, height) => {
    const directory = workspace()
    writeFileSync(path.join(directory, 'source'), source)
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    await runElectron(electron!, [entry, resvg!, directory, format, String(width), String(height)], {
      env, timeout: 15_000, killSignal: 'SIGKILL'
    })
    return readdirSync(directory).includes('raster') ? readFileSync(path.join(directory, 'raster')) : null
  })
  const s = lab(render)
  const original = await s.admit(html('Community Flyer'), 'html')
  s.remaining.mockReturnValue(Buffer.byteLength(html('Community Flyer')))
  const partial = await original.settle()
  // Preserve renderer errors in the test output when the host reports a retry.
  expect(render).toHaveBeenCalledTimes(1)
  expect(await render.mock.results[0]?.value).toBeInstanceOf(Buffer)
  expect(partial).toMatchObject({ status: { state: 'no_room' } })
  expect(readdirSync(s.folder)).toEqual(['Design.html'])
  s.remaining.mockReturnValue(undefined)
  s.setPngSynced(false)
  expect(await original.settle()).toMatchObject({ status: { state: 'syncing', previewName: 'Design.html.png' } })
  expect(render).toHaveBeenCalledTimes(1)
  s.setPngSynced(true)
  expect(await original.status()).toMatchObject({ state: 'saved', name: 'Design.html', previewName: 'Design.html.png' })
  expect(await original.open('preview')).toBe(true)
  expect(s.open).toHaveBeenCalledWith('Agents/Research/deliverables/Design.html.png', expect.any(Object))

  const diagram = await s.admit(svg, 'svg')
  expect(await diagram.settle()).toMatchObject({ status: { state: 'saved', previewName: 'Design.svg.png' } })
  const revised = await s.admit(html('Community Flyer', 54), 'html')
  expect(await revised.settle()).toMatchObject({ status: { state: 'saved', name: 'Design (2).html', previewName: 'Design (2).html.png' } })
  expect(await revised.settle()).toMatchObject({ status: { state: 'saved', name: 'Design (2).html' } })
  expect(render).toHaveBeenCalledTimes(3)
  expect(readFileSync(path.join(s.folder, 'Design.html'), 'utf8')).toBe(html('Community Flyer'))
  expect(readFileSync(path.join(s.folder, 'Design (2).html'), 'utf8')).toBe(html('Community Flyer', 54))
  for (const [name, width, height] of [['Design.html.png', 1200, 1600], ['Design.svg.png', 320, 240]] as const) {
    const png = readFileSync(path.join(s.folder, name))
    expect(png.length).toBeGreaterThan(100)
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([width, height])
  }
  expect(readFileSync(path.join(s.folder, 'Design (2).html.png'))).not.toEqual(readFileSync(path.join(s.folder, 'Design.html.png')))
}, 60_000)
