/** Canonical document coordinates are UTF-16 offsets into the saved source. */
export interface DocumentSelection {
  from: number
  to: number
}

export interface DocumentSourcePatch extends DocumentSelection {
  insert: string
}

/** The existing source buffer owns history, persistence and assistant context.
 * A rich view may propose a validated edit, but cannot publish another buffer. */
export interface DocumentEditorController {
  commit: (request: {
    expectedSource: string
    patch: DocumentSourcePatch
    selection: DocumentSelection
    kind: 'typing' | 'format' | 'paste' | 'structure'
  }) => boolean
  getSource: () => string
  redo: () => boolean
  select: (selection: DocumentSelection) => void
  undo: () => boolean
}

export type RichDocumentCommand =
  | 'bold'
  | 'italic'
  | 'strike'
  | 'heading'
  | 'bullet'
  | 'numbered'
  | 'quote'
  | 'code'
  | 'link'
  | 'table'
  | 'rowAfter'
  | 'columnAfter'
  | 'deleteRow'
  | 'deleteColumn'

export interface DocumentOutlineItem {
  from: number
  title: string
  level: number
}

export interface DocumentSearchStatus {
  current: number
  total: number
}

/** Navigation belongs to the active projection. Mutation still goes through
 * its existing canonical controller; the pane never rewrites rich source. */
export interface DocumentNavigationApi {
  search: (query: string, direction: 1 | -1) => DocumentSearchStatus
  setSearchQuery: (query: string) => DocumentSearchStatus
  replaceSearchMatch: (query: string, replacement: string) => boolean
  getOutline: () => DocumentOutlineItem[]
  navigateToHeading: (position: number) => boolean
}

export interface RichDocumentEditorApi extends DocumentNavigationApi {
  command: (command: RichDocumentCommand, value?: number | string) => boolean
  focus: () => void
  pasteWithoutFormatting: () => boolean
  syncSource: (source: string, selection: DocumentSelection) => void
}
