// Synthetic renderer acceptance fixture, excluded from the production entry.
import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { WorkspaceTextFilePane } from '../../src/app/chat/workspace-text-file-pane'
import { I18nProvider } from '../../src/i18n'
import { ThemeProvider } from '../../src/themes/context'
import { workspaceTextFileTarget } from '../../src/store/workspace-text-files'
import { resolveDocumentTheme } from '../../shared/atum-office/document-theme'
import '../../src/styles.css'

let text = '# Báo cáo hoạt động\n\nVCCI serves a representative function to promote and protect the lawful, legitimate rights of the business and employer community in Vietnam.\n\n## Kế hoạch quý tới\n\nTài liệu này dùng để kiểm tra kiểu chữ, lưu tự động và thao tác chỉnh sửa trong Atum.\n\n- Review the annual report\n- Prepare the next meeting\n\n## Project summary\n\n| Milestone | Status |\n| --- | --- |\n| Document controls | In review |\n| Recovery | Verified |\n\nThe original document remains in your workspace. **Important details** should retain their emphasis.\n'
let revision = 1
let recovery = null
window.hermesDesktop = { filesystemCapability: {
  readTextFile: async () => ({ text, revision: String(revision), truncated: false }),
  watchTextFile: () => () => {},
  writeTextFile: async (_ref, input) => {
    if (input.expectedRevision !== String(revision)) throw new Error('WORKSPACE_CONFLICT')
    await new Promise(resolve => setTimeout(resolve, 150))
    text = input.text
    return { revision: String(++revision) }
  },
  documentTheme: async () => resolveDocumentTheme({ themeId: 'modern' }),
  documentThemeSet: async ({selection}) => ({ persisted: true, theme: resolveDocumentTheme(selection) }),
  recovery: {
    version: 1,
    read: async () => ({ outcome: recovery ? 'present' : 'absent', record: recovery }),
    write: async (fileRef, input) => {
      if ((recovery?.draftRevision ?? null) !== input.expectedDraftRevision) return { outcome: 'stale', record: recovery }
      recovery = {...input, documentId: fileRef, draftRevision: crypto.randomUUID()}
      return { outcome: 'saved', record: recovery }
    },
    discard: async (_ref, expected) => {
      if (recovery && recovery.draftRevision !== expected) return { outcome: 'stale', record: recovery }
      recovery = null
      return { outcome: 'discarded', record: null }
    }
  }
}}
const target = workspaceTextFileTarget({ displayName: 'Báo cáo hoạt động.md', fileRef: 'fixture-only', workspaceRelativePath: 'fixture/report.md' })
function Preview() {
  const [width, setWidth] = useState(1000)
  return <I18nProvider initialLocale="en" configClient={null}><ThemeProvider>
    <div className="atum-shell" style={{ height: '100vh', background: 'var(--atum-bg)', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', gap: 12, padding: 8 }}>
        {[360,600,1000].map(size => <button key={size} onClick={() => setWidth(size)}>{size}px</button>)}
      </div>
      <div style={{ width, maxWidth: '100%', minHeight: 0, flex: 1, margin: '0 auto', display: 'flex', flexDirection: 'column' }}>
        <div style={{ height: 44, flexShrink: 0, padding: '10px 14px' }}>Báo cáo hoạt động.md</div>
        <div style={{ minHeight: 0, flex: 1 }}><WorkspaceTextFilePane tab={{ target }} /></div>
      </div>
    </div>
  </ThemeProvider></I18nProvider>
}
createRoot(document.getElementById('root')).render(<Preview />)
