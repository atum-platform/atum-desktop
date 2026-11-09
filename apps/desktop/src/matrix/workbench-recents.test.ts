import { beforeEach, describe, expect, it } from 'vitest'

import type { ConsumerBrowserTab } from '@/app/atum/consumer-browser'

import {
  activateMatrixWorkbenchRecentAccount,
  clearMatrixWorkbenchRecents,
  MATRIX_WORKBENCH_RECENT_LIMIT,
  matrixWorkbenchRecentFromBrowser,
  readMatrixWorkbenchRecents,
  recordMatrixWorkbenchRecent,
  redactWorkbenchRecentUrl
} from './workbench-recents'

const aliceRoom = { accountId: '@alice:test', roomId: '!one:test' }

beforeEach(() => window.localStorage.clear())

function browser(url: string, status: ConsumerBrowserTab['status'] = 'ready'): ConsumerBrowserTab {
  return { id: url, partition: `atum-consumer-browser-${url.length}`, status, title: `Page ${url}`, url }
}

describe('Matrix workbench recents', () => {
  it('records only completed browser navigation and strips credentials, queries, and fragments', () => {
    expect(matrixWorkbenchRecentFromBrowser(browser('https://example.com/', 'loading'))).toBeNull()
    expect(matrixWorkbenchRecentFromBrowser(browser('https://example.com/', 'blocked'))).toBeNull()
    expect(matrixWorkbenchRecentFromBrowser(browser('https://example.com/', 'error'))).toBeNull()

    const recent = matrixWorkbenchRecentFromBrowser(
      browser('https://alice:secret@example.com/private/path?access_token=top-secret#account')
    )

    expect(recent).toMatchObject({ kind: 'browser', url: 'https://example.com/private/path' })
    expect(JSON.stringify(recent)).not.toContain('alice')
    expect(JSON.stringify(recent)).not.toContain('secret')
    expect(JSON.stringify(recent)).not.toContain('access_token')
    expect(redactWorkbenchRecentUrl('javascript:alert(1)')).toBeNull()
  })

  it('keeps the newest twenty per account and room, moving a reopened page to the front', () => {
    activateMatrixWorkbenchRecentAccount(window.localStorage, aliceRoom.accountId)

    for (let index = 0; index < MATRIX_WORKBENCH_RECENT_LIMIT + 5; index += 1) {
      recordMatrixWorkbenchRecent(
        window.localStorage,
        aliceRoom,
        matrixWorkbenchRecentFromBrowser(browser(`https://example.com/page-${index}`), index)
      )
    }

    const bounded = readMatrixWorkbenchRecents(window.localStorage, aliceRoom)

    expect(bounded).toHaveLength(MATRIX_WORKBENCH_RECENT_LIMIT)
    expect(bounded[0]).toMatchObject({ url: 'https://example.com/page-24' })
    expect(bounded.at(-1)).toMatchObject({ url: 'https://example.com/page-5' })

    recordMatrixWorkbenchRecent(
      window.localStorage,
      aliceRoom,
      matrixWorkbenchRecentFromBrowser(browser('https://example.com/page-10?new=secret'), 100)
    )

    const reopened = readMatrixWorkbenchRecents(window.localStorage, aliceRoom)

    expect(reopened).toHaveLength(MATRIX_WORKBENCH_RECENT_LIMIT)
    expect(reopened[0]).toMatchObject({ openedAt: 100, url: 'https://example.com/page-10' })
    expect(reopened.filter(row => row.kind === 'browser' && row.url.endsWith('/page-10'))).toHaveLength(1)
  })

  it('fences rooms and accounts, deletes the outgoing account on switch, and clears on sign-out', () => {
    const aliceOtherRoom = { ...aliceRoom, roomId: '!two:test' }
    const bobRoom = { accountId: '@bob:test', roomId: '!one:test' }

    activateMatrixWorkbenchRecentAccount(window.localStorage, aliceRoom.accountId)
    recordMatrixWorkbenchRecent(
      window.localStorage,
      aliceRoom,
      matrixWorkbenchRecentFromBrowser(browser('https://alice.example/one'))
    )
    recordMatrixWorkbenchRecent(
      window.localStorage,
      aliceOtherRoom,
      matrixWorkbenchRecentFromBrowser(browser('https://alice.example/two'))
    )

    expect(readMatrixWorkbenchRecents(window.localStorage, aliceRoom)).toHaveLength(1)
    expect(readMatrixWorkbenchRecents(window.localStorage, aliceOtherRoom)).toHaveLength(1)
    expect(readMatrixWorkbenchRecents(window.localStorage, bobRoom)).toEqual([])

    activateMatrixWorkbenchRecentAccount(window.localStorage, bobRoom.accountId)

    expect(readMatrixWorkbenchRecents(window.localStorage, aliceRoom)).toEqual([])
    expect(readMatrixWorkbenchRecents(window.localStorage, aliceOtherRoom)).toEqual([])
    recordMatrixWorkbenchRecent(
      window.localStorage,
      bobRoom,
      matrixWorkbenchRecentFromBrowser(browser('https://bob.example/'))
    )
    expect(readMatrixWorkbenchRecents(window.localStorage, bobRoom)).toHaveLength(1)

    clearMatrixWorkbenchRecents(window.localStorage)
    expect(readMatrixWorkbenchRecents(window.localStorage, bobRoom)).toEqual([])
  })
})
