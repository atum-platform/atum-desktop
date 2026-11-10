import { describe, expect, it } from 'vitest'

import { chatRowHandle } from './person-handle-line'

describe('a direct chat row\'s handle line', () => {
  it('says who an empty chat is with', () => {
    expect(chatRowHandle({ handle: 'poon_nguyen', hasMessages: false, name: 'Poon Nguyen' })).toBe('@poon_nguyen')
    expect(chatRowHandle({ handle: '@poon_nguyen', hasMessages: false, name: 'Poon Nguyen' })).toBe('@poon_nguyen')
  })

  it('gives way to the latest message once anyone has written', () => {
    expect(chatRowHandle({ handle: 'poon_nguyen', hasMessages: true, name: 'Poon Nguyen' })).toBeUndefined()
  })

  it('still shows while searching, chat or no chat', () => {
    expect(chatRowHandle({ handle: 'poon_nguyen', hasMessages: true, name: 'Poon Nguyen', searching: true })).toBe(
      '@poon_nguyen'
    )
  })

  it('shows nothing without a vouched handle, or when it only repeats the name', () => {
    expect(chatRowHandle({ handle: undefined, hasMessages: false, name: 'Lan' })).toBeUndefined()
    expect(chatRowHandle({ handle: null, hasMessages: false, name: 'Lan' })).toBeUndefined()
    expect(chatRowHandle({ handle: 'not a handle!', hasMessages: false, name: 'Lan' })).toBeUndefined()
    expect(chatRowHandle({ handle: 'lan', hasMessages: false, name: '@lan' })).toBeUndefined()
  })
})
