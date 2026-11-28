import { expect, it } from 'vitest'

import { saveBrowserUpdate, takeBrowserUpdate } from './browser-update-checkpoint'

it('reopens the selected public page once for the same owner and room', () => {
  const scope = '@owner:test\u0000device\u0000!room:test'
  const record = { urls: ['https://example.com/docs', 'https://example.org/'], selected: 1, open: true }
  saveBrowserUpdate(localStorage, scope, record)
  expect(takeBrowserUpdate(localStorage, scope + 'changed')).toBeUndefined()
  expect(takeBrowserUpdate(localStorage, scope)).toEqual(record)
  expect(takeBrowserUpdate(localStorage, scope)).toBeUndefined()
})

it.each(['http://example.com/', 'https://localhost/', 'https://example.com/?query=secret', 'https://example.com/#token=value'])(
  'does not reopen an unsafe stored destination (%s)', url => {
    saveBrowserUpdate(localStorage, 'scope', { urls: [url], selected: 0, open: true })
    expect(takeBrowserUpdate(localStorage, 'scope')).toBeUndefined()
  }
)
