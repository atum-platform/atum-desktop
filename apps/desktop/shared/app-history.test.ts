import { expect, it } from 'vitest'

import { parseMatrixAppHistoryPage } from './app-history'

const appId = '00000000-0000-4000-8000-783b984047f5'
const version = '00000000-0000-4000-8000-6f604e7be5f9'
const page = {
  profile: 'atum.app-history/1',
  app: { id: appId, app_version_id: version },
  entries: [
    {
      id: 'moon-message-1',
      revision: 1,
      occurred_at: '2026-10-12T01:02:03Z',
      role: 'owner',
      text: 'Earlier on Moon web',
      source: { id: 'web', label: { en: 'Moon web', vi: 'Moon web' } }
    }
  ],
  next_cursor: null,
  has_more: false,
  freshness_ms: 0
}

it('projects a closed app-history page', () => {
  expect(parseMatrixAppHistoryPage(page, appId, version)).toMatchObject({
    appId,
    appVersionId: version,
    entries: [{ source: { id: 'web' }, role: 'owner' }],
    hasMore: false
  })
})

it('rejects foreign authority, duplicate rows, and unknown fields', () => {
  expect(() => parseMatrixAppHistoryPage(page, '00000000-0000-4000-8000-b6a520472866', version)).toThrow()
  expect(() =>
    parseMatrixAppHistoryPage({ ...page, entries: [...page.entries, page.entries[0]] }, appId, version)
  ).toThrow()
  expect(() => parseMatrixAppHistoryPage({ ...page, provider_url: 'https://evil.test' }, appId, version)).toThrow()
})
