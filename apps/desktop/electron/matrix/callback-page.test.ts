import { describe, expect, it } from 'vitest'

import { matrixCallbackLocale, matrixCallbackPage } from './callback-page'

describe('the page a sign-in ends on', () => {
  it('speaks the browser’s first language Atum speaks, with the right lang attribute', () => {
    const english = matrixCallbackPage('signed_in', 'en-US,en;q=0.9,vi;q=0.8')

    expect(english).toContain('<html lang="en">')
    expect(english).toContain('Signed in to Atum')
    expect(english).not.toContain('Đã đăng nhập')

    expect(matrixCallbackPage('failed', 'ja-JP')).toContain('<html lang="ja">')
    expect(matrixCallbackPage('failed', 'zh-TW,zh;q=0.9')).toContain('<html lang="zh-Hant">')
    expect(matrixCallbackLocale('fr-FR, de;q=0.5, zh-CN;q=0.3')).toBe('zh')
  })

  it('keeps Vietnamese with English under it when the browser speaks none of Atum’s languages', () => {
    for (const header of [undefined, '', 'fr-FR,de;q=0.9', '*']) {
      const page = matrixCallbackPage('signed_in', header)

      expect(page, String(header)).toContain('<html lang="vi">')
      expect(page).toContain('Đã đăng nhập Atum')
      expect(page).toContain('<p lang="en">Signed in to Atum. Atum is back in front. You can close this tab.</p>')
    }
  })

  it('puts nothing from the request into the page', () => {
    const page = matrixCallbackPage('missing', 'en-US,<script>alert(1)</script>;q=0.1')

    expect(page).not.toContain('<script')
    expect(page).toContain('Nothing here. You can close this tab.')
  })
})
