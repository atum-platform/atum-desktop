import { describe, expect, it } from 'vitest'

import type { AppDescriptor } from '../../../shared/app-catalog'
import type { MatrixMessage } from '../../../shared/matrix'

import {
  authorizedBotApi,
  botApiAppForMessage,
  isBotApiRoom,
  parseBotApiMessage,
  safeBotApiButtonUrl
} from './bot-api'

const botUser = '@app-moon:atumplatform.com'
const botId = '00000000-0000-4000-8000-f6222a1106ee'

function metadata(overrides: Record<string, unknown> = {}) {
  return {
    version: 'io.atum.bot_api/1',
    bot_id: botId,
    public_message_id: 43,
    fallback_text: 'Sign in: https://moon.example/sign-in',
    ...overrides
  }
}

function content(overrides: Record<string, unknown> = {}) {
  return { 'io.atum.bot_api': metadata(overrides) }
}

function parsed(input: { content?: unknown; formattedBody?: unknown; own?: boolean; sender?: string } = {}) {
  return parseBotApiMessage({
    sender: input.sender ?? botUser,
    own: input.own ?? false,
    content: input.content ?? content(),
    ...(input.formattedBody === undefined ? {} : { formattedBody: input.formattedBody })
  })
}

const app: AppDescriptor = {
  app: 'moon',
  app_id: '00000000-0000-4000-8000-b454f82c5857',
  app_version_id: '00000000-0000-4000-8000-de565f21842a',
  name: { en: 'Moon' },
  subtitle: null,
  description: null,
  icon: null,
  accent: null,
  affiliation: null,
  verified: true,
  availability: 'available',
  roster_default: true,
  roster_order: 1,
  supported_modes: ['direct'],
  has_surface: true,
  link: { mode: 'external_account', state: 'linked' },
  bot: {
    v: 1,
    user_id: botUser,
    handle: 'moon_bot',
    display_name: 'Moon',
    avatar: { url: 'https://cdn.example/a.png', sha256: 'a'.repeat(64) },
    device_generation: 1,
    device: { device_id: 'BOT', ed25519: 'a'.repeat(43), curve25519: 'b'.repeat(43) },
    state: 'active',
    groups: false,
    consent: 'accepted',
    disclosure_version: 1,
    open_route_id: 'chat',
    open_shared_memory: false,
    purchase_route_id: 'top-up'
  }
}

function message(overrides: Partial<MatrixMessage> = {}): MatrixMessage {
  return {
    id: '$bot-message',
    sender: botUser,
    body: 'Choose one',
    timestamp: 1,
    own: false,
    encrypted: false,
    decryptionFailed: false,
    pending: false,
    failed: false,
    attachment: false,
    ...overrides
  }
}

describe('bot-api metadata', () => {
  it('accepts the contract fixture and keeps only what the window may draw', () => {
    const value = parsed({ formattedBody: 'Choose <strong>one</strong>' })

    expect(value).toEqual({
      version: 'io.atum.bot_api/1',
      botId,
      publicMessageId: 43,
      fallbackText: 'Sign in: https://moon.example/sign-in',
      formattedBody: 'Choose <strong>one</strong>'
    })
  })

  it('rejects metadata from anyone but an official bot user', () => {
    expect(parsed({ sender: '@owner:test' })).toBeUndefined()
    expect(parsed({ sender: '@linh:test' })).toBeUndefined()
    expect(parsed({ sender: '@app-moon:atumplatform.com', own: true })).toBeUndefined()
  })

  it('rejects an unknown version, unknown field, or out-of-bounds value as a whole', () => {
    expect(parsed({ content: content({ version: 'io.atum.bot_api/2' }) })).toBeUndefined()
    expect(parsed({ content: content({ extra: 1 }) })).toBeUndefined()
    expect(parsed({ content: content({ public_message_id: 0 }) })).toBeUndefined()
    // Empty keyboards and stale/future fields make the metadata inert while the ordinary
    // Matrix message remains available to its caller.
    expect(parsed({ content: content({ keyboard: [] }) })).toBeUndefined()
    expect(parsed({ content: content({ fallback_text: '' }) })).toBeUndefined()
  })

  it('accepts one bounded photo and its caption', () => {
    const value = parsed({
      content: content({
        photo: {
          file_ref: 'mref_0123456789abcdef',
          width: 1280,
          height: 960,
          mime_type: 'image/jpeg',
          caption: 'Please inspect this'
        }
      })
    })

    expect(value?.photo).toEqual({
      fileRef: 'mref_0123456789abcdef',
      width: 1280,
      height: 960,
      mimeType: 'image/jpeg',
      caption: 'Please inspect this'
    })
  })

  it('accepts bounded HTTPS URL-button rows and keeps their layout', () => {
    const keyboard = [
      [
        { label: 'Sign in', kind: 'url', url: 'https://moon.example/sign-in#continue' },
        { label: 'Learn more', kind: 'url', url: 'https://moon.example/about' }
      ],
      [{ label: 'Privacy', kind: 'url', url: 'https://moon.example/privacy' }]
    ]

    expect(parsed({ content: content({ keyboard }) })?.keyboard).toEqual(keyboard)
    expect(safeBotApiButtonUrl('https://moon.example:8443/sign-in#continue')).toBe(
      'https://moon.example:8443/sign-in#continue'
    )
  })

  it('rejects callbacks, unsafe URLs and out-of-bounds URL keyboards as a whole', () => {
    const invalid = [
      [[{ label: 'Run', kind: 'callback', url: 'https://moon.example/run' }]],
      [[{ label: 'Open', kind: 'url', url: 'http://moon.example/open' }]],
      [[{ label: 'Open', kind: 'url', url: 'https://user:secret@moon.example/open' }]],
      [[{ label: 'Open', kind: 'url', url: 'https://moon.example/open', callback_data: 'x' }]],
      [[{ label: 'x'.repeat(65), kind: 'url', url: 'https://moon.example/open' }]],
      [Array.from({ length: 5 }, () => ({ label: 'Open', kind: 'url', url: 'https://moon.example/open' }))],
      Array.from({ length: 9 }, () => [{ label: 'Open', kind: 'url', url: 'https://moon.example/open' }])
    ]

    for (const keyboard of invalid) {
      expect(parsed({ content: content({ keyboard }) })).toBeUndefined()
    }
  })

  it('drops an oversized formatted body', () => {
    expect(parsed({ formattedBody: 'x'.repeat(16_385) })).toBeUndefined()
  })
})

describe('bot-api authorization and room version', () => {
  it('renders only the catalog app bot’s own message', () => {
    expect(botApiAppForMessage([app], { sender: botUser })?.app).toBe('moon')
    expect(botApiAppForMessage([app], { sender: '@linh:test' })).toBeUndefined()
    expect(authorizedBotApi(app, message({ botApi: parsed()! }), false)?.publicMessageId).toBe(43)
    expect(authorizedBotApi(app, message({ sender: '@linh:test', botApi: parsed()! }), false)).toBeUndefined()
    expect(authorizedBotApi(undefined, message({ botApi: parsed()! }), false)).toBeUndefined()
  })

  it('requires native pinned-device evidence in an encrypted room', () => {
    const value = message({ botApi: parsed()!, encrypted: true })

    expect(authorizedBotApi(app, value, true)).toBeUndefined()
    expect(
      authorizedBotApi(app, { ...value, appBot: { appId: app.app_id, kind: 'reply', authenticated: true } }, true)
        ?.publicMessageId
    ).toBe(43)
    expect(
      authorizedBotApi(app, { ...value, appBot: { appId: 'other', kind: 'reply', authenticated: true } }, true)
    ).toBeUndefined()
  })

  it('keeps a legacy room legacy and ignores an unknown official-shaped sender', () => {
    expect(isBotApiRoom([], [app], false)).toBe(false)
    expect(isBotApiRoom([message()], [app], false)).toBe(false)
    expect(isBotApiRoom([message({ botApi: parsed()! })], [app], false)).toBe(true)
    expect(
      isBotApiRoom([message({ sender: '@app-fake:test', botApi: parsed({ sender: '@app-fake:test' })! })], [app], false)
    ).toBe(false)
    expect(isBotApiRoom([message({ botApi: parsed()! })], undefined, false)).toBe(false)
  })

  it('uses signed Bot API mode before the first reply only in the app’s exact direct room', () => {
    const botApiApp: AppDescriptor = { ...app, bot: { ...app.bot!, transport_mode: 'bot_api' } }
    const room = {
      direct: true,
      membership: 'join',
      participants: [
        { userId: '@owner:test', membership: 'join' },
        { userId: botUser, membership: 'invite' }
      ]
    }
    const context = { room, ownUserId: '@owner:test' }

    expect(isBotApiRoom([], [botApiApp], false, context)).toBe(true)
    expect(isBotApiRoom([], [app], false, context)).toBe(false)
    expect(isBotApiRoom([], [botApiApp], false, { ...context, room: { ...room, direct: false } })).toBe(false)
    expect(
      isBotApiRoom([], [botApiApp], false, {
        ...context,
        room: {
          ...room,
          participants: [...room.participants, { userId: '@linh:test', membership: 'join' }]
        }
      })
    ).toBe(false)
  })

  it('does not switch an encrypted room without the H1 native display evidence', () => {
    const value = message({ botApi: parsed()!, encrypted: true })

    expect(isBotApiRoom([value], [app], true)).toBe(false)
    expect(
      isBotApiRoom([{ ...value, appBot: { appId: app.app_id, kind: 'reply', authenticated: true } }], [app], true)
    ).toBe(true)
  })
})
