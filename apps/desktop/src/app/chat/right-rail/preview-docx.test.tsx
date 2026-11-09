import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import type { PreviewTarget } from '@/store/preview'

import { docxFilePath, DocxPreview } from './preview-docx'

const target: PreviewTarget = {
  kind: 'file',
  label: 'plan.docx',
  path: '/tmp/plan.docx',
  previewKind: 'docx',
  source: '/tmp/plan.docx',
  url: 'file:///tmp/plan.docx'
}

function renderPreview() {
  return render(
    <I18nProvider configClient={null} initialLocale="en">
      <DocxPreview reloadKey={0} target={target} />
    </I18nProvider>
  )
}

describe('DocxPreview', () => {
  beforeEach(() => {
    Object.assign(window, {
      hermesDesktop: {
        docxPreview: vi.fn().mockResolvedValue({
          blockCount: 1,
          byteSize: 100,
          markdown: '# Plan',
          path: target.path,
          truncated: false
        })
      }
    })
  })

  it('resolves a local path without another document runtime', () => {
    expect(docxFilePath(target)).toBe('/tmp/plan.docx')
    expect(docxFilePath({ ...target, path: undefined, url: 'file:///tmp/a%20b.docx' })).toBe('/tmp/a b.docx')
  })

  it('renders the main-process Markdown projection', async () => {
    renderPreview()

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Plan' })).toBeTruthy())
    expect(window.hermesDesktop.docxPreview).toHaveBeenCalledWith('/tmp/plan.docx')
  })

  it('reports conversion failure honestly', async () => {
    vi.mocked(window.hermesDesktop.docxPreview!).mockRejectedValueOnce(new Error('invalid package'))
    renderPreview()

    await waitFor(() => expect(screen.getByText(/invalid package/u)).toBeTruthy())
  })
})
