import { describe, expect, it } from 'vitest'

import { mountDesktopWebview } from './desktop-webview-host'

describe('desktop webview host', () => {
  it('mounts every product webview with one sandboxed attribute contract', () => {
    const host = document.createElement('div')

    const webview = mountDesktopWebview({
      className: 'surface',
      host,
      partition: 'persist:test',
      src: 'https://example.test'
    })

    expect(host.firstElementChild).toBe(webview)
    expect(webview.getAttribute('partition')).toBe('persist:test')
    expect(webview.getAttribute('src')).toBe('https://example.test')
    expect(webview.getAttribute('webpreferences')).toBe(
      'contextIsolation=yes,nodeIntegration=no,sandbox=yes,devTools=no'
    )
    expect(webview.hasAttribute('allowpopups')).toBe(false)
  })

  it('opts in to main-mediated popup events only for a consumer browser', () => {
    const webview = mountDesktopWebview({
      allowPopups: true,
      className: 'surface',
      host: document.createElement('div'),
      partition: 'atum-consumer-browser-test',
      src: 'https://example.com'
    })

    expect(webview.hasAttribute('allowpopups')).toBe(true)
  })
})
