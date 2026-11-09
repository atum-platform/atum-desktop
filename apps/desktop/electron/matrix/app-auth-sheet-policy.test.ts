import { describe, expect, it } from 'vitest'

import { appAuthApprovedOrigins, appAuthNavigation, appAuthSheetHtml, safeAppAuthIcon } from './app-auth-sheet-policy'

describe('app authentication sheet policy', () => {
  it('admits only the exact connect and manifest origins', () => {
    const approved = appAuthApprovedOrigins('https://account.atumplatform.com/link/start?t=x&a=y', [
      'https://moon.atumplatform.com',
      'https://moon-auth.example'
    ])

    expect([...approved]).toEqual([
      'https://account.atumplatform.com',
      'https://moon.atumplatform.com',
      'https://moon-auth.example'
    ])
    expect(appAuthNavigation('https://moon.atumplatform.com/atum/lien-ket?attempt=x', approved)).toBe('allow')
    expect(appAuthNavigation('https://moon.atumplatform.com.evil.test/atum/lien-ket', approved)).toBe('refuse')
    expect(appAuthNavigation('http://moon.atumplatform.com/atum/lien-ket', approved)).toBe('refuse')
    expect(appAuthNavigation('https://u@moon.atumplatform.com/atum/lien-ket', approved)).toBe('refuse')
  })

  it('hands only Google OAuth to the system browser', () => {
    const approved = appAuthApprovedOrigins('https://account.atumplatform.com/link/start?t=x&a=y', [])

    expect(appAuthNavigation('https://accounts.google.com/o/oauth2/v2/auth?client_id=x', approved)).toBe(
      'google_system_browser'
    )
    expect(appAuthNavigation('https://accounts.google.com.evil.test/o/oauth2/v2/auth', approved)).toBe('refuse')
    expect(appAuthNavigation('https://example.com/?provider=google', approved)).toBe('refuse')
  })

  it('refuses malformed origin configuration instead of widening it', () => {
    expect(() => appAuthApprovedOrigins('http://account.atumplatform.com/link/start?t=x&a=y', [])).toThrow(
      'app_auth_authorize_invalid'
    )
    expect(() =>
      appAuthApprovedOrigins('https://account.atumplatform.com/link/start?t=x&a=y', [
        'https://moon.atumplatform.com/path'
      ])
    ).toThrow('app_auth_origin_invalid')
  })

  it('keeps exact loopback HTTP available for local development only', () => {
    const approved = appAuthApprovedOrigins('http://127.0.0.1:4200/link/start?t=x&a=y', [
      'http://localhost:4300'
    ])

    expect(appAuthNavigation('http://127.0.0.1:4200/link/start?t=x&a=y', approved)).toBe('allow')
    expect(appAuthNavigation('http://localhost:4300/login', approved)).toBe('allow')
    expect(appAuthNavigation('http://192.168.1.10:4300/login', approved)).toBe('refuse')
  })

  it('renders inert escaped chrome and only bounded raster data icons', () => {
    const icon = `data:image/png;base64,${Buffer.from('png').toString('base64')}`
    const html = appAuthSheetHtml({
      appName: '<Moon>',
      closeLabel: 'Close',
      googleHint: 'Google',
      iconDataUrl: icon,
      title: 'Connect <Moon>'
    })

    expect(html).toContain('&lt;Moon&gt;')
    expect(html).not.toContain('Connect <Moon>')
    expect(html).toContain(icon)
    expect(html).not.toContain('<script')
    expect(safeAppAuthIcon('data:text/html;base64,abc')).toBeNull()
    expect(safeAppAuthIcon(icon)).toBe(icon)
  })
})
