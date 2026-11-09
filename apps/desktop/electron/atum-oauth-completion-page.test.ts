import { describe, expect, it } from 'vitest'

import { atumOAuthCompletionHtml, type AtumOAuthCompletionKind } from './atum-oauth-completion-page'

describe('Atum OAuth completion page', () => {
  it.each([
    ['native-sign-in', "You're signed in"],
    ['connection-approved', 'Connection approved'],
    ['connection-denied', 'Connection not approved'],
    ['invalid-response', 'Invalid authorization response']
  ] as Array<[AtumOAuthCompletionKind, string]>)('renders %s as an Atum-owned document', (kind, title) => {
    const html = atumOAuthCompletionHtml(kind)

    expect(html).toContain(`<title>${title} · Atum</title>`)
    expect(html).toContain('aria-labelledby="atum-oauth-title"')
    expect(html).toContain('<span>Atum</span>')
    expect(html).not.toContain('Hermes')
  })

  it('auto-closes only the completed native sign-in page', () => {
    expect(atumOAuthCompletionHtml('native-sign-in')).toContain('window.close()')
    expect(atumOAuthCompletionHtml('native-sign-in')).toContain("script-src 'unsafe-inline'")
    expect(atumOAuthCompletionHtml('connection-approved')).not.toContain('window.close()')
    expect(atumOAuthCompletionHtml('connection-denied')).not.toContain('window.close()')
    expect(atumOAuthCompletionHtml('invalid-response')).not.toContain('window.close()')
    expect(atumOAuthCompletionHtml('invalid-response')).not.toContain('script-src')
  })

  it('renders localized copy and document language for Vietnamese', () => {
    const html = atumOAuthCompletionHtml('connection-approved', 'vi')

    expect(html).toContain('<html lang="vi">')
    expect(html).toContain('<title>Đã cho phép kết nối · Atum</title>')
    expect(html).toContain('Atum cho máy tính')
  })
})
