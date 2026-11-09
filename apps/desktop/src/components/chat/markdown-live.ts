import { syntaxTree } from '@codemirror/language'
import { type Extension, RangeSet, StateEffect } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view'
import type { SyntaxNodeRef } from '@lezer/common'

export interface MarkdownLiveGuard {
  docLength: number
  longestLine: number
  tooLarge: boolean
}

export interface MarkdownLiveOptions {
  /** Called on install and whenever the guard verdict flips. */
  onGuard?: (guard: MarkdownLiveGuard) => void
}

export const MARKDOWN_LIVE_LIMITS = {
  maxDocLength: 128 * 1024,
  maxLineLength: 32 * 1024
} as const

const compositionChanged = StateEffect.define<boolean>()

const styleMarks: Record<string, Decoration> = {
  ATXHeading1: Decoration.mark({ class: 'cm-markdown-heading cm-markdown-heading-1' }),
  ATXHeading2: Decoration.mark({ class: 'cm-markdown-heading cm-markdown-heading-2' }),
  ATXHeading3: Decoration.mark({ class: 'cm-markdown-heading cm-markdown-heading-3' }),
  ATXHeading4: Decoration.mark({ class: 'cm-markdown-heading cm-markdown-heading-4' }),
  ATXHeading5: Decoration.mark({ class: 'cm-markdown-heading cm-markdown-heading-5' }),
  ATXHeading6: Decoration.mark({ class: 'cm-markdown-heading cm-markdown-heading-6' }),
  SetextHeading1: Decoration.mark({ class: 'cm-markdown-heading cm-markdown-heading-1' }),
  SetextHeading2: Decoration.mark({ class: 'cm-markdown-heading cm-markdown-heading-2' }),
  Blockquote: Decoration.mark({ class: 'cm-markdown-quote' }),
  Emphasis: Decoration.mark({ class: 'cm-markdown-emphasis' }),
  InlineCode: Decoration.mark({ class: 'cm-markdown-inline-code' }),
  StrongEmphasis: Decoration.mark({ class: 'cm-markdown-strong' })
}

const excludedParents = new Set(['CodeBlock', 'FencedCode', 'HTMLBlock', 'Table'])

class BulletMarker extends WidgetType {
  toDOM(): HTMLElement {
    const marker = document.createElement('span')
    marker.className = 'cm-markdown-list-marker'
    marker.textContent = '•'
    marker.setAttribute('aria-hidden', 'true')

    return marker
  }
}

const bulletMarker = new BulletMarker()

function guardFor(view: EditorView): MarkdownLiveGuard {
  let longestLine = 0

  for (let number = 1; number <= view.state.doc.lines; number++) {
    longestLine = Math.max(longestLine, view.state.doc.line(number).length)

    if (longestLine > MARKDOWN_LIVE_LIMITS.maxLineLength) {
      break
    }
  }

  const docLength = view.state.doc.length

  return {
    docLength,
    longestLine,
    tooLarge: docLength > MARKDOWN_LIVE_LIMITS.maxDocLength || longestLine > MARKDOWN_LIVE_LIMITS.maxLineLength
  }
}

function revealedLines(view: EditorView, composing: boolean): Set<number> {
  const lines = new Set<number>()
  const selection = view.state.selection.main

  for (
    let number = view.state.doc.lineAt(selection.from).number;
    number <= view.state.doc.lineAt(selection.to).number;
    number++
  ) {
    lines.add(number)
  }

  if (composing) {
    lines.add(view.state.doc.lineAt(selection.head).number)
  }

  return lines
}

function touchesRevealedLine(view: EditorView, from: number, to: number, revealed: Set<number>): boolean {
  const first = view.state.doc.lineAt(from).number
  const last = view.state.doc.lineAt(Math.max(from, to - 1)).number

  for (let number = first; number <= last; number++) {
    if (revealed.has(number)) {
      return true
    }
  }

  return false
}

function linkTitle(view: EditorView, node: SyntaxNodeRef): string | undefined {
  const url = node.node.getChild('URL')

  return url ? view.state.sliceDoc(url.from, url.to) : undefined
}

function buildDecorations(view: EditorView, composing: boolean): { atomic: DecorationSet; decorations: DecorationSet } {
  const ranges: ReturnType<Decoration['range']>[] = []
  const atomic: ReturnType<Decoration['range']>[] = []
  const revealed = revealedLines(view, composing)
  const tree = syntaxTree(view.state)

  for (const visible of view.visibleRanges) {
    tree.iterate({
      enter(node) {
        if (excludedParents.has(node.name)) {
          if (node.name === 'FencedCode' || node.name === 'CodeBlock') {
            ranges.push(Decoration.mark({ class: 'cm-markdown-code-block' }).range(node.from, node.to))
          }
          return false
        }

        const style = styleMarks[node.name]

        if (style) {
          ranges.push(style.range(node.from, node.to))
        } else if (node.name === 'Link') {
          ranges.push(
            Decoration.mark({ attributes: { title: linkTitle(view, node) ?? '' }, class: 'cm-markdown-link' }).range(
              node.from,
              node.to
            )
          )
        }

        const hidden =
          node.name === 'HeaderMark' ||
          node.name === 'EmphasisMark' ||
          node.name === 'CodeMark' ||
          node.name === 'QuoteMark' ||
          ((node.name === 'LinkMark' || node.name === 'URL') && node.node.parent?.name === 'Link')

        const bullet = node.name === 'ListMark' && node.node.parent?.parent?.name === 'BulletList'

        if ((hidden || bullet) && !touchesRevealedLine(view, node.from, node.to, revealed)) {
          const decoration = Decoration.replace({
            // Replace decorations need a widget to paint anything: a `class`
            // spec alone hides the marker without creating a DOM element.
            ...(bullet ? { widget: bulletMarker } : {})
          })

          const range = decoration.range(node.from, node.to)
          ranges.push(range)
          atomic.push(range)
        }
      },
      from: visible.from,
      to: visible.to
    })
  }

  return { atomic: Decoration.set(atomic, true), decorations: Decoration.set(ranges, true) }
}

function selectionLineBounds(view: EditorView): { from: number; to: number } {
  const range = view.state.selection.main

  return { from: view.state.doc.lineAt(range.from).number, to: view.state.doc.lineAt(range.to).number }
}

function docChangeTouchesViewport(update: ViewUpdate): boolean {
  if (!update.docChanged) {
    return false
  }

  let touches = false

  for (const range of update.view.visibleRanges) {
    update.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
      if (fromB <= range.to && toB >= range.from) {
        touches = true
      }
    })
  }

  return touches
}

export function markdownLive(options: MarkdownLiveOptions = {}): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      atomic: DecorationSet = Decoration.none
      decorations: DecorationSet = Decoration.none
      guard: MarkdownLiveGuard
      private composing = false
      private lineBounds: { from: number; to: number }

      constructor(private readonly view: EditorView) {
        this.guard = guardFor(view)
        this.lineBounds = selectionLineBounds(view)
        options.onGuard?.(this.guard)
        this.rebuild('install')
      }

      update(update: ViewUpdate) {
        const started = performance.now()

        const compositionEffect = update.transactions
          .flatMap(transaction => transaction.effects)
          .find(effect => effect.is(compositionChanged))

        const wasComposing = this.composing
        let guardFlipped = false
        this.composing = compositionEffect
          ? compositionEffect.value
          : update.view.composing || update.view.compositionStarted

        if (update.docChanged) {
          const nextGuard = guardFor(update.view)

          if (nextGuard.tooLarge !== this.guard.tooLarge) {
            guardFlipped = true
            options.onGuard?.(nextGuard)
          }

          this.guard = nextGuard

          if (this.composing && !this.guard.tooLarge) {
            this.decorations = this.decorations.map(update.changes)
            this.atomic = this.atomic.map(update.changes)
          }
        }

        const nextBounds = selectionLineBounds(update.view)
        const crossedLine = nextBounds.from !== this.lineBounds.from || nextBounds.to !== this.lineBounds.to
        this.lineBounds = nextBounds
        const compositionEnded = wasComposing && !this.composing

        if (
          guardFlipped ||
          update.transactions.some(transaction => transaction.reconfigured) ||
          (!this.composing && (update.viewportChanged || crossedLine || docChangeTouchesViewport(update))) ||
          compositionEffect ||
          compositionEnded
        ) {
          this.rebuild(compositionEffect ? 'composition' : 'update', started)
        }
      }

      private rebuild(reason: string, started = performance.now()) {
        if (this.guard.tooLarge) {
          this.decorations = Decoration.none
          this.atomic = Decoration.none
          this.publishDebug(started, 0, 'guard')

          return
        }

        const built = buildDecorations(this.view, this.composing)
        this.decorations = built.decorations
        this.atomic = built.atomic
        this.publishDebug(started, built.decorations.size, reason)
      }

      private publishDebug(started: number, ranges: number, reason: string) {
        if (import.meta.env.DEV) {
          const builds = Number(this.view.dom.dataset.markdownLiveBuilds ?? 0) + 1
          this.view.dom.dataset.markdownLiveBuilds = String(builds)
          this.view.dom.dataset.markdownLiveBuildMs = String(performance.now() - started)
          this.view.dom.dataset.markdownLiveRanges = String(ranges)
          this.view.dom.dataset.markdownLiveFallback = this.guard.tooLarge ? 'guard' : ''
          this.view.dom.dataset.markdownLiveCompositionSuppression = String(this.composing)
          this.view.dom.dataset.markdownLiveReason = reason
        }
      }
    },
    { decorations: value => value.decorations }
  )

  return [
    plugin,
    EditorView.atomicRanges.of(view => view.plugin(plugin)?.atomic ?? RangeSet.empty),
    EditorView.domEventHandlers({
      compositionend(_event, view) {
        view.dispatch({ effects: compositionChanged.of(false) })

        return false
      },
      compositionstart(_event, view) {
        view.dispatch({ effects: compositionChanged.of(true) })

        return false
      }
    })
  ]
}

export const markdownLiveTheme: Extension = EditorView.theme({
  '.cm-markdown-emphasis': { color: 'var(--atum-ink, currentColor)', fontStyle: 'italic' },
  '.cm-markdown-heading': { color: 'var(--atum-ink, currentColor)', fontWeight: '600' },
  '.cm-markdown-heading-1': { fontSize: 'var(--atum-t-title, 1.5rem)' },
  '.cm-markdown-heading-2': { fontSize: 'var(--atum-t-section, 1.25rem)' },
  '.cm-markdown-heading-3': { fontSize: 'var(--atum-t-body, 1rem)' },
  '.cm-markdown-heading-4': { fontSize: 'var(--atum-t-body, 1rem)' },
  '.cm-markdown-heading-5': { fontSize: 'var(--atum-t-body, 1rem)' },
  '.cm-markdown-heading-6': { fontSize: 'var(--atum-t-body, 1rem)' },
  '.cm-markdown-hidden-mark': { display: 'none' },
  '.cm-markdown-inline-code': { color: 'var(--atum-ink, currentColor)', fontFamily: 'var(--font-mono)' },
  '.cm-markdown-code-block': { fontFamily: 'var(--font-mono)' },
  '.cm-markdown-link': { color: 'var(--atum-accent, currentColor)', textDecoration: 'underline' },
  '.cm-markdown-list-marker': {
    color: 'var(--atum-ink-muted, currentColor)',
    display: 'inline-block',
    width: '1ch'
  },
  '.cm-markdown-quote': { color: 'var(--atum-ink-muted, currentColor)' },
  '.cm-markdown-strong': { color: 'var(--atum-ink, currentColor)', fontWeight: '700' }
})
