import { useEffect, useState } from 'react'

import { useI18n } from '@/i18n'
import { isDesktopFsRemoteMode, readDesktopFileDataUrl } from '@/lib/desktop-fs'
import { bytesFromDataUrl, docxToMarkdown } from '@/lib/docx-markdown'
import { FileText, Spinner } from '@/lib/icons'
import type { PreviewTarget } from '@/store/preview'

import { MarkdownPreview } from './preview-markdown'

interface DocxState {
  error?: string
  markdown?: string
  refreshing: boolean
  truncated?: boolean
}

export function docxFilePath(target: PreviewTarget): string {
  if (target.path) {
    return target.path
  }

  try {
    const url = new URL(target.url)

    return url.protocol === 'file:' ? decodeURIComponent(url.pathname) : target.url
  } catch {
    return target.url
  }
}

async function loadDocx(filePath: string): Promise<{ markdown: string; truncated: boolean }> {
  if (!isDesktopFsRemoteMode() && window.hermesDesktop?.docxPreview) {
    const result = await window.hermesDesktop.docxPreview(filePath)

    return { markdown: result?.markdown ?? '', truncated: Boolean(result?.truncated) }
  }

  const dataUrl = await readDesktopFileDataUrl(filePath)
  const result = await docxToMarkdown(bytesFromDataUrl(dataUrl))

  return { markdown: result.markdown, truncated: false }
}

/**
 * Word files are readable previews, not a second office product. Main converts
 * local OOXML packages to bounded Markdown; remote/older hosts use the same
 * renderer-side compatibility path. Editing remains the ordinary file/native
 * app responsibility.
 */
export function DocxPreview({ reloadKey, target }: { reloadKey: number; target: PreviewTarget }) {
  const { t } = useI18n()
  const filePath = docxFilePath(target)
  const [state, setState] = useState<DocxState>({ refreshing: true })

  useEffect(() => {
    let active = true

    setState(current => ({ ...current, error: undefined, refreshing: true }))

    void loadDocx(filePath)
      .then(result => {
        if (active) {
          setState({ ...result, refreshing: false })
        }
      })
      .catch(error => {
        if (active) {
          setState(current => ({
            ...current,
            error: error instanceof Error ? error.message : String(error),
            refreshing: false
          }))
        }
      })

    return () => {
      active = false
    }
  }, [filePath, reloadKey])

  if (state.error && !state.markdown) {
    return (
      <div className="grid h-full place-items-center px-6 text-center text-sm text-muted-foreground">
        <div>
          <FileText aria-hidden className="mx-auto mb-3 size-7 opacity-60" />
          {t.preview.docx.failed(state.error)}
        </div>
      </div>
    )
  }

  if (!state.markdown && !state.refreshing) {
    return (
      <div className="grid h-full place-items-center px-6 text-center text-sm text-muted-foreground">
        {t.preview.docx.empty}
      </div>
    )
  }

  return (
    <div className="relative h-full overflow-y-auto">
      {state.truncated && (
        <div className="mx-4 mt-3 rounded-md border border-border bg-muted/45 px-3 py-2 text-xs text-muted-foreground">
          <div className="font-medium text-foreground">{t.preview.docx.truncatedTitle}</div>
          <div className="mt-0.5">{t.preview.docx.truncatedBody}</div>
        </div>
      )}
      {state.markdown && <MarkdownPreview className={state.refreshing ? 'opacity-60' : undefined} text={state.markdown} />}
      {state.refreshing && (
        <div className="absolute inset-0 grid place-items-center bg-background/45">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner className="size-4 animate-spin" />
            {t.preview.docx.refreshing}
          </div>
        </div>
      )}
    </div>
  )
}
