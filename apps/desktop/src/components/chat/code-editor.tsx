import { useTheme } from '@/themes/context'

import { CodeEditorSurface, type CodeEditorSurfaceProps } from './code-editor-surface'

export {
  type CodeEditorApi,
  type CodeEditorSelection,
  CodeEditorSurface,
  type CodeEditorSurfaceProps
} from './code-editor-surface'

/** Legacy desktop adapter. Native Matrix pages import CodeEditorSurface instead. */
export function CodeEditor(props: Omit<CodeEditorSurfaceProps, 'resolvedMode'>) {
  const { resolvedMode } = useTheme()

  return <CodeEditorSurface {...props} resolvedMode={resolvedMode} />
}
