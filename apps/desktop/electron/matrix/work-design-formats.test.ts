import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
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
const cssCommentBypass = 'p{content:"/*"} body{background:url(https://example.invalid/x)} p{content:"*/"}'
const onePixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD5sAAAAASUVORK5CYII=', 'base64')
const ordinaryHtml = html('<mark>Community&nbsp;Flyer &mdash; Saturday</mark><sup>1</sup>')
  .replace('font-family:Arial', 'font-family:"Helvetica Neue",Arial/* system fonts */')
  .replace('</style>', 'p::before{content:"/*"}</style>')
  .replace('</main>', '<aside><nav>Schedule</nav><blockquote>Everyone is welcome</blockquote></aside></main>')
const ordinarySvg = svg
  .replace('width="320" height="240" ', 'xmlns:xlink="http://www.w3.org/1999/xlink" xml:space="preserve" ')
  .replace('<rect ', '<defs><filter id="s"><feDropShadow dx="1" dy="1" stdDeviation="2"/></filter>' +
    '<pattern id="p" width="4" height="4" patternUnits="userSpaceOnUse"><circle r="1" fill="white"/></pattern>' +
    '<mask id="m" maskUnits="userSpaceOnUse"><rect width="320" height="240" fill="white"/></mask>' +
    '<circle id="c" cx="24" cy="24" r="8"/></defs><use xlink:href="#c"/><rect filter="url(#s)" mask="url(#m)" ')

afterEach(() => {
  for (const root of roots.splice(0)) {rmSync(root, { recursive: true, force: true })}
})

function workspace() {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'work-design-test-'))
  roots.push(root)
  return root
}

function lab(render: WorkDesignRenderer, thumbnail?: (bytes: Buffer) => string | undefined) {
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
  }, render, thumbnail)
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
  ['CSS comment delimiters inside strings', html('Flyer').replace('</style>', cssCommentBypass + '</style>'), 'html'],
  ['CSS comment delimiters inside SVG style strings', svg.replace('<rect ', '<style>' + cssCommentBypass + '</style><rect '), 'svg'],
  ['unclosed CSS comment', html('Flyer').replace('</style>', '/*</style>'), 'html'],
  ['unclosed CSS string', html('Flyer').replace('</style>', 'p{content:"open}</style>'), 'html'],
  ['external xlink target', ordinarySvg.replace('xlink:href="#c"', 'xlink:href="https://example.invalid/x"'), 'svg'],
  ['external filter', ordinarySvg.replace('filter="url(#s)"', 'filter="url(https://example.invalid/x)"'), 'svg'],
  ['embedded SVG image', ordinarySvg.replace('</filter>', '<feImage/></filter>'), 'svg'],
  ['invalid viewBox', ordinarySvg.replace('0 0 320 240', '0 0 2049 240'), 'svg'],
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

it.skipIf(posix).each([
  ['html', ordinaryHtml, 1200, 1600],
  ['svg', ordinarySvg, 320, 240]
] as const)('accepts ordinary static markup in %s', async (format, source, width, height) => {
  const render = vi.fn<WorkDesignRenderer>(async () => {
    // This case verifies the markup gate and PNG header, independent of Electron or resvg.
    const png = Buffer.from(onePixel)
    png.writeUInt32BE(width, 16)
    png.writeUInt32BE(height, 20)
    return png
  })
  const s = lab(render)
  const run = await s.admit(source, format)
  expect(await run.settle()).toMatchObject({ status: { state: 'saved' } })
  expect(render).toHaveBeenCalledWith(Buffer.from(source), format, width, height, expect.any(AbortSignal))
  expect(readFileSync(path.join(s.folder, 'Design.' + format), 'utf8')).toBe(source)
})

it.skipIf(posix)('only returns thumbnail data for a saved, verified companion', async () => {
  const png = onePixel
  const previewDataUrl = 'data:image/png;base64,' + png.toString('base64')
  const thumbnail = vi.fn(() => previewDataUrl)
  const source = svg.replace('width="320" height="240"', 'width="1" height="1"')
  const s = lab(async () => png, thumbnail)
  const design = await s.admit(source, 'svg')
  s.setPngSynced(false)
  expect(await design.settle()).toMatchObject({ status: { state: 'syncing' } })
  expect(await design.status()).not.toHaveProperty('previewDataUrl')
  expect(thumbnail).not.toHaveBeenCalled()

  s.setPngSynced(true)
  expect(await design.status()).toMatchObject({ state: 'saved', previewName: 'Design.svg.png', previewDataUrl })
  expect(thumbnail).toHaveBeenCalledExactlyOnceWith(png)

  writeFileSync(path.join(s.folder, 'Design.svg.png'), Buffer.alloc(png.length))
  expect(await design.status()).not.toHaveProperty('previewDataUrl')
  expect(thumbnail).toHaveBeenCalledTimes(1)
})

const electron = process.env.WORK_DESIGN_ELECTRON ??
  (process.platform === 'darwin' ? path.resolve(import.meta.dirname, '../../../../node_modules/.bin/electron') : undefined)
const resvg = process.env.WORK_DESIGN_RESVG ?? ''
const runElectron = promisify(execFile)

async function electronFixture() {
  const root = workspace()
  const entry = path.join(root, 'preview.cjs')
  await build({
    entryPoints: [path.join(import.meta.dirname, 'work-design-preview.test-support.ts')],
    outfile: entry, bundle: true, platform: 'node', external: ['electron']
  })
  return async (source: Buffer, format: 'html' | 'svg' | 'thumbnail', width?: number, height?: number) => {
    const directory = workspace()
    writeFileSync(path.join(directory, 'source'), source)
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    await runElectron(electron!, [entry, resvg, directory, format, String(width), String(height)], {
      env, timeout: 25_000, killSignal: 'SIGKILL'
    })
    const result = format === 'thumbnail' ? 'thumbnail' : 'raster'
    return readdirSync(directory).includes(result) ? readFileSync(path.join(directory, result)) : null
  }
}

it.skipIf(posix || !electron)('renders a narrow flyer and rejects subresource requests in the renderer itself', async () => {
  const render = await electronFixture()
  const narrow = await render(Buffer.from(ordinaryHtml), 'html', 390, 840)
  expect(narrow).toBeInstanceOf(Buffer)
  expect([narrow?.readUInt32BE(16), narrow?.readUInt32BE(20)]).toEqual([390, 840])

  const pixel = path.join(workspace(), 'pixel.png')
  writeFileSync(pixel, onePixel)
  for (const url of [
    pathToFileURL(pixel).href,
    '../' + path.basename(path.dirname(pixel)) + '/pixel.png',
    'https://example.invalid/pixel.png'
  ]) {
    const source = html('Flyer').replace('background:#0d2935', 'background:#0d2935 url("' + url + '")')
    // Call the production renderer without the markup gate, so only isolation can refuse it.
    expect(await render(Buffer.from(source), 'html', 390, 840) === null, url).toBe(true)
  }
}, 110_000)

it.skipIf(posix || !electron || !resvg)('settles native HTML and SVG raster proofs and a same-thread revision', async () => {
  const fixture = await electronFixture()
  const render = vi.fn<WorkDesignRenderer>((source, format, width, height) => fixture(source, format, width, height))
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

  const diagram = await s.admit(ordinarySvg, 'svg')
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
  const dataUrl = (await fixture(readFileSync(path.join(s.folder, 'Design.html.png')), 'thumbnail'))?.toString('utf8') ?? ''
  expect(dataUrl).toMatch(/^data:image\/png;base64,/u)
  const thumbnail = Buffer.from(dataUrl.split(',')[1], 'base64')
  expect(thumbnail.length).toBeLessThanOrEqual(512 * 1024)
  expect([thumbnail.readUInt32BE(16), thumbnail.readUInt32BE(20)]).toEqual([360, 480])
  expect(readFileSync(path.join(s.folder, 'Design (2).html.png'))).not.toEqual(readFileSync(path.join(s.folder, 'Design.html.png')))
}, 90_000)
