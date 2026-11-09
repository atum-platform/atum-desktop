import { isolateHistory, redo, undo } from '@codemirror/commands'
import { Transaction } from '@codemirror/state'

import type { CodeEditorApi } from '@/components/chat/code-editor'

import type { DocumentEditorController } from './document-editor-controller'

/** Reuse the source editor's exact-byte history across both input surfaces. */
export function codeEditorDocumentController(getApi: () => CodeEditorApi | null): DocumentEditorController {
  return {
    getSource: () => getApi()?.getDoc() ?? '',
    commit: request => {
      const api = getApi()

      if (!api || api.getDoc() !== request.expectedSource) {
        return false
      }

      const { patch, selection, kind } = request
      const length = request.expectedSource.length - (patch.to - patch.from) + patch.insert.length

      if (
        !Number.isInteger(patch.from) ||
        !Number.isInteger(patch.to) ||
        patch.from < 0 ||
        patch.to < patch.from ||
        patch.to > request.expectedSource.length ||
        !Number.isInteger(selection.from) ||
        !Number.isInteger(selection.to) ||
        selection.from < 0 ||
        selection.to < selection.from ||
        selection.to > length
      ) {
        return false
      }

      return api.dispatchCommand(view => {
        if (view.state.readOnly || view.state.doc.toString() !== request.expectedSource) {
          return false
        }

        view.dispatch({
          changes: patch,
          selection: { anchor: selection.from, head: selection.to },
          annotations: [
            Transaction.userEvent.of(kind === 'typing' ? 'input.type' : `input.${kind}`),
            ...(kind === 'typing' ? [] : [isolateHistory.of('full')])
          ]
        })

        return true
      })
    },
    select: selection => {
      getApi()?.dispatchCommand(view => {
        const clamp = (position: number) => Math.max(0, Math.min(view.state.doc.length, position))
        const from = clamp(selection.from)
        const to = clamp(selection.to)

        if (view.state.selection.main.from !== from || view.state.selection.main.to !== to) {
          view.dispatch({ selection: { anchor: from, head: to } })
        }

        return true
      })
    },
    undo: () => getApi()?.dispatchCommand(undo) ?? false,
    redo: () => getApi()?.dispatchCommand(redo) ?? false
  }
}
