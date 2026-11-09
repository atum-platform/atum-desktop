import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { bracketMatching, indentOnInput, LanguageDescription } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import {
  type Command,
  Decoration,
  drawSelection,
  EditorView,
  type KeyBinding,
  keymap,
  lineNumbers
} from '@codemirror/view'
import { type RefObject, useEffect, useRef } from 'react'

import { tryFormatJson } from '@/lib/json-format'
import { cn } from '@/lib/utils'

import { githubEditorTheme } from './code-editor-theme'

type FormatOutcome = { ok: true } | { ok: false; error: string }

function applyFormatJson(view: EditorView, onError?: (error: string) => void): FormatOutcome {
  const text = view.state.doc.toString()
  const result = tryFormatJson(text)

  if (!result.ok) {
    onError?.(result.error)

    return result
  }

  if (result.text !== text) {
    view.dispatch({ changes: { from: 0, insert: result.text, to: view.state.doc.length } })
  }

  return { ok: true }
}

/** Imperative surface for callers that drive selection from outside (e.g. a
 *  config list focusing its block in the document). */
export interface CodeEditorApi {
  dispatchCommand: (command: Command) => boolean
  focus: () => void
  formatJson: () => FormatOutcome
  getDoc: () => string
  getVisibleText?: () => string
  getSelection: () => { from: number; to: number }
  getState: () => EditorState | null
  setCursor: (pos: number) => void
}

export interface CodeEditorSelection {
  documentText: string
  from: number
  to: number
}

export interface CodeEditorSurfaceProps {
  apiRef?: RefObject<CodeEditorApi | null>
  className?: string
  /** Read-only: block edits (e.g. while a save is in flight) without unmounting. */
  disabled?: boolean
  /** A projection owns input while this mounted source buffer keeps history. */
  inputDisabled?: boolean
  /** Documents retain CRLF bytes/offsets; source-code editors keep their defaults. */
  preserveLineEndings?: boolean
  /** Mod-Shift-F + `apiRef.formatJson()`. In-memory JSON docs only. */
  formatJson?: boolean
  /**
   * Standalone chrome: rounded border on an outer shell. The CodeMirror surface
   * inside is identical to pane previews (no extra inset). Off by default.
   */
  /** Mount-time only: it chooses the host DOM. Never toggle it on a mounted editor — swap `presentation` instead. */
  framed?: boolean
  filePath: string
  /** Character range to wash with a subtle background (the "you are here" block). */
  highlight?: null | { from: number; to: number }
  // Read once at mount. To load a different file or discard edits, remount the
  // component (give it a new React `key`) rather than pushing a new value in.
  initialValue: string
  /** Markdown support loaded synchronously and retained across runtime changes. */
  liveMarkdown?: boolean
  /** Key bindings that take precedence over the editor's base keymap (reconfigurable at runtime). */
  extraKeymap?: KeyBinding[]
  /** Presentation extensions (decorations, themes) swapped at runtime without touching the document. */
  presentation?: Extension
  /** Canonical shell chords owned by this editor while it has focus. */
  localKeybinds?: string[]
  onCancel?: () => void
  onChange: (value: string) => void
  onCompositionChange?: (composing: boolean) => void
  /** Button or Mod-Shift-F. */
  onFormatJsonError?: (error: string) => void
  /** Fires with the primary cursor offset whenever the selection moves. */
  onCursorChange?: (pos: number) => void
  onSelectionChange?: (selection: CodeEditorSelection) => void
  onSave?: () => void
  /** The host owns appearance; Matrix cannot import the legacy theme store. */
  resolvedMode: 'dark' | 'light'
}

// Focus treatment for the active range: a subtle wash on its lines, and
// everything OUTSIDE dimmed — the document recedes so the block you're in
// reads as "you are here".
function blockHighlight(range: { from: number; to: number }) {
  return EditorView.decorations.compute([], state => {
    const clamp = (pos: number) => Math.max(0, Math.min(pos, state.doc.length))
    const active = Decoration.line({ class: 'cm-hermes-active-block' })
    // Inline style, not a theme class: theme rules are scoped per-extension
    // and line opacity must never lose that fight.
    const dimmed = Decoration.line({ attributes: { style: 'opacity:0.5;transition:opacity 120ms ease-out' } })
    const first = state.doc.lineAt(clamp(range.from)).number
    const last = state.doc.lineAt(clamp(range.to)).number
    const marks = []

    for (let n = 1; n <= state.doc.lines; n++) {
      marks.push((n >= first && n <= last ? active : dimmed).range(state.doc.line(n).from))
    }

    return Decoration.set(marks)
  })
}

function baseName(filePath: string): string {
  const cleaned = filePath.replace(/[\\/]+$/, '')

  return (
    cleaned
      .slice(cleaned.lastIndexOf('/') + 1)
      .split('\\')
      .pop() ?? cleaned
  )
}

// Mirror SourceView's geometry/typography 1:1 so toggling preview⇄edit never
// shifts the file. CM's base stylesheet targets some of these with two-class
// selectors (e.g. `.cm-lineNumbers .cm-gutterElement`) that out-specify a bare
// `.cm-gutterElement` rule, so we match that specificity to win. SourceView
// reference: font var(--font-mono)/0.7rem/400, 1.25rem rows, gutter w-9 + pr-2
// (muted/55), code 0.625rem line inset.
const MONO_FONT = 'var(--font-mono)'
const ROW_HEIGHT = '1.25rem'
const CODE_SIZE = '0.7rem'
const GUTTER_COLOR = 'color-mix(in oklab, var(--muted-foreground) 55%, transparent)'

const LAYOUT_THEME = EditorView.theme({
  '&': {
    WebkitFontSmoothing: 'antialiased',
    backgroundColor: 'transparent',
    height: '100%'
  },
  // CM's base theme ships `.cm-content { padding: 4px 0 }` (~5px top/bottom).
  // Zero it explicitly so pane + framed interiors match SourceView flush-top.
  '.cm-content': {
    fontFamily: MONO_FONT,
    fontSize: CODE_SIZE,
    fontWeight: '400',
    lineHeight: ROW_HEIGHT,
    padding: '0',
    paddingBottom: '0',
    paddingTop: '0'
  },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    border: 'none',
    color: GUTTER_COLOR,
    fontFamily: MONO_FONT,
    fontSize: CODE_SIZE
  },
  // Two-class selector to beat CM's base `.cm-lineNumbers .cm-gutterElement`.
  '.cm-lineNumbers .cm-gutterElement': {
    boxSizing: 'border-box',
    fontVariantNumeric: 'tabular-nums',
    fontWeight: '400',
    lineHeight: ROW_HEIGHT,
    minWidth: '2.25rem',
    padding: '0 0.5rem 0 0',
    textAlign: 'right'
  },
  '.cm-line': {
    fontFamily: MONO_FONT,
    fontSize: CODE_SIZE,
    fontWeight: '400',
    lineHeight: ROW_HEIGHT,
    padding: '0 0.625rem'
  },
  '.cm-scroller': {
    fontFamily: MONO_FONT,
    fontSize: CODE_SIZE,
    lineHeight: ROW_HEIGHT,
    overflow: 'auto'
  },
  '.cm-hermes-active-block': {
    backgroundColor: 'color-mix(in srgb, var(--dt-foreground) 5%, transparent)'
  }
})

// Framed = prose editing (SOUL.md, skills, memories): no line-number gutter (it
// shoved text right and made the left inset dwarf the top), and zero the line's
// own horizontal padding so the host's uniform `p-2` is the ONLY inset — even
// breathing room on all four sides. Long lines wrap rather than scroll.
const FRAMED_THEME = EditorView.theme({
  '.cm-line': { padding: '0' }
})

// A deliberately small CodeMirror 6 surface for *spot edits* — not an IDE: line
// numbers, history, selection, bracket matching, syntax highlighting. No fold
// gutter, autocomplete, or active-line chrome, so it reads like the preview it
// replaces. It owns its own buffer; the parent tracks dirty via `onChange` and
// resets by remounting. ⌘/Ctrl+S and ⌘/Ctrl+Enter save; Esc cancels; the app's
// light/dark mode is followed live without losing the cursor.
export function CodeEditorSurface({
  apiRef,
  className,
  disabled = false,
  inputDisabled = false,
  preserveLineEndings = false,
  formatJson = false,
  framed = false,
  filePath,
  highlight,
  initialValue,
  liveMarkdown = false,
  localKeybinds = [],
  extraKeymap,
  presentation,
  onCancel,
  onChange,
  onCompositionChange,
  onCursorChange,
  onSelectionChange,
  onFormatJsonError,
  onSave,
  resolvedMode
}: CodeEditorSurfaceProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const languageConf = useRef(new Compartment())
  const presentationConf = useRef(new Compartment())
  const keymapConf = useRef(new Compartment())
  const extraKeymapConf = useRef(new Compartment())
  const themeConf = useRef(new Compartment())
  const highlightConf = useRef(new Compartment())
  const editableConf = useRef(new Compartment())
  const onCancelRef = useRef(onCancel)
  const onChangeRef = useRef(onChange)
  const onCompositionChangeRef = useRef(onCompositionChange)
  const onCursorChangeRef = useRef(onCursorChange)
  const onSelectionChangeRef = useRef(onSelectionChange)
  const onFormatJsonErrorRef = useRef(onFormatJsonError)
  const onSaveRef = useRef(onSave)
  const formatJsonRef = useRef(formatJson)
  const localKeybindsRef = useRef(localKeybinds)
  onCancelRef.current = onCancel
  onChangeRef.current = onChange
  onCompositionChangeRef.current = onCompositionChange
  onCursorChangeRef.current = onCursorChange
  onSelectionChangeRef.current = onSelectionChange
  onFormatJsonErrorRef.current = onFormatJsonError
  onSaveRef.current = onSave
  formatJsonRef.current = formatJson
  localKeybindsRef.current = localKeybinds

  useEffect(() => {
    const host = hostRef.current

    if (!host) {
      return
    }

    const isDark = resolvedMode === 'dark'

    const save = () => {
      onSaveRef.current?.()

      return true
    }

    const runFormatJson = () => {
      if (!formatJsonRef.current || !viewRef.current) {
        return false
      }

      applyFormatJson(viewRef.current, error => onFormatJsonErrorRef.current?.(error))

      return true
    }

    const state = EditorState.create({
      doc: initialValue,
      extensions: [
        // Keep CR as source text rather than dropping it during newline parsing.
        // All canonical offsets then agree with the file, including CRLF files.
        ...(preserveLineEndings ? [EditorState.lineSeparator.of('\n')] : []),
        // Gutter only outside framed mode — framed prose reads better flush.
        ...(framed ? [] : [lineNumbers()]),
        history(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        // Earlier extensions win: the extra keymap (Markdown formatting) must
        // beat the base keymap's defaults for the same chords.
        extraKeymapConf.current.of(extraKeymap ? keymap.of(extraKeymap) : []),
        keymapConf.current.of(
          keymap.of([
            ...defaultKeymap,
            ...historyKeymap,
            indentWithTab,
            { key: 'Mod-s', preventDefault: true, run: save },
            { key: 'Mod-Enter', preventDefault: true, run: save },
            ...(formatJson ? [{ key: 'Mod-Shift-f', preventDefault: true, run: runFormatJson }] : []),
            {
              key: 'Escape',
              run: () => {
                if (!onCancelRef.current) {
                  return false
                }

                onCancelRef.current()

                return true
              }
            }
          ])
        ),
        languageConf.current.of(liveMarkdown ? markdown({ base: markdownLanguage }) : []),
        presentationConf.current.of(presentation ?? []),
        themeConf.current.of(githubEditorTheme(isDark)),
        highlightConf.current.of([]),
        editableConf.current.of([
          EditorState.readOnly.of(disabled),
          EditorView.editable.of(!disabled && !inputDisabled)
        ]),
        EditorView.domEventHandlers({
          compositionstart: () => {
            onCompositionChangeRef.current?.(true)
          },
          compositionend: () => {
            onCompositionChangeRef.current?.(false)
          }
        }),
        EditorView.updateListener.of(update => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString())
          }

          if (update.selectionSet || update.docChanged) {
            onCursorChangeRef.current?.(update.state.selection.main.head)
          }

          if (update.selectionSet || update.docChanged) {
            const range = update.state.selection.main
            onSelectionChangeRef.current?.({
              documentText: update.state.doc.toString(),
              from: range.from,
              to: range.to
            })
          }
        }),
        LAYOUT_THEME,
        // Standalone edits (SOUL.md, skills, memories) are prose, not code —
        // wrap long lines instead of scrolling horizontally, and drop the gutter
        // inset. Pane previews stay flush/scrolling to mirror their SourceView.
        ...(framed ? [EditorView.lineWrapping, FRAMED_THEME] : [])
      ]
    })

    const view = new EditorView({ parent: host, state })
    viewRef.current = view

    if (apiRef) {
      apiRef.current = {
        dispatchCommand: command => {
          const view = viewRef.current

          return view ? command(view) : false
        },
        focus: () => viewRef.current?.focus(),
        formatJson: () => {
          const view = viewRef.current

          if (!view || !formatJsonRef.current) {
            return { ok: false, error: 'JSON formatting is not enabled for this editor' }
          }

          return applyFormatJson(view)
        },
        getDoc: () => viewRef.current?.state.doc.toString() ?? '',
        getVisibleText: () => {
          const view = viewRef.current

          return view
            ? view.visibleRanges.map(range => view.state.doc.sliceString(range.from, range.to)).join('\n')
            : ''
        },
        getSelection: () => {
          const range = viewRef.current?.state.selection.main

          return range ? { from: range.from, to: range.to } : { from: 0, to: 0 }
        },
        getState: () => viewRef.current?.state ?? null,
        setCursor: pos => {
          const clamped = Math.max(0, Math.min(pos, view.state.doc.length))
          view.dispatch({ scrollIntoView: true, selection: { anchor: clamped } })
          view.focus()
        }
      }
    }

    // Consumers that derive UI state from the selection (toolbar pressed state,
    // the composer snapshot) must not wait for the first keystroke.
    onSelectionChangeRef.current?.({
      documentText: view.state.doc.toString(),
      from: view.state.selection.main.from,
      to: view.state.selection.main.to
    })

    const publishLocalKeybinds = () => {
      host.dataset.localKeybinds = localKeybindsRef.current.join(' ')
    }

    const clearLocalKeybinds = (event: FocusEvent) => {
      if (!host.contains(event.relatedTarget as Node | null)) {
        delete host.dataset.localKeybinds
      }
    }

    host.addEventListener('focusin', publishLocalKeybinds)
    host.addEventListener('focusout', clearLocalKeybinds)

    // Focus on mount so entering edit mode (button or double-click) lands the
    // caret in the buffer ready to type, no extra click required.
    if (!inputDisabled) {
      view.focus()
    }

    return () => {
      host.removeEventListener('focusin', publishLocalKeybinds)
      host.removeEventListener('focusout', clearLocalKeybinds)
      delete host.dataset.localKeybinds
      view.destroy()
      viewRef.current = null

      if (apiRef) {
        apiRef.current = null
      }
    }
    // Created once per mount; the parent remounts (via `key`) to load a new
    // file or discard. Theme/language are applied reactively below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Load + apply syntax highlighting for the file's language (lazy per language).
  useEffect(() => {
    let cancelled = false

    if (liveMarkdown) {
      return
    }

    const description = LanguageDescription.matchFilename(languages, baseName(filePath))

    if (!description) {
      viewRef.current?.dispatch({ effects: languageConf.current.reconfigure([]) })

      return
    }

    void description.load().then(support => {
      if (!cancelled && viewRef.current) {
        viewRef.current.dispatch({ effects: languageConf.current.reconfigure(support) })
      }
    })

    return () => {
      cancelled = true
    }
  }, [filePath, liveMarkdown])

  useEffect(() => {
    const view = viewRef.current

    if (!view) {
      return
    }

    if (liveMarkdown) {
      view.dispatch({ effects: languageConf.current.reconfigure(markdown({ base: markdownLanguage })) })
    }
  }, [liveMarkdown])

  useEffect(() => {
    const host = hostRef.current

    if (host?.contains(document.activeElement)) {
      host.dataset.localKeybinds = localKeybinds.join(' ')
    }
  }, [localKeybinds])

  useEffect(() => {
    viewRef.current?.dispatch({ effects: presentationConf.current.reconfigure(presentation ?? []) })
  }, [presentation])

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: extraKeymapConf.current.reconfigure(extraKeymap ? keymap.of(extraKeymap) : [])
    })
  }, [extraKeymap])

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: themeConf.current.reconfigure(githubEditorTheme(resolvedMode === 'dark'))
    })
  }, [resolvedMode])

  const highlightFrom = highlight?.from
  const highlightTo = highlight?.to

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: highlightConf.current.reconfigure(
        highlightFrom !== undefined && highlightTo !== undefined
          ? blockHighlight({ from: highlightFrom, to: highlightTo })
          : []
      )
    })
  }, [highlightFrom, highlightTo])

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: editableConf.current.reconfigure([
        EditorState.readOnly.of(disabled),
        EditorView.editable.of(!disabled && !inputDisabled)
      ])
    })
  }, [disabled, inputDisabled])

  if (!framed) {
    return <div className={cn('h-full min-h-0 overflow-hidden', className)} ref={hostRef} />
  }

  // Border on the shell only — inner body matches preview-file / DetailPane:
  // <div className="min-h-0 flex-1 overflow-hidden"><CodeEditor /></div>
  return (
    <div
      className={cn(
        'flex h-full min-h-0 flex-col overflow-hidden rounded-md border border-(--ui-stroke-tertiary)',
        className
      )}
    >
      {/* Padding lives on the CM *mount node* itself — outside CodeMirror's
          DOM entirely, so its `.cm-content { padding: 0 }` can't fight it. This
          is why every prior attempt (Tailwind on .cm-content, scroller padding)
          lost: they targeted CM-owned nodes. This div isn't one. */}
      <div className="min-h-0 flex-1 overflow-hidden p-2" ref={hostRef} />
    </div>
  )
}
