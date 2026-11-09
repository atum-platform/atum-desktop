/**
 * Deliberately narrow D3 interaction harness. It is not a product editor or a
 * Markdown serializer: every supported operation dispatches a real mounted
 * ProseMirror transaction and then applies the corresponding validated source
 * range patch to the canonical Markdown proof session.
 */
import { history, undo } from 'prosemirror-history'
import { Schema } from 'prosemirror-model'
import { EditorState, TextSelection } from 'prosemirror-state'
import { schema as basicSchema } from 'prosemirror-schema-basic'
import { tableNodes } from 'prosemirror-tables'
import { EditorView } from 'prosemirror-view'

import { RichMarkdownProofSession } from '../../src/app/chat/document/rich-markdown-proof'

export { RichMarkdownProofSession } from '../../src/app/chat/document/rich-markdown-proof'

export const SYNTHETIC_MARKDOWN =
  '# Kế hoạch\r\n\r\nBefore **bold** text.\r\n\r\n| One | Two |\r\n| --- | --- |\r\n| cell | giữ nguyên |\r\n\r\nAfter two spaces.  \r\n'

const schema = new Schema({
  marks: basicSchema.spec.marks,
  nodes: basicSchema.spec.nodes.append(tableNodes({ cellContent: 'paragraph+', tableGroup: 'block' }))
})

function paragraph(text, marks = []) {
  return schema.nodes.paragraph.create(null, schema.text(text, marks))
}

function documentForProof() {
  const strong = schema.marks.strong.create()

  return schema.nodes.doc.create(null, [
    schema.nodes.heading.create({ level: 1 }, schema.text('Kế hoạch')),
    schema.nodes.paragraph.create(null, [schema.text('Before '), schema.text('bold', [strong]), schema.text(' text.')]),
    schema.nodes.table.create(null, [
      schema.nodes.table_row.create(null, [
        schema.nodes.table_header.create(null, paragraph('One')),
        schema.nodes.table_header.create(null, paragraph('Two'))
      ]),
      schema.nodes.table_row.create(null, [
        schema.nodes.table_cell.create(null, paragraph('cell')),
        schema.nodes.table_cell.create(null, paragraph('giữ nguyên'))
      ])
    ]),
    paragraph('After two spaces.')
  ])
}

function textPosition(doc, text) {
  let found = -1

  doc.descendants((node, position) => {
    if (found === -1 && node.isText && node.text === text) {
      found = position
    }
  })

  if (found < 0) {
    throw new Error(`The synthetic ProseMirror document is missing ${text}.`)
  }

  return found
}

function sourcePatchMatches(source, range, insert) {
  return source.slice(0, range.from) + insert + source.slice(range.to)
}

/** Mounts proof-only controls and a real EditorView into the provided root. */
export function mountRichProseMirrorProof(root) {
  const opened = RichMarkdownProofSession.open(SYNTHETIC_MARKDOWN)

  if (opened.kind !== 'opened') {
    throw new Error(`Synthetic proof fixture was refused: ${opened.eligibility.refusals.map(item => item.feature).join(', ')}`)
  }

  const session = opened.session
  const controls = document.createElement('section')
  controls.setAttribute('aria-label', 'Proof-only rich Markdown controls')
  const editorHost = document.createElement('div')
  const sourceHost = document.createElement('pre')
  const status = document.createElement('output')
  const savedHost = document.createElement('pre')
  const buttons = new Map()
  let savedSource = ''
  let tableCellSelected = false

  const render = message => {
    sourceHost.textContent = session.source
    savedHost.textContent = savedSource || '(not saved)'
    status.textContent = message
  }

  const button = (label, action) => {
    const element = document.createElement('button')
    element.textContent = label
    element.type = 'button'
    element.addEventListener('click', action)
    controls.append(element)
    buttons.set(label, element)
  }

  root.append(controls, editorHost, status, sourceHost, savedHost)
  sourceHost.setAttribute('data-proof-canonical-source', 'true')
  savedHost.setAttribute('data-proof-saved-source', 'true')
  editorHost.setAttribute('data-proof-mounted-editor', 'true')
  status.setAttribute('data-proof-status', 'true')

  const editor = new EditorView(editorHost, {
    // JSDOM has no layout boxes. Product browsers keep normal scrolling; this
    // proof prevents its synthetic environment from trying to measure them.
    handleScrollToSelection: () => true,
    state: EditorState.create({ doc: documentForProof(), plugins: [history()] })
  })

  const editText = (visible, insert, sourceRange) => {
    const from = textPosition(editor.state.doc, visible)
    const before = session.source
    // Validate on an isolated canonical session before the EditorView receives
    // its transaction. This keeps even the scripted proof from applying a rich
    // mutation when its source patch would be refused or non-minimal.
    const preflight = RichMarkdownProofSession.open(before)

    if (preflight.kind !== 'opened') {
      throw new Error(`The current source became ineligible before editing ${visible}.`)
    }
    const proposed = preflight.session.replaceText(sourceRange, insert)

    if (!proposed || preflight.session.source !== sourcePatchMatches(before, sourceRange, insert)) {
      throw new Error(`Refused or non-minimal source patch for ${visible}.`)
    }

    editor.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, from + visible.length)).insertText(insert))
    const patch = session.replaceText(sourceRange, insert)

    if (!patch || session.source !== preflight.session.source) {
      throw new Error(`The mounted editor and canonical patch diverged for ${visible}.`)
    }
  }

  button('Open synthetic document', () => render('Proof opened. No canonical bytes changed.'))
  button('Edit bold text', () => {
    const range = session.selectionForText('bold')

    if (!range) {
      throw new Error('The canonical bold range is unavailable.')
    }
    editText('bold', 'stronger', range)
    render('Mounted editor transaction and exact bold source patch applied.')
  })
  button('Next table cell', () => {
    const from = textPosition(editor.state.doc, 'cell')
    editor.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, from + 'cell'.length)))
    if (editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to) !== 'cell') {
      throw new Error('Mounted editor did not select the requested table cell.')
    }
    editor.focus()
    tableCellSelected = true
    render('Mounted editor selection moved to the first body table cell.')
  })
  button('Edit table cell', () => {
    if (!tableCellSelected) {
      throw new Error('Select a table cell before editing it.')
    }
    const range = session.selectionForText('cell')

    if (!range) {
      throw new Error('The canonical table-cell range is unavailable.')
    }
    editText('cell', 'đã sửa', range)
    render('Mounted editor cell transaction and exact table-cell source patch applied.')
  })
  button('Undo source + editor', () => {
    const changed = undo(editor.state, transaction => editor.dispatch(transaction))

    if (!changed || !session.undo()) {
      throw new Error('The editor and canonical histories diverged.')
    }
    render('One real ProseMirror history step and one exact canonical-source undo applied.')
  })
  button('Save proof snapshot', () => {
    savedSource = session.source
    render('Proof-only save snapshot captured; no product lease or file write is involved.')
  })
  button('Reopen proof snapshot', () => {
    const reopened = RichMarkdownProofSession.open(savedSource)

    if (reopened.kind !== 'opened' || reopened.session.source !== savedSource) {
      throw new Error('Proof-only reopen changed canonical Markdown bytes.')
    }
    render('Proof-only snapshot reopened without serializing Markdown.')
  })
  render('Synthetic proof ready. These controls do not route to the product editor or filesystem.')

  return {
    destroy: () => editor.destroy(),
    editor,
    source: () => session.source,
    runScenario: () => {
      buttons.get('Open synthetic document').click()
      buttons.get('Edit bold text').click()
      buttons.get('Next table cell').click()
      buttons.get('Edit table cell').click()
      buttons.get('Save proof snapshot').click()
      buttons.get('Reopen proof snapshot').click()
      const reopenedSource = savedSource
      buttons.get('Undo source + editor').click()
      buttons.get('Undo source + editor').click()

      if (session.source !== SYNTHETIC_MARKDOWN) {
        throw new Error('Two undo operations did not restore the exact original canonical bytes.')
      }
      if (editor.state.doc.textContent !== 'Kế hoạchBefore bold text.OneTwocellgiữ nguyênAfter two spaces.') {
        throw new Error('Two undo operations did not restore the original mounted editor document.')
      }

      return { finalSource: session.source, reopenedSource, status: status.textContent ?? '' }
    }
  }
}
