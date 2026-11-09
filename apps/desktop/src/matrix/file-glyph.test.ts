import { describe, expect, it } from 'vitest'

import { File, FileImage, FileSpreadsheet, FileText } from '@/lib/icons'

import { matrixFileGlyph } from './file-glyph'

describe('matrixFileGlyph', () => {
  it('names a file by what it is to its owner, whatever the case of its extension', () => {
    expect(matrixFileGlyph('Kế hoạch Đà Lạt.docx')).toBe(FileText)
    expect(matrixFileGlyph('menu.pdf')).toBe(FileText)
    expect(matrixFileGlyph('Ngân sách 2026.XLSX')).toBe(FileSpreadsheet)
    expect(matrixFileGlyph('Hồ Tuyền Lâm.heic')).toBe(FileImage)
  })

  it('falls back to a plain file, never a code glyph', () => {
    expect(matrixFileGlyph('track.py')).toBe(File)
    expect(matrixFileGlyph('README')).toBe(File)
    expect(matrixFileGlyph('.env')).toBe(File)
  })
})
