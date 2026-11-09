import { describe, expect, it } from 'vitest'

import { desktopVersionHeaderValue } from './desktop-version-header'

describe('desktopVersionHeaderValue', () => {
  it.each(['0.18.3', '0.18.2', '1.0.0', '0.18.3-rc.1'])('sends the release version %s as given', version => {
    expect(desktopVersionHeaderValue(version)).toBe(version)
  })

  it.each([undefined, '', '0.18', 'v0.18.3', '0.18.3\r\nX-Injected: 1', '0.18.3 ', 'latest'])(
    'sends nothing for %j',
    version => {
      expect(desktopVersionHeaderValue(version)).toBeUndefined()
    }
  )
})
