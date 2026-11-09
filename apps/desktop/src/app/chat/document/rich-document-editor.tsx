import './rich-document-editor.css'

import {
  baseKeymap,
  chainCommands,
  createParagraphNear,
  lift,
  liftEmptyBlock,
  newlineInCode,
  setBlockType,
  splitBlock,
  toggleMark,
  wrapIn
} from 'prosemirror-commands'
import { keymap } from 'prosemirror-keymap'
import { Slice } from 'prosemirror-model'
import { liftListItem, sinkListItem, splitListItem, wrapInList } from 'prosemirror-schema-list'
import { type Command, EditorState, Selection, TextSelection, type Transaction } from 'prosemirror-state'
import {
  addColumnAfter,
  addRowAfter,
  deleteColumn,
  deleteRow,
  goToNextCell,
  isInTable,
  tableEditing
} from 'prosemirror-tables'
import { Decoration, DecorationSet, EditorView } from 'prosemirror-view'
import { type CSSProperties, type RefObject, useEffect, useRef, useState } from 'react'

import { documentPageStyle } from '@/components/chat/document-canvas'
import type { ActiveFormats } from '@/components/chat/markdown-commands'
import { MARKDOWN_TOOLBAR_KEYBINDS } from '@/components/chat/markdown-toolbar'
import { comboFromEvent } from '@/lib/keybinds/combo'

import type { ResolvedDocumentTheme } from '../../../../shared/atum-office/document-theme'

import type {
  DocumentEditorController,
  DocumentSelection,
  RichDocumentCommand,
  RichDocumentEditorApi
} from './document-editor-controller'
import { parseRichDocumentClipboard } from './rich-document-clipboard'
import { nextDocumentMatch, richDocumentMatches } from './rich-document-search'
import { isSafeRichHref, type ParsedRichMarkdown, parseRichMarkdown, RICH_MARKDOWN_LIMITS, richMarkdownSchema } from './rich-markdown-model'
import { prepareRichTransaction, sourcePositionToRich } from './rich-markdown-transactions'

export type { RichDocumentCommand, RichDocumentEditorApi } from './document-editor-controller'

type RichEditKind = 'typing' | 'format' | 'paste' | 'structure'

interface CompositionBase {
  parsed: ParsedRichMarkdown
  source: string
  state: EditorState
}

export interface RichDocumentEditorLabels {
  editor: string
  refused: string
}

export interface RichDocumentEditorProps {
  apiRef?: RefObject<RichDocumentEditorApi | null>
  controller: DocumentEditorController
  enabled: boolean
  initialValue: string
  labels: RichDocumentEditorLabels
  onCompositionChange?: (composing: boolean) => void
  onEligibility?: (eligible: boolean) => void
  onFormatsChange?: (formats: ActiveFormats) => void
  onLinkRequest?: () => void
  /** Exact source mapping is intentionally nullable. The parent clears its
   * source-context chip rather than inventing an offset for Markdown syntax. */
  onUnmappedSelection?: () => void
  onPasteFeedback?: (feedback: 'refused' | 'simplified' | null, canPastePlain?: boolean) => void
  onRefused?: (reason: string) => void
  onSave?: () => void
  onTableSelection?: (inTable: boolean) => void
  theme: ResolvedDocumentTheme
  zoom: number | 'fit'
}

function clamp(value: number, max: number): number {
  return Math.max(0, Math.min(value, max))
}

function selectionForSource(parsed: ParsedRichMarkdown, selection: DocumentSelection): Selection {
  if (parsed.doc.content.size === 0) {
    return Selection.atStart(parsed.doc)
  }

  const from = sourcePositionToRich(parsed, selection.from)
  const to = sourcePositionToRich(parsed, selection.to)

  try {
    return TextSelection.create(parsed.doc, clamp(from, parsed.doc.content.size), clamp(to, parsed.doc.content.size))
  } catch {
    return Selection.atStart(parsed.doc)
  }
}

function kindFor(transaction: Transaction): RichEditKind {
  const explicit = transaction.getMeta('rich-document-kind')

  if (explicit === 'format' || explicit === 'paste' || explicit === 'structure') {
    return explicit
  }

  return transaction.getMeta('uiEvent') === 'paste' ? 'paste' : 'typing'
}

function insertTable(state: EditorState, dispatch?: (transaction: Transaction) => void): boolean {
  const { table, table_cell, table_header, table_row, paragraph } = richMarkdownSchema.nodes
  const emptyParagraph = paragraph?.create()

  if (!table || !table_cell || !table_header || !table_row || !emptyParagraph) {
    return false
  }

  const header = table_header.createAndFill(null, emptyParagraph)
  const cell = table_cell.createAndFill(null, emptyParagraph)

  if (!header || !cell) {
    return false
  }

  // PM nodes are immutable. Reusing these complete cells preserves their
  // required paragraph content; `copy()` without a content argument does not.
  const firstRow = table_row.createAndFill(null, [header, header])
  const secondRow = table_row.createAndFill(null, [cell, cell])

  if (!firstRow || !secondRow) {
    return false
  }

  const node = table.createAndFill(null, [firstRow, secondRow])

  if (!node) {
    return false
  }

  dispatch?.(state.tr.replaceSelectionWith(node).scrollIntoView())

  return true
}

function ancestor(state: EditorState, name: string): boolean {
  for (let depth = state.selection.$from.depth; depth >= 0; depth -= 1) {
    if (state.selection.$from.node(depth).type.name === name) {
      return true
    }
  }

  return false
}

function currentCommand(command: RichDocumentCommand, value?: number | string): Command {
  const nodes = richMarkdownSchema.nodes

  switch (command) {
    case 'bold':
      return toggleMark(richMarkdownSchema.marks.strong!)

    case 'italic':
      return toggleMark(richMarkdownSchema.marks.emphasis!)

    case 'strike':
      return toggleMark(richMarkdownSchema.marks.strike!)
    case 'heading': {
      const level = typeof value === 'number' ? value : 1

      if (level === 0) {
        return setBlockType(nodes.paragraph!)
      }

      return level >= 1 && level <= 6 ? setBlockType(nodes.heading!, { level }) : () => false
    }

    case 'bullet':
      return (state, dispatch) =>
        ancestor(state, 'bullet_list')
          ? liftListItem(nodes.list_item!)(state, dispatch)
          : wrapInList(nodes.bullet_list!)(state, dispatch)

    case 'numbered':
      return (state, dispatch) =>
        ancestor(state, 'ordered_list')
          ? liftListItem(nodes.list_item!)(state, dispatch)
          : wrapInList(nodes.ordered_list!)(state, dispatch)

    case 'quote':
      return (state, dispatch) =>
        ancestor(state, 'blockquote') ? lift(state, dispatch) : wrapIn(nodes.blockquote!)(state, dispatch)

    case 'code':
      return (state, dispatch) =>
        ancestor(state, 'code_block')
          ? setBlockType(nodes.paragraph!)(state, dispatch)
          : setBlockType(nodes.code_block!)(state, dispatch)

    case 'link':
      return typeof value === 'string' && isSafeRichHref(value)
        ? toggleMark(richMarkdownSchema.marks.link!, { href: value })
        : () => false

    case 'table':
      return insertTable

    case 'rowAfter':
      return addRowAfter

    case 'columnAfter':
      return addColumnAfter

    case 'deleteRow':
      return deleteRow

    case 'deleteColumn':
      return deleteColumn
  }
}

function newState(
  parsed: ParsedRichMarkdown,
  selection: DocumentSelection,
  plugins: ReturnType<typeof keymap>[]
): EditorState {
  return EditorState.create({ doc: parsed.doc, plugins, selection: selectionForSource(parsed, selection) })
}

function formatsForState(state: EditorState): ActiveFormats {
  const marks = state.storedMarks ?? state.selection.$from.marks()

  const hasMark = (name: string) => {
    const mark = richMarkdownSchema.marks[name]!

    return state.selection.empty
      ? marks.some(item => item.type === mark)
      : state.doc.rangeHasMark(state.selection.from, state.selection.to, mark)
  }

  let heading: ActiveFormats['heading'] = 0
  let list = false
  let orderedList = false
  let quote = false
  let codeBlock = false

  for (let depth = state.selection.$from.depth; depth >= 0; depth -= 1) {
    const node = state.selection.$from.node(depth)

    if (node.type.name === 'heading') {
      heading = Number(node.attrs.level) as ActiveFormats['heading']
    }

    if (node.type.name === 'bullet_list') {
      list = true
    }

    if (node.type.name === 'ordered_list') {
      orderedList = true
    }

    if (node.type.name === 'blockquote') {
      quote = true
    }

    if (node.type.name === 'code_block') {
      codeBlock = true
    }
  }

  return {
    code: false,
    codeBlock,
    emphasis: hasMark('emphasis'),
    heading,
    link: hasMark('link'),
    list,
    orderedList,
    quote,
    strikethrough: hasMark('strike'),
    strong: hasMark('strong')
  }
}

/**
 * A ProseMirror projection of the canonical Markdown buffer. There is no PM
 * history plugin: controller.commit owns atomic source/history writes, and a
 * rejected source patch never reaches this view.
 */
export function RichDocumentEditor({
  apiRef,
  controller,
  enabled,
  initialValue,
  labels,
  onCompositionChange,
  onEligibility,
  onFormatsChange,
  onLinkRequest,
  onPasteFeedback,
  onRefused,
  onSave,
  onTableSelection,
  onUnmappedSelection,
  theme,
  zoom
}: RichDocumentEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const parsedRef = useRef<ParsedRichMarkdown | null>(null)
  const [eligible, setEligible] = useState(false)
  const enabledRef = useRef(enabled)
  const eligibleRef = useRef(false)
  const compositionRef = useRef<CompositionBase | null>(null)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const searchQueryRef = useRef('')
  const pendingPasteRef = useRef<{ text: string; source: string; state: EditorState } | null>(null)
  const commitSourceRef = useRef<string | null>(null)
  const controllerRef = useRef(controller)

  const callbacksRef = useRef({
    onCompositionChange,
    onEligibility,
    onFormatsChange,
    onLinkRequest,
    onPasteFeedback,
    onRefused,
    onSave,
    onTableSelection,
    onUnmappedSelection
  })

  enabledRef.current = enabled
  controllerRef.current = controller
  callbacksRef.current = {
    onCompositionChange,
    onEligibility,
    onFormatsChange,
    onLinkRequest,
    onPasteFeedback,
    onRefused,
    onSave,
    onTableSelection,
    onUnmappedSelection
  }

  const setEligibility = (eligible: boolean) => {
    eligibleRef.current = eligible
    setEligible(eligible)
    callbacksRef.current.onEligibility?.(eligible)
    viewRef.current?.setProps({ editable: () => enabledRef.current && eligibleRef.current })
  }

  const reportRefusal = (reason: string) => callbacksRef.current.onRefused?.(reason)

  const publishSelection = (selection: DocumentSelection | null) => {
    if (selection) {
      commitSourceRef.current = parsedRef.current?.source ?? null
      controllerRef.current.select(selection)
      commitSourceRef.current = null
    } else {
      callbacksRef.current.onUnmappedSelection?.()
    }
  }

  const publishEditorState = (state: EditorState) => {
    if (pendingPasteRef.current && pendingPasteRef.current.state !== state) {
      pendingPasteRef.current = null
      callbacksRef.current.onPasteFeedback?.(null)
    }

    callbacksRef.current.onFormatsChange?.(formatsForState(state))
    callbacksRef.current.onTableSelection?.(isInTable(state))
  }

  // `prepared.state` deliberately does not retain the original transaction;
  // the host supplies this small wrapper so command kind remains explicit.
  const dispatchPrepared = (
    view: EditorView,
    transaction: Transaction,
    transactionState = view.state,
    before = parsedRef.current
  ): boolean => {
    if (!before || !enabledRef.current || !eligibleRef.current) {
      return false
    }

    if (compositionRef.current) {
      const tentative = view.state.applyTransaction(transaction).state
      view.updateState(tentative)
      publishEditorState(tentative)

      return true
    }

    const prepared = prepareRichTransaction(before, transactionState, transaction)

    if (prepared.kind === 'refused') {
      reportRefusal(prepared.reason)

      return false
    }

    if (prepared.patch) {
      const nextSource = prepared.parsed.source

      const commitSelection = prepared.selection ?? {
        from: prepared.patch.from + prepared.patch.insert.length,
        to: prepared.patch.from + prepared.patch.insert.length
      }

      commitSourceRef.current = nextSource

      const committed = controllerRef.current.commit({
        expectedSource: before.source,
        kind: kindFor(transaction),
        patch: prepared.patch,
        selection: commitSelection
      })

      commitSourceRef.current = null

      if (!committed) {
        reportRefusal('document changed before this edit could be saved')

        return false
      }
    }

    parsedRef.current = prepared.parsed
    view.updateState(prepared.state)
    publishEditorState(prepared.state)
    publishSelection(prepared.selection)

    return true
  }

  const canNavigate = (view: EditorView | null): view is EditorView =>
    Boolean(view && enabledRef.current && eligibleRef.current && !compositionRef.current && !view.composing)

  // PM's default scrollIntoView ignores a DOM selection outside the editor.
  // Find deliberately keeps focus in its input, so scroll only our viewport
  // using the active model position, without focusing or scrolling the shell.
  const revealPosition = (view: EditorView, position: number) => {
    const viewport = viewportRef.current

    if (!viewport) { return }
    const bounds = viewport.getBoundingClientRect()
    const target = view.coordsAtPos(position)
    const inset = 12

    if (target.top < bounds.top + inset) { viewport.scrollTop += target.top - bounds.top - inset }
    else if (target.bottom > bounds.bottom - inset) { viewport.scrollTop += target.bottom - bounds.bottom + inset }

    if (target.left < bounds.left + inset) { viewport.scrollLeft += target.left - bounds.left - inset }
    else if (target.right > bounds.right - inset) { viewport.scrollLeft += target.right - bounds.right + inset }
  }

  const searchStatus = (view: EditorView, query: string) => {
    const matches = richDocumentMatches(view.state.doc, query)

    return { current: matches.findIndex(match => match.from === view.state.selection.from && match.to === view.state.selection.to) + 1, total: matches.length }
  }

  const finishComposition = () => {
    const base = compositionRef.current
    const view = viewRef.current
    compositionRef.current = null
    callbacksRef.current.onCompositionChange?.(false)

    if (!base || !view) {
      return
    }

    if (controllerRef.current.getSource() !== base.source) {
      view.updateState(base.state)
      reportRefusal('document changed while text composition was active')

      return
    }

    const replacement = base.state.tr
      .replace(0, base.state.doc.content.size, new Slice(view.state.doc.content, 0, 0))
      .setMeta('rich-document-kind', 'typing')

    const from = clamp(view.state.selection.from, replacement.doc.content.size)
    const to = clamp(view.state.selection.to, replacement.doc.content.size)
    replacement.setSelection(TextSelection.create(replacement.doc, from, to))

    if (!dispatchPrepared(view, replacement, base.state, base.parsed)) {
      // An IME branch is never a published source revision. If its final
      // source patch cannot pass the gate, return to its saved base exactly.
      view.updateState(base.state)
      publishEditorState(base.state)
    }
  }

  useEffect(() => {
    const host = hostRef.current

    if (!host) {
      return
    }

    const parsed = parseRichMarkdown(initialValue)
    const initialSelection = { from: 0, to: 0 }
    const dispatchUndo = () => !canNavigate(viewRef.current) || controllerRef.current.undo()
    const dispatchRedo = () => !canNavigate(viewRef.current) || controllerRef.current.redo()

    const run =
      (command: Command, kind: RichEditKind) => (state: EditorState, dispatch?: (transaction: Transaction) => void) =>
        !canNavigate(viewRef.current) || command(state, transaction => dispatch?.(transaction.setMeta('rich-document-kind', kind)))

    const plugins = [
      keymap({
        'Mod-b': run(currentCommand('bold'), 'format'),
        'Mod-i': run(currentCommand('italic'), 'format'),
        'Mod-k': () => {
          if (!canNavigate(viewRef.current)) { return true }
          callbacksRef.current.onLinkRequest?.()

          return Boolean(callbacksRef.current.onLinkRequest)
        },
        'Mod-Shift-x': run(currentCommand('strike'), 'format'),
        'Mod-s': () => {
          if (!canNavigate(viewRef.current)) { return true }
          callbacksRef.current.onSave?.()

          return true
        },
        'Mod-y': dispatchRedo,
        'Mod-z': dispatchUndo,
        'Mod-Shift-z': dispatchRedo,
        Enter: chainCommands(
          splitListItem(richMarkdownSchema.nodes.list_item!),
          newlineInCode,
          createParagraphNear,
          liftEmptyBlock,
          splitBlock
        ),
        'Shift-Tab': chainCommands(liftListItem(richMarkdownSchema.nodes.list_item!), goToNextCell(-1)),
        Tab: chainCommands(sinkListItem(richMarkdownSchema.nodes.list_item!), goToNextCell(1))
      }),
      keymap(baseKeymap),
      tableEditing()
    ]

    const blank = richMarkdownSchema.topNodeType.createAndFill()!

    const state =
      parsed.kind === 'parsed'
        ? newState(parsed, initialSelection, plugins)
        : EditorState.create({ doc: blank, plugins })

    if (parsed.kind === 'parsed') {
      parsedRef.current = parsed
      setEligibility(true)
    } else {
      parsedRef.current = null
      setEligibility(false)
      reportRefusal(parsed.reason)
    }

    let pasteWithoutFormatting = false

    const view = new EditorView(host, {
      decorations: state => {
        if (compositionRef.current || viewRef.current?.composing) { return DecorationSet.empty }
        const matches = richDocumentMatches(state.doc, searchQueryRef.current)
        const current = matches.find(match => match.from === state.selection.from && match.to === state.selection.to)
        // Keep broad, short queries from creating thousands of DOM wrappers.
        const visible = matches.slice(0, 500)

        if (current && !visible.includes(current)) { visible.push(current) }

        return DecorationSet.create(state.doc, visible.map(match => Decoration.inline(match.from, match.to, {
          class: match === current ? 'document-search-match document-search-current' : 'document-search-match'
        })))
      },
      attributes: { role: 'textbox', 'aria-label': labels.editor, 'aria-multiline': 'true', spellcheck: 'true' },
      dispatchTransaction: transaction => {
        const accepted = dispatchPrepared(view, transaction)

        if (kindFor(transaction) === 'paste' && !accepted) {
          callbacksRef.current.onPasteFeedback?.('refused')
        }
      },
      handleDOMEvents: {
        blur: () => {
          pasteWithoutFormatting = false

          return false
        },
        keydown: (active, event) => {
          // PM skips its keymaps during composition. Consume owned commands at
          // the DOM boundary too, before native contenteditable editing runs.
          if (!canNavigate(active) && ['mod+b', 'mod+i', 'mod+shift+x', 'mod+k', 'mod+s', 'mod+z', 'mod+shift+z', 'mod+y'].includes(comboFromEvent(event) ?? '')) {
            event.preventDefault()

            return true
          }

          pasteWithoutFormatting = (event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'v'

          return false
        },
        keyup: () => {
          pasteWithoutFormatting = false

          return false
        },
        drop: (active, event) => {
          // Internal PM drags carry an already validated schema slice. External
          // HTML must not enter PM's live-document clipboard parser via drop.
          if (!active.dragging && event.dataTransfer?.getData('text/html')) {
            event.preventDefault()
            pendingPasteRef.current = null
            callbacksRef.current.onPasteFeedback?.('refused')

            return true
          }

          return false
        },
        paste: (active, event) => {
          // Intercept before PM parses HTML: untrusted clipboard elements must
          // never reach a live DOM, including transient browser paste capture.
          event.preventDefault()
          pendingPasteRef.current = null
          const plain = pasteWithoutFormatting || active.state.selection.$from.parent.type.spec.code
          pasteWithoutFormatting = false

          if (!enabledRef.current || !eligibleRef.current || compositionRef.current || active.composing) {
            callbacksRef.current.onPasteFeedback?.('refused')

            return true
          }

          const data = event.clipboardData
          const text = data?.getData('text/plain') ?? ''
          const html = data?.getData('text/html') ?? ''

          if (!data || (data.files.length > 0 && !html && !plain) || text.length > RICH_MARKDOWN_LIMITS.maxDocLength) {
            callbacksRef.current.onPasteFeedback?.('refused')

            return true
          }

          callbacksRef.current.onPasteFeedback?.(null)

          if (plain || !html) {
            if (text) {
              // This public PM entry receives only text, keeps code-block and
              // destination-mark semantics, and uses our canonical dispatcher.
              active.pasteText(text, event)
            }

            return true
          }

          const refuseHtml = () => {
            if (text) {
              // Keep only the text from this user paste, in memory, bound to
              // this exact source and selection. No later clipboard reads.
              pendingPasteRef.current = { text, source: controllerRef.current.getSource(), state: active.state }
            }

            callbacksRef.current.onPasteFeedback?.('refused', Boolean(text))
          }

          const clipboard = parseRichDocumentClipboard(html)

          if (clipboard.kind === 'refused') {
            refuseHtml()

            return true
          }

          if (clipboard.slice.size === 0) {
            return true
          }

          const transaction = active.state.tr
            .replaceSelection(clipboard.slice)
            .setMeta('paste', true)
            .setMeta('uiEvent', 'paste')
            .setMeta('rich-document-kind', 'paste')
            .scrollIntoView()

          if (!dispatchPrepared(active, transaction)) {
            refuseHtml()
          } else if (clipboard.simplified) {
            callbacksRef.current.onPasteFeedback?.('simplified')
          }

          return true
        },
        compositionend: () => {
          queueMicrotask(finishComposition)

          return false
        },
        compositionstart: () => {
          if (!compositionRef.current && parsedRef.current) {
            compositionRef.current = {
              parsed: parsedRef.current,
              source: controllerRef.current.getSource(),
              state: view.state
            }
            // Remove highlights before the first IME DOM update; no decoration
            // wrappers are recomputed over the composing text node afterward.
            view.updateState(view.state)
            callbacksRef.current.onCompositionChange?.(true)
          }

          return false
        }
      },
      state,
      editable: () => enabledRef.current && eligibleRef.current
    })

    viewRef.current = view
    view.setProps({ editable: () => enabledRef.current && eligibleRef.current })
    publishEditorState(view.state)

    const publishLocalKeybinds = () => {
      host.dataset.localKeybinds = [...MARKDOWN_TOOLBAR_KEYBINDS, 'mod+f'].join(' ')
    }

    const clearLocalKeybinds = (event: FocusEvent) => {
      if (!host.contains(event.relatedTarget as Node | null)) {
        delete host.dataset.localKeybinds
      }
    }

    host.addEventListener('focusin', publishLocalKeybinds)
    host.addEventListener('focusout', clearLocalKeybinds)

    if (apiRef) {
      apiRef.current = {
        command: (command, value) => {
          const active = viewRef.current

          if (!canNavigate(active)) {
            return false
          }

          let accepted = true

          const handled = currentCommand(command, value)(active.state, transaction => {
            accepted = dispatchPrepared(
              active,
              transaction.setMeta(
                'rich-document-kind',
                command === 'table' || /After|delete/u.test(command) ? 'structure' : 'format'
              )
            )
          })

          return handled && accepted
        },
        getOutline: () => {
          const headings: { from: number; title: string; level: number }[] = []
          viewRef.current?.state.doc.descendants((node, pos) => {
            if (node.type.name === 'heading') {
              headings.push({ from: pos, title: node.textContent, level: Number(node.attrs.level) })
            }
          })

          return headings
        },
        navigateToHeading: position => {
          const active = viewRef.current

          if (!canNavigate(active) || !Number.isInteger(position) || position < 0 || position >= active.state.doc.content.size || active.state.doc.nodeAt(position)?.type.name !== 'heading') { return false }
          const selection = Selection.near(active.state.doc.resolve(position + 1))

          const accepted = dispatchPrepared(active, active.state.tr.setSelection(selection))

          if (accepted) { revealPosition(active, selection.from) }

          return accepted
        },
        setSearchQuery: query => {
          const active = viewRef.current

          if (!active) { return { current: 0, total: 0 } }

          if (canNavigate(active) || !query) {
            searchQueryRef.current = query
            active.updateState(active.state)
          }

          return searchStatus(active, query)
        },
        search: (query, direction) => {
          const active = viewRef.current

          if (!canNavigate(active)) { return { current: 0, total: 0 } }
          searchQueryRef.current = query
          const match = nextDocumentMatch(richDocumentMatches(active.state.doc, query), active.state.selection, direction)

          if (match) {
            if (dispatchPrepared(active, active.state.tr.setSelection(TextSelection.create(active.state.doc, match.from, match.to)))) {
              revealPosition(active, match.from)
            }
          } else {
            active.updateState(active.state)
          }

          return searchStatus(active, query)
        },
        replaceSearchMatch: (query, replacement) => {
          const active = viewRef.current

          if (!canNavigate(active) || !query) { return false }
          const { from, to } = active.state.selection

          if (!richDocumentMatches(active.state.doc, query).some(match => match.from === from && match.to === to)) { return false }

          return dispatchPrepared(active, active.state.tr.insertText(replacement, from, to).setMeta('rich-document-kind', 'structure').scrollIntoView())
        },
        focus: () => { if (canNavigate(viewRef.current)) { viewRef.current.focus() } },
        pasteWithoutFormatting: () => {
          const pending = pendingPasteRef.current
          const active = viewRef.current
          pendingPasteRef.current = null
          callbacksRef.current.onPasteFeedback?.(null)

          if (!pending || !active || !enabledRef.current || !eligibleRef.current || compositionRef.current || active.composing ||
            pending.state !== active.state || pending.source !== controllerRef.current.getSource()) {
            return false
          }

          active.focus()
          active.pasteText(pending.text)

          return active.state.doc !== pending.state.doc
        },
        syncSource: (source, selection) => {
          const active = viewRef.current

          if (!active) {
            return
          }

          // A controller may synchronously publish a change to its observers
          // from commit(). The view will publish that same prepared state before
          // commit returns, so consuming this re-entrant echo would be stale.
          if (commitSourceRef.current === source) {
            return
          }

          if (compositionRef.current) {
            compositionRef.current = null
            callbacksRef.current.onCompositionChange?.(false)
          }

          const replacement = parsedRef.current?.source === source ? parsedRef.current : parseRichMarkdown(source)

          if (replacement.kind === 'refused') {
            parsedRef.current = null
            setEligibility(false)
            active.updateState(EditorState.create({ doc: richMarkdownSchema.topNodeType.createAndFill()!, plugins }))
            reportRefusal(replacement.reason)

            return
          }

          const nextSelection = selectionForSource(replacement, selection)

          if (parsedRef.current?.source === source && active.state.selection.eq(nextSelection)) {
            return
          }

          parsedRef.current = replacement
          setEligibility(true)
          const next = EditorState.create({ doc: replacement.doc, plugins, selection: nextSelection })
          // A replacement is source-owned state. It must not retain a mark
          // armed in the old selection, or typing after a source switch would
          // apply format that source never contained.
          active.updateState(next.apply(next.tr.setStoredMarks(null)))
          publishEditorState(active.state)
        }
      }
    }

    return () => {
      host.removeEventListener('focusin', publishLocalKeybinds)
      host.removeEventListener('focusout', clearLocalKeybinds)
      delete host.dataset.localKeybinds
      view.destroy()
      viewRef.current = null
      parsedRef.current = null
      pendingPasteRef.current = null

      if (apiRef) {
        apiRef.current = null
      }
    }
    // The mounted PM instance persists across enabled/theme/zoom changes and
    // source mode switches. Source authority enters through api.syncSource.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    viewRef.current?.setProps({ editable: () => enabledRef.current && eligibleRef.current })

    if (!enabled) {
      pendingPasteRef.current = null
      callbacksRef.current.onPasteFeedback?.(null)
    }
  }, [enabled])

  const scale = zoom === 'fit' ? 1 : zoom / 100

  const style = {
    ...documentPageStyle(theme, zoom),
    '--document-accent': `#${theme.accentHex}`,
    '--document-heading-font': theme.headingFont.css,
    ...Object.fromEntries(theme.headingSizesPt.map((size, index) => [`--document-h${index + 1}`, `${size * scale}pt`]))
  } as CSSProperties

  return (
    <div aria-label={labels.editor} className="atum-rich-document-editor h-full overflow-auto px-3 pt-5 pb-10" ref={viewportRef}>
      <div className="atum-rich-document-sheet" data-unavailable={!eligible || undefined} style={style}>
        <div ref={hostRef} />
        {!eligible ? (
          <p className="atum-rich-document-refused" role="status">
            {labels.refused}
          </p>
        ) : null}
      </div>
    </div>
  )
}
