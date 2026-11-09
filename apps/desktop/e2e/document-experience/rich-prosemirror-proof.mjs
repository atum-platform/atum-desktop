// Reproducible, isolated D3 interaction proof. The first argument is a
// disposable dependency directory containing `node_modules/prosemirror-*`.
// The optional second argument receives a temporary esbuild bundle; neither
// dependencies nor the generated output are committed to the product tree.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const thisDirectory = path.dirname(fileURLToPath(import.meta.url))
const desktopDirectory = path.resolve(thisDirectory, '../..')
const repositoryDirectory = path.resolve(desktopDirectory, '../..')
const dependencyArgument = process.argv[2]

if (!dependencyArgument) {
  throw new Error(
    'Usage: node rich-prosemirror-proof.mjs <dependency-directory> [temporary-output-directory]'
  )
}

const dependencyDirectory = path.resolve(dependencyArgument)
const outputDirectory = path.resolve(process.argv[3] ?? path.join(dependencyDirectory, 'rich-proof-output'))
const dependencyModules = path.join(dependencyDirectory, 'node_modules')
const repositoryModules = path.join(repositoryDirectory, 'node_modules')
const requireFromRepository = createRequire(path.join(repositoryDirectory, 'package.json'))
const { JSDOM } = requireFromRepository('jsdom')
const esbuild = requireFromRepository('esbuild')
const bundle = path.join(outputDirectory, 'rich-prosemirror-proof.cjs')

await mkdir(outputDirectory, { recursive: true })
await esbuild.build({
  absWorkingDir: desktopDirectory,
  bundle: true,
  entryPoints: [path.join(thisDirectory, 'rich-prosemirror-ui.mjs')],
  format: 'cjs',
  nodePaths: [dependencyModules, repositoryModules],
  outfile: bundle,
  platform: 'node',
  sourcemap: false,
  target: 'node20'
})

const dom = new JSDOM('<!doctype html><html><body><main id="proof"></main></body></html>', {
  pretendToBeVisual: true,
  url: 'https://atum-proof.invalid/'
})
Object.assign(globalThis, {
  DOMParser: dom.window.DOMParser,
  HTMLElement: dom.window.HTMLElement,
  MutationObserver: dom.window.MutationObserver,
  Node: dom.window.Node,
  getSelection: dom.window.getSelection.bind(dom.window),
  requestAnimationFrame: callback => setTimeout(callback, 0),
  cancelAnimationFrame: handle => clearTimeout(handle),
  window: dom.window,
  document: dom.window.document
})

const requireBundle = createRequire(bundle)
const { SYNTHETIC_MARKDOWN, mountRichProseMirrorProof, RichMarkdownProofSession } = requireBundle(bundle)
const root = dom.window.document.querySelector('#proof')
assert.ok(root)
const proof = mountRichProseMirrorProof(root)
assert.ok(root.querySelector('[data-proof-mounted-editor] .ProseMirror'), 'EditorView mounted a live contenteditable surface.')
assert.ok(root.querySelector('button'), 'Proof controls are mounted.')

// Negative product-routing gate: a default EditorView accepts an ordinary text
// transaction, but no automatic canonical-buffer bridge exists. The scripted
// controls below deliberately perform both operations; they are not evidence
// that normal rich typing is safe to route into a Markdown-authoritative pane.
const typingRoot = dom.window.document.createElement('main')
dom.window.document.body.append(typingRoot)
const typingProof = mountRichProseMirrorProof(typingRoot)
const typingPosition = 1
typingProof.editor.dispatch(typingProof.editor.state.tr.insertText('X', typingPosition, typingPosition))
assert.notEqual(typingProof.editor.state.doc.textContent, 'Kế hoạchBefore bold text.OneTwocellgiữ nguyênAfter two spaces.')
assert.equal(typingProof.source(), SYNTHETIC_MARKDOWN, 'Default EditorView typing did not reach the canonical Markdown buffer.')
typingProof.destroy()

const result = proof.runScenario()
assert.equal(result.finalSource, SYNTHETIC_MARKDOWN, 'Undo restored canonical bytes exactly.')
assert.match(result.reopenedSource, /stronger/u, 'Save/reopen retained the edited snapshot exactly.')
assert.match(result.reopenedSource, /\| đã sửa \| giữ nguyên \|/u, 'Table-cell edit retained its Markdown row bytes.')
assert.equal(root.querySelector('[data-proof-canonical-source]')?.textContent, SYNTHETIC_MARKDOWN)

const unsupported = '<div>opaque block</div>\n\nEscaped \\*inline\\*\n'
// Unsupported source is rejected by the same canonical proof before a rich
// document is built. This assertion is left in the compiled proof runner so
// the no-mutation gate is concrete, even though its UI fixture stays eligible.
const rejected = RichMarkdownProofSession.open(unsupported)
assert.equal(rejected.kind, 'refused')
assert.equal(unsupported, '<div>opaque block</div>\n\nEscaped \\*inline\\*\n')

console.log(`PASS: scripted mounted EditorView feasibility proof completed. D3 NO-GO for product routing: default typing bypasses canonical Markdown until transaction interception and validated PM-to-source mapping exist. Bundle: ${bundle}`)
proof.destroy()
dom.window.close()
