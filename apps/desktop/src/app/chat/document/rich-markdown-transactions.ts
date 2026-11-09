import type { Node as ProseMirrorNode } from 'prosemirror-model'
import type { EditorState, Transaction } from 'prosemirror-state'

import type { DocumentSelection, DocumentSourcePatch } from './document-editor-controller'
import { parseRichMarkdown, RICH_MARKDOWN_LIMITS, serializeRichBlocks } from './rich-markdown-model'

export type ParsedRichMarkdown = Extract<ReturnType<typeof parseRichMarkdown>, { kind: 'parsed' }>

export interface PreparedRichEdit {
  kind: 'accepted'
  parsed: ParsedRichMarkdown
  patch: DocumentSourcePatch | null
  state: EditorState
  selection: DocumentSelection | null
}

function children(doc: ProseMirrorNode): ProseMirrorNode[] {
  const result: ProseMirrorNode[] = []
  doc.forEach(node => result.push(node))

  return result
}

function apply(source: string, patch: DocumentSourcePatch): string {
  return source.slice(0, patch.from) + patch.insert + source.slice(patch.to)
}

/** Only exact leaf mappings may publish an assistant selection. Delimiters,
 * decoded escapes and other unrepresented source positions are not guessed. */
export function richSelectionToSource(parsed: ParsedRichMarkdown, from: number, to: number): DocumentSelection | null {
  const start =
    parsed.textRanges.find(
      range => from >= range.pos && (from < range.pos + range.text.length || (!range.text.length && from === range.pos))
    ) ?? parsed.textRanges.find(range => from === range.pos + range.text.length)

  const end =
    from === to ? start : parsed.textRanges.find(range => to > range.pos && to <= range.pos + range.text.length)

  if (!start || !end) {
    return null
  }

  return { from: start.from + from - start.pos, to: end.from + to - end.pos }
}

/** Source navigation lands at a nearby rich caret when it names syntax (for
 * example an outline heading marker). Selected assistant context still uses
 * the exact, separately checked mapping above. */
export function sourcePositionToRich(parsed: ParsedRichMarkdown, offset: number): number {
  let nearest = 1
  let distance = Number.POSITIVE_INFINITY

  for (const range of parsed.textRanges) {
    const clamped = Math.max(range.from, Math.min(offset, range.to))
    const delta = Math.abs(offset - clamped)

    if (delta < distance) {
      distance = delta
      nearest = range.pos + clamped - range.from
    }
  }

  return Math.max(0, Math.min(nearest, parsed.doc.content.size))
}

function plainTextPatch(before: ParsedRichMarkdown, after: ProseMirrorNode): DocumentSourcePatch | null {
  const from = before.doc.content.findDiffStart(after.content)
  const ends = before.doc.content.findDiffEnd(after.content)

  if (from === null || !ends) {
    return null
  }

  // findDiffEnd can overlap findDiffStart for insertions of repeated text.
  const overlap = Math.max(0, from - Math.min(ends.a, ends.b))
  const oldTo = ends.a + overlap
  const newTo = ends.b + overlap
  const range = before.textRanges.find(item => from >= item.pos && oldTo <= item.pos + item.text.length)

  if (!range) {
    return null
  }

  const slice = after.slice(from, newTo)

  if (slice.openStart || slice.openEnd) {
    return null
  }

  let text = ''
  let onlyText = true
  slice.content.forEach(node => {
    if (!node.isText) {
      onlyText = false
    }

    text += node.text ?? ''
  })

  if (!onlyText) {
    return null
  }

  return { from: range.from + from - range.pos, to: range.from + oldTo - range.pos, insert: text }
}

function blockPatch(before: ParsedRichMarkdown, after: ProseMirrorNode): DocumentSourcePatch | null {
  const oldNodes = children(before.doc)
  const newNodes = children(after)
  let prefix = 0

  while (prefix < oldNodes.length && prefix < newNodes.length && oldNodes[prefix]!.eq(newNodes[prefix]!)) {
    prefix++
  }

  let suffix = 0

  while (
    suffix < oldNodes.length - prefix &&
    suffix < newNodes.length - prefix &&
    oldNodes[oldNodes.length - suffix - 1]!.eq(newNodes[newNodes.length - suffix - 1]!)
  ) {
    suffix++
  }

  if (prefix === oldNodes.length && prefix === newNodes.length) {
    return null
  }

  const end = oldNodes.length - suffix
  const changed = newNodes.slice(prefix, newNodes.length - suffix)
  const newline = before.source.includes('\r\n') ? '\r\n' : '\n'
  let insert = serializeRichBlocks(changed, newline)
  let from = before.blocks[prefix]?.from ?? before.source.length
  let to = end > prefix ? (before.blocks[end - 1]?.to ?? from) : from

  if (end === prefix) {
    // Inserting a block between preserved neighbors needs its own separator.
    if (suffix) {
      insert += newline + newline
    } else if (prefix) {
      insert = newline + newline + insert
    }
  } else if (changed.length === 0) {
    // Remove one neighboring separator with a removed block; leaving it behind
    // would introduce an unintended empty paragraph on reparse.
    if (suffix) {
      to = before.blocks[end]?.from ?? to
    } else if (prefix) {
      from = before.blocks[prefix - 1]!.to
    }
  }

  return { from, to, insert }
}

function parseTextPatch(
  before: ParsedRichMarkdown,
  after: ProseMirrorNode,
  patch: DocumentSourcePatch
): ParsedRichMarkdown | null {
  // A source-identical leaf edit without a newline cannot change another
  // independent top-level block. Still reparse its complete containing block,
  // and compare all rich nodes; syntax/structural edits take the full path.
  if (
    /[\r\n]/u.test(patch.insert + before.source.slice(patch.from, patch.to)) ||
    before.doc.childCount !== after.childCount
  ) {
    return null
  }

  const diff = before.doc.content.findDiffStart(after.content)

  if (diff === null) {
    return null
  }

  const index = before.blocks.findIndex(block => diff >= block.pos && diff < block.pos + block.node.nodeSize)
  const block = before.blocks[index]

  if (
    !block ||
    block.from === block.to ||
    patch.from < block.from ||
    patch.to > block.to ||
    (block.from > 0 && before.source[block.from - 1] !== '\n')
  ) {
    return null
  }

  const blockSource =
    before.source.slice(block.from, patch.from) + patch.insert + before.source.slice(patch.to, block.to)

  const local = parseRichMarkdown(blockSource)

  if (local.kind !== 'parsed' || local.blocks.length !== 1 || !local.doc.child(0).eq(after.child(index))) {
    return null
  }

  for (let at = 0; at < before.doc.childCount; at++) {
    if (at !== index && !before.doc.child(at).eq(after.child(at))) {
      return null
    }
  }

  const source = apply(before.source, patch)
  const sourceDelta = patch.insert.length - (patch.to - patch.from)
  const positionDelta = after.child(index).nodeSize - block.node.nodeSize

  const blocks = before.blocks.map((item, at) =>
    at === index
      ? {
          ...local.blocks[0]!,
          from: block.from + local.blocks[0]!.from,
          to: block.from + local.blocks[0]!.to,
          pos: block.pos
        }
      : at < index
        ? item
        : { ...item, from: item.from + sourceDelta, to: item.to + sourceDelta, pos: item.pos + positionDelta }
  )

  const textRanges = [
    ...before.textRanges.filter(item => item.pos < block.pos),
    ...local.textRanges.map(item => ({
      ...item,
      from: item.from + block.from,
      to: item.to + block.from,
      pos: item.pos + block.pos
    })),
    ...before.textRanges
      .filter(item => item.pos >= block.pos + block.node.nodeSize)
      .map(item => ({
        ...item,
        from: item.from + sourceDelta,
        to: item.to + sourceDelta,
        pos: item.pos + positionDelta
      }))
  ]

  return { kind: 'parsed', source, doc: after.type.create({ markdown: source }, after.content), blocks, textRanges }
}

/** Speculate in an immutable EditorState, validate the complete plugin result,
 * then let the source controller commit once. Nothing is published on failure. */
export function prepareRichTransaction(
  before: ParsedRichMarkdown,
  state: EditorState,
  transaction: Transaction
): PreparedRichEdit | { kind: 'refused'; reason: string } {
  try {
    if (!transaction.before.eq(state.doc) || !before.doc.content.eq(state.doc.content)) {
      return { kind: 'refused', reason: 'stale transaction' }
    }

    const next = state.applyTransaction(transaction).state

    if (next.doc.content.eq(before.doc.content)) {
      return {
        kind: 'accepted',
        parsed: before,
        patch: null,
        state: next,
        selection: richSelectionToSource(before, next.selection.from, next.selection.to)
      }
    }

    for (const strategy of [plainTextPatch, blockPatch]) {
      const patch = strategy(before, next.doc)

      if (
        !patch ||
        before.source.length - (patch.to - patch.from) + patch.insert.length > RICH_MARKDOWN_LIMITS.maxDocLength
      ) {
        continue
      }

      const parsed =
        (strategy === plainTextPatch && parseTextPatch(before, next.doc, patch)) ||
        parseRichMarkdown(apply(before.source, patch))

      if (parsed.kind !== 'parsed' || !parsed.doc.content.eq(next.doc.content)) {
        continue
      }

      return {
        kind: 'accepted',
        parsed,
        patch,
        state: next,
        selection: richSelectionToSource(parsed, next.selection.from, next.selection.to)
      }
    }

    return { kind: 'refused', reason: 'edit cannot be represented without changing document meaning' }
  } catch {
    return { kind: 'refused', reason: 'unsupported rich transaction' }
  }
}
