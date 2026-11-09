// Isolated feasibility check. Pass the directory containing a disposable
// node_modules with ProseMirror installed; this adds no production dependency.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(path.resolve(process.argv[2] ?? process.cwd(), 'package.json'))
const { Schema } = require('prosemirror-model')
const { schema: basic } = require('prosemirror-schema-basic')
const { EditorState } = require('prosemirror-state')
const { history, undo } = require('prosemirror-history')
const { tableNodes } = require('prosemirror-tables')
const schema = new Schema({ nodes: basic.spec.nodes.append(tableNodes({ tableGroup: 'block', cellContent: 'paragraph+' })), marks: basic.spec.marks })
const paragraph = text => schema.nodes.paragraph.create(null, schema.text(text))
const original = schema.nodes.doc.create(null, schema.nodes.table.create(null, [
  schema.nodes.table_row.create(null, [schema.nodes.table_header.create(null, paragraph('Heading'))]),
  schema.nodes.table_row.create(null, [schema.nodes.table_cell.create(null, paragraph('cell'))])
]))
let from
original.descendants((node, pos) => { if (node.isText && node.text === 'cell') from = pos })
assert.equal(typeof from, 'number')
let state = EditorState.create({ doc: original, plugins: [history()] })
state = state.apply(state.tr.insertText('edited', from, from + 4))
assert.equal(state.doc.textContent, 'Headingedited')
assert.equal(undo(state, tr => { state = state.apply(tr) }), true)
assert.ok(state.doc.eq(original))
console.log('PASS: actual ProseMirror table-cell transaction and history; no Markdown serializer exercised.')
