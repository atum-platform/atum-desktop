import type { CodeEditorApi } from '@/components/chat/code-editor'

import { codeEditorDocumentController } from './code-editor-document-controller'
import type { DocumentNavigationApi, DocumentSelection, RichDocumentEditorApi } from './document-editor-controller'
import { documentOutline } from './document-navigation-model'
import { nextDocumentMatch } from './rich-document-search'

function sourceMatches(text: string, query: string): DocumentSelection[] {
  const result: DocumentSelection[] = []

  if (!query) { return result }
  let index = text.indexOf(query)

  while (index !== -1) {
    result.push({ from: index, to: index + query.length })
    index = text.indexOf(query, index + query.length)
  }

  return result
}

/** Resolve active ownership at action time. A hidden or temporarily absent rich
 * editor never falls through to a source mutation. */
export function documentNavigationController(
  source: () => CodeEditorApi | null,
  rich: () => RichDocumentEditorApi | null,
  isRich: () => boolean,
  canAct: () => boolean
): DocumentNavigationApi {
  const controller = codeEditorDocumentController(source)

  const status = (query: string) => {
    const editor = source()
    const matches = sourceMatches(editor?.getDoc() ?? '', query)
    const selection = editor?.getSelection()

    return { current: matches.findIndex(match => match.from === selection?.from && match.to === selection?.to) + 1, total: matches.length }
  }

  return {
    getOutline: () => isRich() ? rich()?.getOutline() ?? [] : documentOutline(source()?.getDoc() ?? ''),
    navigateToHeading: position => {
      if (!canAct()) { return false }

      if (isRich()) { return rich()?.navigateToHeading(position) ?? false }
      const editor = source()

      if (!editor) { return false }
      editor.setCursor(position)

      return true
    },
    setSearchQuery: query => {
      if (!query && !isRich()) { rich()?.setSearchQuery(query) }

      return isRich() ? rich()?.setSearchQuery(query) ?? { current: 0, total: 0 } : status(query)
    },
    search: (query, direction) => {
      if (!canAct()) { return { current: 0, total: 0 } }

      if (isRich()) { return rich()?.search(query, direction) ?? { current: 0, total: 0 } }
      const editor = source()

      if (!editor) { return { current: 0, total: 0 } }
      const match = nextDocumentMatch(sourceMatches(editor.getDoc(), query), editor.getSelection(), direction)

      if (match) {
        editor.dispatchCommand(view => {
          view.dispatch({ selection: { anchor: match.from, head: match.to }, scrollIntoView: true })

          return true
        })
      }

      return status(query)
    },
    replaceSearchMatch: (query, replacement) => {
      if (!canAct() || !query) { return false }

      if (isRich()) { return rich()?.replaceSearchMatch(query, replacement) ?? false }
      const editor = source()

      if (!editor) { return false }
      const text = editor.getDoc()
      const { from, to } = editor.getSelection()

      if (text.slice(from, to) !== query) { return false }

      return controller.commit({
        expectedSource: text, kind: 'structure', patch: { from, to, insert: replacement },
        selection: { from: from + replacement.length, to: from + replacement.length }
      })
    }
  }
}
