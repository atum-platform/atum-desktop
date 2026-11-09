import { expect, it } from 'vitest'

import {
  addressedAppBotRecipients,
  appBotGroupContent,
  appBotGroupMessageError,
  clearStoredAppBotRecipient,
  isEligibleAppBotQuote
} from './group-message'

const bots = [
  { appId: 'moon', userId: '@app-moon:test', displayName: 'Moon', handle: 'moon_bot' },
  { appId: 'andy', userId: '@app-andy:test', displayName: 'Andy', handle: 'andy_bot' }
]

it('addresses official bots through ordinary mentions and replies', () => {
  expect(addressedAppBotRecipients('hey @Moon', undefined, bots).map(bot => bot.appId)).toEqual(['moon'])
  expect(addressedAppBotRecipients('hey @andy_bot', undefined, bots).map(bot => bot.appId)).toEqual(['andy'])
  expect(addressedAppBotRecipients('following up', '@app-moon:test', bots).map(bot => bot.appId)).toEqual(['moon'])
  expect(addressedAppBotRecipients('hello everyone', '@human:test', bots)).toEqual([])
})

it('does not guess between bots with the same display name', () => {
  const ambiguous = [bots[0]!, { ...bots[1]!, displayName: 'Moon' }]

  expect(addressedAppBotRecipients('@Moon hello', undefined, ambiguous)).toEqual([])
  expect(addressedAppBotRecipients('@andy_bot hello', undefined, ambiguous).map(bot => bot.appId)).toEqual(['andy'])
})

it('does not route a display-name collision with a human or local assistant to a bot', () => {
  const roomRecipients = [
    { userId: '@human:test', name: 'Moon' },
    { userId: '@assistant:test', name: 'Andy' }
  ]

  expect(addressedAppBotRecipients('@Moon hello', undefined, bots, roomRecipients)).toEqual([])
  expect(addressedAppBotRecipients('@Andy hello', undefined, bots, roomRecipients)).toEqual([])
  expect(addressedAppBotRecipients('@moon_bot hello', undefined, bots, roomRecipients).map(bot => bot.appId)).toEqual(['moon'])
})

it('clears a stored official-bot recipient even when the bot has left the room', () => {
  expect(clearStoredAppBotRecipient('moon', ['moon', 'andy'])).toBe('')
  expect(clearStoredAppBotRecipient('legacy-weather', ['moon', 'andy'])).toBe('legacy-weather')
})

it('uses UTF-16 limits and makes an explicit quote the visible reply target', () => {
  expect(appBotGroupMessageError({ body: '😀'.repeat(2_000), attachment: false, edited: false, decryptable: true })).toBeNull()
  expect(appBotGroupMessageError({ body: '😀'.repeat(2_001), attachment: false, edited: false, decryptable: true })).toBe('message_too_long')
  expect(appBotGroupContent('What about this?', { user_id: '@app-moon:test' }, '$quote', '$quote')).toMatchObject({
    'm.mentions': { user_ids: ['@app-moon:test'] },
    'm.relates_to': { 'm.in_reply_to': { event_id: '$quote' } },
    'io.atum.app_bot.quote': { v: 1, event_id: '$quote' }
  })
  expect(() => appBotGroupContent('Ask', { user_id: '@app-moon:test' }, '$reply', '$quote')).toThrow('app_bot_quote_invalid')
})

it('permits only a readable source message as an explicit quote', () => {
  expect(isEligibleAppBotQuote({ body: 'A real source', attachment: false, edited: false, decryptable: true, redacted: false })).toBe(true)
  expect(isEligibleAppBotQuote({ body: 'Changed', attachment: false, edited: true, decryptable: true, redacted: false })).toBe(false)
  expect(isEligibleAppBotQuote({ body: 'Gone', attachment: false, edited: false, decryptable: true, redacted: true })).toBe(false)
  expect(isEligibleAppBotQuote({ body: '\ud800', attachment: false, edited: false, decryptable: true, redacted: false })).toBe(false)
})
