import { describe, expect, it } from 'vitest'

import { APP_VIEW_IPC } from '../../shared/app-view/ipc'
import { ATUM_MAILBOXES, atumMailLink } from '../../shared/atum-company'
import { MATRIX_MAX_FILE_BYTES } from '../../shared/matrix'

import { matrixConfigurationKey, parseMatrixConfig } from './config'
import {
  matrixAppViewCommandAllowed,
  matrixAtumMail,
  matrixExternalLink,
  matrixOpenLink,
  matrixPdfBelowTitlebar,
  parseMatrixCommand,
  parseMatrixNewSignInDismiss,
  parseMatrixSignInMethod,
  parseMatrixTurnReply,
  parseMatrixUseAtumModel,
  requireMatrixCaller
} from './ipc-policy'

describe('Matrix boundary', () => {
  it('takes only the three ways into an account, Google when a window does not say', () => {
    expect(parseMatrixSignInMethod(undefined)).toBe('google')

    for (const method of ['google', 'email', 'create'] as const) {
      expect(parseMatrixSignInMethod(method)).toBe(method)
    }

    for (const value of ['password', 'https://evil.example/authorize', null, 1, { method: 'email' }]) {
      expect(() => parseMatrixSignInMethod(value)).toThrow('matrix_command_invalid')
    }
  })
  it('acknowledges only the device the new sign-in banner is showing, in a ready account', () => {
    const identity = { userId: '@owner:test', deviceId: 'THIS_MAC' }
    const shown = { deviceId: 'LAPTOP', name: 'MacBook Air' }

    expect(parseMatrixNewSignInDismiss({ closing: false, ready: true, identity, shown, deviceId: 'LAPTOP' })).toEqual({
      identity,
      deviceId: 'LAPTOP'
    })

    const invalid: Array<Parameters<typeof parseMatrixNewSignInDismiss>[0]> = [
      { closing: true, ready: true, identity, shown, deviceId: 'LAPTOP' },
      { closing: false, ready: false, identity, shown, deviceId: 'LAPTOP' },
      { closing: false, ready: true, identity: undefined, shown, deviceId: 'LAPTOP' },
      { closing: false, ready: true, identity, shown, deviceId: 'PHONE' },
      { closing: false, ready: true, identity, shown: undefined, deviceId: 'LAPTOP' },
      { closing: false, ready: true, identity, shown, deviceId: '' },
      { closing: false, ready: true, identity, shown, deviceId: 'LAP\nTOP' },
      { closing: false, ready: true, identity, shown, deviceId: `D${'a'.repeat(255)}` },
      { closing: false, ready: true, identity, shown, deviceId: 42 }
    ]

    for (const input of invalid) {
      expect(() => parseMatrixNewSignInDismiss(input)).toThrow('matrix_command_invalid')
    }
  })

  it("takes going back to Atum's AI with nothing else: no agent, model, endpoint or key from the window", () => {
    expect(parseMatrixUseAtumModel({ kind: 'useAtumModel' })).toEqual({ kind: 'useAtumModel' })

    for (const value of [
      { kind: 'useAtumModel', principal: 'agent-2' },
      { kind: 'useAtumModel', model: 'other/model' },
      { kind: 'useAtumModel', baseUrl: 'https://evil.example/v1' },
      { kind: 'useAtumModel', apiKey: 'sk-synthetic' },
      { kind: 'useAtumModel', roomId: '!room:test' },
      { kind: 'useAtumModel', locale: undefined },
      { kind: 'setModel' },
      ['useAtumModel'],
      null,
      'useAtumModel'
    ]) {
      expect(() => parseMatrixUseAtumModel(value)).toThrow('matrix_command_invalid')
    }
  })
  it('opens only plain web links from rendered messages, never files, app schemes or embedded credentials', () => {
    expect(matrixExternalLink('https://example.com/a?b=1#c')).toBe('https://example.com/a?b=1#c')
    expect(matrixExternalLink('http://example.com')).toBe('http://example.com/')

    for (const link of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'atum-matrix://ui/index.html',
      'x-apple.systempreferences:com.apple.preference',
      'mailto:someone@example.com',
      'https://user:secret@example.com/',
      'not a url',
      '',
      `https://example.com/${'a'.repeat(5000)}`,
      42
    ]) {
      expect(() => matrixExternalLink(link)).toThrow('matrix_link_invalid')
    }
  })

  it("starts a bounded message email, while Atum account actions remain pinned to Atum's mailboxes", () => {
    const privacy = ATUM_MAILBOXES.privacy
    const draft = `mailto:${privacy}?subject=Delete%20my%20Atum%20account&body=Atum%20ID%3A%20%40minh%3Aexample.test`

    expect(matrixAtumMail(draft)).toBe(draft)
    expect(matrixOpenLink(draft)).toBe(draft)
    expect(matrixOpenLink(`mailto:${ATUM_MAILBOXES.support}`)).toBe(`mailto:${ATUM_MAILBOXES.support}`)
    expect(matrixOpenLink('mailto:someone@example.com?subject=Hello')).toBe('mailto:someone@example.com?subject=Hello')
    expect(() => matrixAtumMail('mailto:someone@example.com')).toThrow('matrix_link_invalid')
    // A web link still opens as a web link, under the same rules as before.
    expect(matrixOpenLink('https://example.com/a')).toBe('https://example.com/a')

    // What a window composes (Settings › Delete my account), in any language, main opens as it is.
    for (const [subject, body] of [
      ['Yêu cầu xóa tài khoản Atum', 'Vui lòng xóa tài khoản Atum của tôi.\n\nID Atum: @minh:example.test'],
      ['Atum アカウントの削除依頼', 'Atum アカウントを削除してください。\n\nAtum ID: @minh:example.test'],
      ["Delete my Atum account (it's mine) & more", 'Please delete it: 100% sure? #yes +1']
    ]) {
      const composed = atumMailLink('privacy', subject!, body)
      const opened = new URL(matrixOpenLink(composed))

      expect(opened.href).toBe(composed)
      expect(opened.searchParams.get('subject')).toBe(subject)
      expect(opened.searchParams.get('body')).toBe(body)
    }

    for (const link of [
      `mailto:${privacy},someone@example.com`,
      `mailto:${privacy}%2Csomeone@example.com`,
      `mailto:${privacy}?to=someone@example.com`,
      `mailto:${privacy}?cc=someone@example.com`,
      `mailto:${privacy}?bcc=someone@example.com`,
      `mailto:${privacy}?attach=/etc/passwd`,
      `mailto:${privacy}?subject=one&subject=two`,
      `mailto:${privacy}#more`,
      `mailto:?to=${privacy}`,
      `mailto:${privacy}?body=${'a'.repeat(5000)}`,
      'file:///etc/passwd',
      'https://user:secret@example.com/',
      42
    ]) {
      expect(() => matrixOpenLink(link)).toThrow('matrix_link_invalid')
    }
  })

  it('keeps detach, close and geometry reachable offline but denies new opens/reloads', () => {
    for (const channel of [APP_VIEW_IPC.close, APP_VIEW_IPC.visibility, APP_VIEW_IPC.bounds, APP_VIEW_IPC.focus]) {
      expect(matrixAppViewCommandAllowed(channel, false)).toBe(true)
    }

    for (const channel of [APP_VIEW_IPC.open, APP_VIEW_IPC.reload]) {
      expect(matrixAppViewCommandAllowed(channel, false)).toBe(false)
      expect(matrixAppViewCommandAllowed(channel, true)).toBe(true)
    }

    expect(() => parseMatrixCommand({ kind: 'appCatalog', appIds: [] })).toThrow()
    expect(() =>
      parseMatrixCommand({ kind: 'publishGoogleFence', identity: { userId: '@foreign:test', deviceId: 'OTHER' } })
    ).toThrow()
    expect(parseMatrixCommand({ kind: 'selectApp', appId: '00000000-0000-4000-8000-4BB0C27AA34B' })).toEqual({
      kind: 'selectApp',
      appId: '00000000-0000-4000-8000-4bb0c27aa34b'
    })
  })
  it('accepts only the fixed notes-to-self lazy action without renderer room authority', () => {
    expect(parseMatrixCommand({ kind: 'notesSelfOpen' })).toEqual({ kind: 'notesSelfOpen' })
    expect(parseMatrixCommand({ kind: 'notesSelfOpen', companyId: '00000000-0000-4000-8000-576f18824476' }))
      .toEqual({ kind: 'notesSelfOpen', companyId: '00000000-0000-4000-8000-576f18824476' })
    expect(() => parseMatrixCommand({ kind: 'notesSelfOpen', roomId: '!spoof:test' }))
      .toThrow('matrix_command_invalid')
    expect(() => parseMatrixCommand({ kind: 'notesSelfOpen', companyId: 'not-a-company' }))
      .toThrow('matrix_command_invalid')
  })
  it('admits only a room-scoped request for the fixed timeline page', () => {
    expect(
      parseMatrixCommand({ kind: 'paginateTimeline', roomId: '!r:test', limit: 50, query: 'private words' })
    ).toEqual({ kind: 'paginateTimeline', roomId: '!r:test' })

    for (const roomId of [undefined, '', 'r:test', '!'.repeat(1025), 42]) {
      expect(() => parseMatrixCommand({ kind: 'paginateTimeline', roomId })).toThrow('matrix_command_invalid')
    }
  })
  it('allows only a boolean low priority on a bounded room ID, never arbitrary tags', () => {
    expect(
      parseMatrixCommand({ kind: 'lowPriority', roomId: '!r:test', lowPriority: true, tag: 'u.other', order: 1 })
    ).toEqual({ kind: 'lowPriority', roomId: '!r:test', lowPriority: true })

    for (const value of [
      { kind: 'lowPriority', roomId: '!r:test', lowPriority: 'true' },
      { kind: 'lowPriority', roomId: '!r:test' },
      { kind: 'lowPriority', roomId: 'invalid', lowPriority: false }
    ]) {
      expect(() => parseMatrixCommand(value)).toThrow('matrix_command_invalid')
    }
  })
  it('limits a person report to a room, a valid user id and one bounded reason line', () => {
    expect(
      parseMatrixCommand({ kind: 'reportUser', roomId: '!r:test', userId: '@bob:test', reason: 'spam', score: -100 })
    ).toEqual({ kind: 'reportUser', roomId: '!r:test', userId: '@bob:test', reason: 'spam' })
    expect(parseMatrixCommand({ kind: 'reportUser', roomId: '!r:test', userId: '@bob:test' })).toEqual({
      kind: 'reportUser',
      roomId: '!r:test',
      userId: '@bob:test'
    })

    for (const value of [
      { kind: 'reportUser', roomId: '!r:test' },
      { kind: 'reportUser', roomId: '!r:test', userId: '@broken' },
      { kind: 'reportUser', roomId: 'all', userId: '@bob:test' },
      { kind: 'reportUser', roomId: '!r:test', userId: '@bob:test', reason: 'x'.repeat(501) }
    ]) {
      expect(() => parseMatrixCommand(value)).toThrow('matrix_command_invalid')
    }
  })
  it('allows only a boolean favourite on a bounded room ID, never arbitrary tags or another account', () => {
    expect(
      parseMatrixCommand({
        kind: 'favourite',
        roomId: '!r:test',
        favourite: true,
        userId: '@victim:test',
        tag: 'u.other',
        order: 1
      })
    ).toEqual({ kind: 'favourite', roomId: '!r:test', favourite: true })

    for (const value of [
      { kind: 'favourite', roomId: '!r:test', favourite: 'true' },
      { kind: 'favourite', roomId: '!r:test' },
      { kind: 'favourite', roomId: 'invalid', favourite: true },
      { kind: 'setRoomTag', roomId: '!r:test', tag: 'm.favourite' }
    ]) {
      expect(() => parseMatrixCommand(value)).toThrow('matrix_command_invalid')
    }
  })
  it("sets only a served model on a bounded room ID, never another key or someone else's data", () => {
    expect(
      parseMatrixCommand({
        kind: 'setModel',
        roomId: '!r:test',
        model: 'nhat-thuc',
        userId: '@victim:test',
        type: 'm.other'
      })
    ).toEqual({ kind: 'setModel', roomId: '!r:test', model: 'nhat-thuc' })

    for (const value of [
      { kind: 'setModel', roomId: '!r:test', model: 'thai-cuc' },
      { kind: 'setModel', roomId: '!r:test', model: 'binh-minh' },
      { kind: 'setModel', roomId: '!r:test' },
      { kind: 'setModel', roomId: 'invalid', model: 'nguyet-thuc' },
      // No "max" yet, and an unknown level never rides along with a valid model.
      { kind: 'setModel', roomId: '!r:test', effort: 'max' },
      { kind: 'setModel', roomId: '!r:test', model: 'nhat-thuc', effort: 'xhigh' },
      { kind: 'setModel', roomId: '!r:test', effort: null }
    ]) {
      expect(() => parseMatrixCommand(value)).toThrow('matrix_command_invalid')
    }

    // A thinking level alone, or with the model.
    expect(parseMatrixCommand({ kind: 'setModel', roomId: '!r:test', effort: 'high' })).toEqual({
      kind: 'setModel',
      roomId: '!r:test',
      effort: 'high'
    })
    expect(parseMatrixCommand({ kind: 'setModel', roomId: '!r:test', model: 'nguyet-thuc', effort: 'low' })).toEqual({
      kind: 'setModel',
      roomId: '!r:test',
      model: 'nguyet-thuc',
      effort: 'low'
    })
  })
  it("resends or drops only an unsent local echo of the owner's, by room and local id, nothing else", () => {
    for (const kind of ['resend', 'discard'] as const) {
      expect(
        parseMatrixCommand({ kind, roomId: '!r:test', eventId: '~!r:test:m1', body: 'other text', userId: '@x:test' })
      ).toEqual({ kind, roomId: '!r:test', eventId: '~!r:test:m1' })

      for (const value of [
        { kind, roomId: '!r:test', eventId: '$server-event' },
        { kind, roomId: '!r:test' },
        { kind, roomId: 'invalid', eventId: '~!r:test:m1' },
        { kind, roomId: '!r:test', eventId: `~${'x'.repeat(2048)}` }
      ]) {
        expect(() => parseMatrixCommand(value)).toThrow('matrix_command_invalid')
      }
    }
  })
  it("mutes only by a boolean on a bounded room, never someone else's push rules", () => {
    expect(
      parseMatrixCommand({
        kind: 'mute',
        roomId: '!r:test',
        muted: true,
        rule: { actions: ['notify'] },
        scope: 'device'
      })
    ).toEqual({ kind: 'mute', roomId: '!r:test', muted: true })

    for (const value of [
      { kind: 'mute', roomId: '!r:test', muted: 'yes' },
      { kind: 'mute', roomId: '!r:test' },
      { kind: 'mute', roomId: 'invalid', muted: false }
    ]) {
      expect(() => parseMatrixCommand(value)).toThrow('matrix_command_invalid')
    }
  })
  it('names a group and sets its topic with one bounded line each; a name is never empty', () => {
    expect(parseMatrixCommand({ kind: 'groupName', roomId: '!g:test', name: '  Weekend\n trip ', topic: 'x' })).toEqual({
      kind: 'groupName',
      roomId: '!g:test',
      name: 'Weekend trip'
    })
    expect(parseMatrixCommand({ kind: 'groupTopic', roomId: '!g:test', topic: ' Plans\tfor Saturday ' })).toEqual({
      kind: 'groupTopic',
      roomId: '!g:test',
      topic: 'Plans for Saturday'
    })
    // An empty topic clears it.
    expect(parseMatrixCommand({ kind: 'groupTopic', roomId: '!g:test', topic: '  ' })).toEqual({
      kind: 'groupTopic',
      roomId: '!g:test',
      topic: ''
    })
    expect(parseMatrixCommand({ kind: 'groupTopic', roomId: '!g:test', topic: 'đ'.repeat(500) })).toMatchObject({
      topic: 'đ'.repeat(500)
    })

    for (const value of [
      { kind: 'groupName', roomId: '!g:test', name: '   ' },
      { kind: 'groupName', roomId: '!g:test', name: 'x'.repeat(81) },
      { kind: 'groupName', roomId: '!g:test' },
      { kind: 'groupName', roomId: 'invalid', name: 'Trip' },
      { kind: 'groupTopic', roomId: '!g:test', topic: 'x'.repeat(501) },
      { kind: 'groupTopic', roomId: '!g:test', topic: 7 },
      { kind: 'groupTopic', roomId: '!g:test', name: 'Trip' }
    ]) {
      expect(() => parseMatrixCommand(value)).toThrow('matrix_command_invalid')
    }
  })
  it("names a chat with one bounded line of the owner's own, and an empty name clears it", () => {
    expect(
      parseMatrixCommand({ kind: 'chatTitle', roomId: '!r:test', title: '  Trip\n\tplans  ', type: 'm.room.name' })
    ).toEqual({ kind: 'chatTitle', roomId: '!r:test', title: 'Trip plans' })
    expect(parseMatrixCommand({ kind: 'chatTitle', roomId: '!r:test', title: '   ' })).toEqual({
      kind: 'chatTitle',
      roomId: '!r:test',
      title: ''
    })
    // Bounded by what a person sees (characters), not bytes.
    expect(parseMatrixCommand({ kind: 'chatTitle', roomId: '!r:test', title: 'đ'.repeat(80) })).toMatchObject({
      title: 'đ'.repeat(80)
    })

    for (const value of [
      { kind: 'chatTitle', roomId: '!r:test', title: 'x'.repeat(81) },
      { kind: 'chatTitle', roomId: '!r:test', title: 'x'.repeat(2000) },
      { kind: 'chatTitle', roomId: '!r:test' },
      { kind: 'chatTitle', roomId: '!r:test', title: 7 },
      { kind: 'chatTitle', roomId: 'invalid', title: 'Trip' }
    ]) {
      expect(() => parseMatrixCommand(value)).toThrow('matrix_command_invalid')
    }
  })
  it('admits only the frozen personal room-look account-data records', () => {
    for (const look of [
      { v: 1, background: { kind: 'default' } },
      { v: 1, background: { kind: 'none' } },
      { v: 1, background: { kind: 'pack', pack_id: '00000000-0000-4000-8000-177920da9661' } }
    ]) {
      expect(parseMatrixCommand({ kind: 'chatLook', roomId: '!r:test', look })).toEqual({
        kind: 'chatLook',
        roomId: '!r:test',
        look
      })
    }

    for (const look of [
      { v: 2, background: { kind: 'default' } },
      { v: 1, background: { kind: 'future' } },
      { v: 1, background: { kind: 'pack', pack_id: '../escape' } },
      { v: 1, background: { kind: 'default', shared: true } }
    ]) {
      expect(() => parseMatrixCommand({ kind: 'chatLook', roomId: '!r:test', look })).toThrow(
        'matrix_command_invalid'
      )
    }
  })
  it("admits Matrix's own message features by room and event only, never extra authority or another shape", () => {
    // A reply names an event; edits, deletion and reactions name the room and the event.
    expect(
      parseMatrixCommand({
        kind: 'send',
        roomId: '!r:test',
        body: 'Yes',
        replyTo: '$m',
        format: 'org.matrix.custom.html'
      })
    ).toEqual({ kind: 'send', roomId: '!r:test', body: 'Yes', replyTo: '$m' })
    // Who a message names (an assistant in a group): Matrix user IDs, once each; none, none.
    expect(
      parseMatrixCommand({ kind: 'send', roomId: '!r:test', body: '@Atum hi', mentions: ['@atum:test', '@atum:test'] })
    ).toEqual({ kind: 'send', roomId: '!r:test', body: '@Atum hi', mentions: ['@atum:test'] })
    expect(parseMatrixCommand({ kind: 'send', roomId: '!r:test', body: 'hi', mentions: [] })).toEqual({
      kind: 'send',
      roomId: '!r:test',
      body: 'hi'
    })
    expect(
      parseMatrixCommand({
        kind: 'send',
        roomId: '!r:test',
        body: 'In the thread',
        threadRootId: '$root',
        replyTo: '$reply',
        audience: ['@outsider:test']
      })
    ).toEqual({ kind: 'send', roomId: '!r:test', body: 'In the thread', threadRootId: '$root', replyTo: '$reply' })
    expect(
      parseMatrixCommand({
        kind: 'threadFollow',
        roomId: '!r:test',
        rootId: '$root',
        followed: true,
        userId: '@x:test'
      })
    ).toEqual({ kind: 'threadFollow', roomId: '!r:test', rootId: '$root', followed: true })
    expect(parseMatrixCommand({ kind: 'threadRead', roomId: '!r:test', rootId: '$root', receipt: 'public' })).toEqual({
      kind: 'threadRead',
      roomId: '!r:test',
      rootId: '$root'
    })
    expect(
      parseMatrixCommand({ kind: 'edit', roomId: '!r:test', eventId: '$m', body: 'New', sender: '@x:test' })
    ).toEqual({
      kind: 'edit',
      roomId: '!r:test',
      eventId: '$m',
      body: 'New'
    })
    expect(parseMatrixCommand({ kind: 'redact', roomId: '!r:test', eventId: '$m', reason: 'spam' })).toEqual({
      kind: 'redact',
      roomId: '!r:test',
      eventId: '$m'
    })
    expect(parseMatrixCommand({ kind: 'pinMessage', roomId: '!r:test', eventId: '$m', pinned: true })).toEqual({
      kind: 'pinMessage',
      roomId: '!r:test',
      eventId: '$m',
      pinned: true
    })
    expect(parseMatrixCommand({ kind: 'react', roomId: '!r:test', eventId: '$m', key: '👍', reacted: true })).toEqual({
      kind: 'react',
      roomId: '!r:test',
      eventId: '$m',
      key: '👍',
      reacted: true
    })
    expect(parseMatrixCommand({ kind: 'savedMessage', roomId: '!r:test', eventId: '$m', saved: true })).toEqual({
      kind: 'savedMessage', roomId: '!r:test', eventId: '$m', saved: true
    })
    expect(parseMatrixCommand({ kind: 'savedMessagesRead' })).toEqual({ kind: 'savedMessagesRead' })
    expect(parseMatrixCommand({ kind: 'savedMessageOpen', roomId: '!r:test', eventId: '$m' })).toEqual({
      kind: 'savedMessageOpen', roomId: '!r:test', eventId: '$m'
    })
    expect(parseMatrixCommand({
      kind: 'draft',
      identity: { userId: '@owner:test', deviceId: 'DEVICE' },
      roomId: '!r:test',
      threadRootId: '$root',
      text: 'Keep this private'
    })).toEqual({
      kind: 'draft',
      identity: { userId: '@owner:test', deviceId: 'DEVICE' },
      roomId: '!r:test',
      threadRootId: '$root',
      text: 'Keep this private'
    })
    // A family emoji is several code points, still one reaction.
    expect(
      parseMatrixCommand({ kind: 'react', roomId: '!r:test', eventId: '$m', key: '👨‍👩‍👧‍👦', reacted: false })
    ).toMatchObject({
      key: '👨‍👩‍👧‍👦'
    })
    expect(parseMatrixCommand({ kind: 'forget', roomId: '!r:test', userId: '@x:test' })).toEqual({
      kind: 'forget',
      roomId: '!r:test'
    })
    expect(parseMatrixCommand({ kind: 'typing', roomId: '!r:test', typing: true, timeout: 999_999 })).toEqual({
      kind: 'typing',
      roomId: '!r:test',
      typing: true
    })
    expect(parseMatrixCommand({ kind: 'markUnread', roomId: '!r:test', unread: false })).toEqual({
      kind: 'markUnread',
      roomId: '!r:test',
      unread: false
    })

    for (const command of [
      { kind: 'send', roomId: '!r:test', body: 'Yes', replyTo: 'm' },
      { kind: 'send', roomId: '!r:test', body: 'Yes', replyTo: '' },
      { kind: 'send', roomId: '!r:test', body: 'Yes', threadRootId: 'root' },
      { kind: 'send', roomId: '!r:test', body: 'Yes', mentions: 'atum' },
      { kind: 'send', roomId: '!r:test', body: 'Yes', mentions: ['Atum'] },
      { kind: 'send', roomId: '!r:test', body: 'Yes', mentions: Array.from({ length: 11 }, (_, i) => `@a${i}:test`) },
      { kind: 'edit', roomId: '!r:test', eventId: '$m', body: '   ' },
      { kind: 'edit', roomId: '!r:test', eventId: '~local', body: 'New' },
      { kind: 'edit', roomId: '!r:test', eventId: '$m', body: 'x'.repeat(16001) },
      { kind: 'redact', roomId: '!r:test', eventId: '~local' },
      { kind: 'redact', roomId: 'r:test', eventId: '$m' },
      { kind: 'pinMessage', roomId: '!r:test', eventId: '$m' },
      { kind: 'pinMessage', roomId: '!r:test', eventId: '~local', pinned: true },
      { kind: 'react', roomId: '!r:test', eventId: '$m', key: '👍' },
      { kind: 'react', roomId: '!r:test', eventId: '$m', key: ' 👍', reacted: true },
      { kind: 'react', roomId: '!r:test', eventId: '$m', key: '', reacted: true },
      { kind: 'react', roomId: '!r:test', eventId: '$m', key: 'a\u0000', reacted: true },
      { kind: 'react', roomId: '!r:test', eventId: '$m', key: 'x'.repeat(65), reacted: true },
      { kind: 'forget' },
      { kind: 'forget', roomId: '#alias:test' },
      { kind: 'typing', roomId: '!r:test', typing: 'yes' },
      { kind: 'markUnread', roomId: '!r:test' },
      { kind: 'threadFollow', roomId: '!r:test', rootId: '$root', followed: 'yes' },
      { kind: 'threadFollow', roomId: '!r:test', rootId: '~local', followed: true },
      { kind: 'threadRead', roomId: '!r:test', rootId: 'root' },
      { kind: 'draft', identity: { userId: '@owner:test', deviceId: 'DEVICE' }, roomId: '!r:test', text: 'x'.repeat(16_385) },
      { kind: 'draft', identity: { userId: '@owner:test' }, roomId: '!r:test', text: 'draft' },
      { kind: 'draft', identity: { userId: '@owner:test', deviceId: 'DEVICE' }, roomId: '!r:test', threadRootId: 'root', text: 'draft' }
    ]) {
      expect(() => parseMatrixCommand(command)).toThrow('matrix_command_invalid')
    }
  })
  it('admits only bounded portable notification policy changes from the current renderer', () => {
    const identity = { userId: '@alice:test', deviceId: 'ONE' }

    expect(parseMatrixCommand({
      kind: 'notificationPolicy', identity, scope: 'account', level: 'mentions', extra: 'ignored'
    })).toEqual({ kind: 'notificationPolicy', identity, scope: 'account', level: 'mentions' })
    expect(parseMatrixCommand({
      kind: 'notificationPolicy', identity, scope: 'thread', roomId: '!launch:test', rootId: '$budget', level: 'nothing'
    })).toEqual({
      kind: 'notificationPolicy', identity, scope: 'thread', roomId: '!launch:test', rootId: '$budget', level: 'nothing'
    })
    expect(parseMatrixCommand({
      kind: 'notificationPolicy', identity, scope: 'quietHours', quietHours: {
        enabled: true, startMinute: 1_320, endMinute: 420, timeZone: 'Asia/Ho_Chi_Minh'
      }
    })).toEqual({
      kind: 'notificationPolicy', identity, scope: 'quietHours', quietHours: {
        enabled: true, startMinute: 1_320, endMinute: 420, timeZone: 'Asia/Ho_Chi_Minh'
      }
    })

    for (const command of [
      { kind: 'notificationPolicy', identity, scope: 'account', level: 'loud' },
      { kind: 'notificationPolicy', identity, scope: 'channel', roomId: '#launch:test', level: 'all' },
      { kind: 'notificationPolicy', identity, scope: 'thread', roomId: '!launch:test', rootId: '~local', level: 'all' },
      { kind: 'notificationPolicy', identity, scope: 'quietHours', quietHours: {
        enabled: true, startMinute: 1_440, endMinute: 420, timeZone: 'UTC'
      } },
      { kind: 'notificationPolicy', identity, scope: 'quietHours', quietHours: {
        enabled: true, startMinute: 1_320, endMinute: 420, timeZone: 'Mars/Base'
      } }
    ]) {
      expect(() => parseMatrixCommand(command)).toThrow('matrix_command_invalid')
    }
  })

  it("bounds a local turn's reply to an event and its quote, and treats no reply as an ordinary question", () => {
    expect(parseMatrixTurnReply(undefined)).toBeUndefined()
    expect(parseMatrixTurnReply({ eventId: '$a', quote: 'Here is a plan.', sender: '@x:test' })).toEqual({
      eventId: '$a',
      quote: 'Here is a plan.'
    })

    for (const reply of [
      null,
      'reply',
      { eventId: 'a', quote: 'x' },
      { eventId: '$a', quote: '   ' },
      { eventId: '$a', quote: 'x'.repeat(2001) },
      { eventId: '$a' },
      { quote: 'x' }
    ]) {
      expect(() => parseMatrixTurnReply(reply)).toThrow('matrix_command_invalid')
    }
  })

  it('keeps native PDF geometry below the titlebar at every zoom and rejects malformed coordinates', () => {
    expect(matrixPdfBelowTitlebar({ y: 40 }, 1)).toBe(true)
    expect(matrixPdfBelowTitlebar({ y: 40 }, 0.5)).toBe(false)
    expect(matrixPdfBelowTitlebar({ y: 80 }, 0.5)).toBe(true)
    expect(matrixPdfBelowTitlebar({ y: 20 }, 2)).toBe(true)

    for (const bounds of [null, {}, { y: '80' }, { y: Infinity }, { y: NaN }, { y: -1 }]) {
      expect(matrixPdfBelowTitlebar(bounds, 1)).toBe(false)
    }

    expect(matrixPdfBelowTitlebar({ y: 80 }, 0)).toBe(false)
  })
  it('admits only own-account ignore and explicit room moderation targets, never an authority or account override', () => {
    expect(
      parseMatrixCommand({
        kind: 'ignore',
        userId: '@bob:test',
        ignored: true,
        account: '@victim:test',
        ignored_users: {}
      })
    ).toEqual({ kind: 'ignore', userId: '@bob:test', ignored: true })

    for (const kind of ['ban', 'unban']) {
      expect(parseMatrixCommand({ kind, roomId: '!r:test', userId: '@bob:test', powerLevel: 100 })).toEqual({
        kind,
        roomId: '!r:test',
        userId: '@bob:test'
      })
    }

    for (const value of [
      { kind: 'ignore', userId: '@bob:test', ignored: 'false' },
      { kind: 'ignore', userId: '@bob:test' },
      { kind: 'ignore', userId: '@broken', ignored: true },
      { kind: 'ban', userId: '@bob:test', roomId: 'all' }
    ]) {
      expect(() => parseMatrixCommand(value)).toThrow('matrix_command_invalid')
    }
  })
  it('reduces read attention to a room or none, never a caller-selected event, receipt type or identity', () => {
    expect(
      parseMatrixCommand({
        kind: 'attend',
        roomId: '!r:test',
        eventId: '$event',
        userId: '@victim:test',
        receiptType: 'm.read'
      })
    ).toEqual({ kind: 'attend', roomId: '!r:test' })
    expect(parseMatrixCommand({ kind: 'attend', roomId: null })).toEqual({ kind: 'attend', roomId: null })

    for (const roomId of [undefined, '', 'r:test', '!'.repeat(1025), 42]) {
      expect(() => parseMatrixCommand({ kind: 'attend', roomId })).toThrow('matrix_command_invalid')
    }

    // The explicit acknowledgement command is retired: the SDK acknowledges what is on screen.
    expect(() => parseMatrixCommand({ kind: 'markRead', roomId: '!r:test', eventId: '$event' })).toThrow(
      'matrix_command_invalid'
    )
  })
  it('limits a report to an event, room, sender and one bounded reason line, discarding scoring fields', () => {
    expect(
      parseMatrixCommand({
        kind: 'reportEvent',
        roomId: '!r:test',
        eventId: '$event',
        userId: '@bob:test',
        reason: '  spam\n links  ',
        score: -100,
        account: '@victim:test'
      })
    ).toEqual({ kind: 'reportEvent', roomId: '!r:test', eventId: '$event', userId: '@bob:test', reason: 'spam links' })
    // A blank reason is no reason.
    expect(
      parseMatrixCommand({ kind: 'reportEvent', roomId: '!r:test', eventId: '$event', userId: '@bob:test', reason: ' ' })
    ).toEqual({ kind: 'reportEvent', roomId: '!r:test', eventId: '$event', userId: '@bob:test' })

    for (const value of [
      { kind: 'reportEvent', roomId: '!r:test', eventId: '$event', userId: '@bob:test', reason: 'x'.repeat(501) },
      { kind: 'reportEvent', roomId: '!r:test', eventId: '$event', userId: '@bob:test', reason: 42 },
      { kind: 'reportEvent', roomId: '!r:test', eventId: '$event' },
      { kind: 'reportEvent', roomId: '!r:test', eventId: '~pending', userId: '@bob:test' },
      { kind: 'reportEvent', roomId: 'all', eventId: '$event', userId: '@bob:test' },
      { kind: 'reportEvent', roomId: '!r:test', eventId: '$event', userId: '@broken' }
    ]) {
      expect(() => parseMatrixCommand(value)).toThrow('matrix_command_invalid')
    }
  })
  it('validates closed membership commands and direct-room shape without accepting authority hints', () => {
    expect(parseMatrixCommand({ kind: 'invite', roomId: '!r:test', userId: '@bob:test', powerLevel: 100 })).toEqual({
      kind: 'invite',
      roomId: '!r:test',
      userId: '@bob:test'
    })
    expect(parseMatrixCommand({ kind: 'leave', roomId: '!r:test', userId: '@other:test' })).toEqual({
      kind: 'leave',
      roomId: '!r:test'
    })
    expect(parseMatrixCommand({ kind: 'create', invite: ['@bob:test'], direct: true })).toEqual({
      kind: 'create',
      name: '',
      invite: ['@bob:test'],
      direct: true
    })
    expect(() => parseMatrixCommand({ kind: 'create', invite: [], name: '' })).toThrow('matrix_command_invalid')

    for (const value of [
      { kind: 'invite', roomId: '!r:test', userId: '@invalid' },
      { kind: 'removeMember', roomId: '!r:test', userId: '@bob:test extra' },
      { kind: 'create', name: 'DM', invite: [], direct: true },
      { kind: 'create', name: 'DM', invite: ['@bob:test', '@carol:test'], direct: true },
      { kind: 'create', name: 'DM', invite: ['@bob:test'], direct: 'true' }
    ]) {
      expect(() => parseMatrixCommand(value)).toThrow('matrix_command_invalid')
    }
  })
  it('bounds recovery input and admits only closed verification actions', () => {
    expect(
      parseMatrixCommand({ kind: 'verificationRespond', id: 'request', action: 'confirm', secret: 'ignored' })
    ).toEqual({ kind: 'verificationRespond', id: 'request', action: 'confirm' })

    for (const value of [
      { kind: 'verificationRespond', id: 'r', action: 'trustAll' },
      { kind: 'recoveryRestore', key: 'a'.repeat(257) },
      { kind: 'recoveryRestore', key: [] },
      { kind: 'verificationStart', userId: '@alice:test', deviceId: '' },
      { kind: 'recoverySetUp', id: '' }
    ]) {
      expect(() => parseMatrixCommand(value)).toThrow('matrix_command_invalid')
    }
  })
  it('accepts only the exact webContents, main frame, and committed document', () => {
    const caller = { mainFrame: { url: 'atum-matrix://sdk/matrix-sdk.html' } }
    expect(() =>
      requireMatrixCaller({ sender: caller, senderFrame: caller.mainFrame }, caller, caller.mainFrame.url)
    ).not.toThrow()

    for (const event of [
      { sender: {}, senderFrame: caller.mainFrame },
      { sender: caller, senderFrame: { url: caller.mainFrame.url } }
    ]) {
      expect(() => requireMatrixCaller(event, caller, caller.mainFrame.url)).toThrow('matrix_ipc_denied')
    }

    expect(() =>
      requireMatrixCaller({ sender: caller, senderFrame: caller.mainFrame }, caller, 'atum-matrix://ui/matrix.html')
    ).toThrow()
  })
  it('rejects valid native reader signing and SAS commands from the renderer', () => {
    const deviceId = 'ATUM_COMPANION_11111111-2222-4333-8444-555555555555'

    for (const command of [
      { kind: 'ownerReaderCrossSignDevice', deviceId },
      { kind: 'ownerReaderVerificationPrepare', deviceId, expiresAt: Date.now() + 60000 },
      { kind: 'ownerReaderVerificationRead', deviceId },
      {
        kind: 'ownerReaderVerificationRespond',
        deviceId,
        flowId: 'actual-flow',
        decimal: [1000, 9191, 4000],
        action: 'confirm'
      }
    ]) {
      expect(() => parseMatrixCommand(command)).toThrow('matrix_command_invalid')
    }
  })

  it('has no generic network, credential, filesystem, or script command', () => {
    for (const kind of [
      'fetch',
      'configuration',
      'execute',
      'refresh',
      'readFile',
      'stop',
      'verify',
      'securityStatus',
      'agentIdentityStatus',
      'agentIdentityCreate',
      'agentIdentityRestore',
      'agentRecoveryKey',
      'ownerRecovery',
      'ownerReaderCrossSignDevice'
    ]) {
      expect(() => parseMatrixCommand({ kind })).toThrow()
    }

    expect(parseMatrixCommand({ kind: 'send', roomId: '!room:test', body: 'hello', accessToken: 'ignored' })).toEqual({
      kind: 'send',
      roomId: '!room:test',
      body: 'hello'
    })
  })
  it('sends a long message that fits one event, and refuses a longer one with its own reason (FR20)', () => {
    const long = 'Một tin nhắn dài. '.repeat(1_500)
    expect(parseMatrixCommand({ kind: 'send', roomId: '!room:test', body: long })).toMatchObject({ body: long })
    expect(() => parseMatrixCommand({ kind: 'send', roomId: '!room:test', body: '字'.repeat(16_000) })).toThrow(
      'matrix_message_too_long'
    )
  })
  it('keeps trusted assistant-room reads and human invitation commands out of the UI parser', () => {
    for (const command of [
      { kind: 'createAssistant', name: '', direct: true, invite: ['@agent:test'] },
      { kind: 'createAppGroup', name: 'Group', app: '@agent:test' },
      { kind: 'readContinuity', roomId: '!room:test', ownerId: '@owner:test', agentId: '@agent:test' },
      {
        kind: 'readAssistantRoom',
        roomId: '!room:test',
        ownerId: '@owner:test',
        agentId: '@agent:test',
        allowInvite: true
      },
      { kind: 'inviteHuman', roomId: '!room:test', userId: '@human:test', agentId: '@agent:test' },
      { kind: 'forgetAgentRoom', roomId: '!room:test', ownerId: '@owner:test', agentId: '@agent:test' },
      { kind: 'publishNotice', roomId: '!room:test', eventId: '$event', body: 'line' },
      // The agent's receipt and typing are main's, through the agent's own SDK, never the window's.
      { kind: 'agentSeen', roomId: '!room:test', eventId: '$event', ownerId: '@owner:test', admitted: [] },
      { kind: 'agentTyping', roomId: '!room:test', ownerId: '@owner:test', typing: true }
    ]) {
      expect(() => parseMatrixCommand(command)).toThrow('matrix_command_invalid')
    }

    expect(
      parseMatrixCommand({
        kind: 'create',
        name: '',
        direct: true,
        invite: ['@human:test'],
        roomType: 'io.atum.assistant',
        assistant: true
      })
    ).toEqual({
      kind: 'create',
      name: '',
      direct: true,
      invite: ['@human:test']
    })
  })
  it('keeps every company room provisioning and custody command out of renderer IPC', () => {
    const binding = {
      companyId: '00000000-0000-4000-8000-bd7662a5eeb4',
      projectId: '00000000-0000-4000-8000-b454f82c5857',
      servicePrincipal: '00000000-0000-4000-8000-f6222a1106ee',
      managerUserId: '@manager:test',
      serviceUserId: '@cos:test',
      roomId: '!company:test',
      memberUserIds: ['@member:test']
    }

    for (const kind of [
      'createCompanyProjectRoom',
      'findCompanyProjectRoom',
      'reconcileCompanyProjectRoom',
      'readCompanyProjectRoom',
      'joinCompanyProjectRoom',
      'rotateCompanyProjectSession',
      'companyFileContext',
      'companyFileSend',
      'companyFileReference'
    ]) {
      expect(() => parseMatrixCommand({ ...binding, kind, name: 'Project', allowServiceInvite: true })).toThrow(
        'matrix_command_invalid'
      )
    }
  })
  it('bounds uploads and validates explicit targets', () => {
    expect(() =>
      parseMatrixCommand({
        kind: 'attach',
        roomId: '!r:test',
        name: 'a',
        bytes: new Uint8Array(MATRIX_MAX_FILE_BYTES + 1)
      })
    ).toThrow()
    expect(
      parseMatrixCommand({
        kind: 'attach',
        roomId: '!r:test',
        name: 'empty.txt',
        bytes: new Uint8Array()
      })
    ).toMatchObject({ kind: 'attach', roomId: '!r:test', name: 'empty.txt', bytes: new Uint8Array() })
    expect(
      parseMatrixCommand({
        kind: 'attach',
        roomId: '!r:test',
        name: 'notes.txt',
        contentType: 'text/plain',
        bytes: new Uint8Array([1]),
        threadRootId: '$root',
        replyTo: '$reply'
      })
    ).toEqual({
      kind: 'attach',
      roomId: '!r:test',
      name: 'notes.txt',
      contentType: 'text/plain',
      bytes: new Uint8Array([1]),
      threadRootId: '$root',
      replyTo: '$reply'
    })
    expect(() =>
      parseMatrixCommand({
        kind: 'attach',
        roomId: '!r:test',
        name: 'notes.txt',
        bytes: new Uint8Array([1]),
        threadRootId: 'local-root'
      })
    ).toThrow('matrix_command_invalid')
    expect(() =>
      parseMatrixCommand({
        kind: 'attach',
        roomId: '!r:test',
        name: 'notes.txt',
        bytes: new Uint8Array([1]),
        replyTo: '$reply'
      })
    ).toThrow('matrix_command_invalid')
    expect(parseMatrixCommand({ kind: 'download', roomId: '!r:test', eventId: '$file', companyFile: true })).toEqual({
      kind: 'download',
      roomId: '!r:test',
      eventId: '$file',
      companyFile: true
    })
    expect(() =>
      parseMatrixCommand({
        kind: 'download',
        roomId: '!r:test',
        eventId: '$file',
        companyFile: false
      })
    ).toThrow('matrix_command_invalid')
    expect(() => parseMatrixCommand({ kind: 'create', name: 'test', invite: ['not an mxid'] })).toThrow()
    expect(() => parseMatrixCommand({ kind: 'select', roomId: 'https://example.test' })).toThrow()
  })
  it('public configuration cannot send credentials to an insecure remote endpoint or silently retarget a vault', () => {
    const config = parseMatrixConfig({
      issuer: 'https://id.example.test',
      server: 'https://matrix.example.test',
      nativeClientId: 'client'
    })

    expect(config.issuer).toBe('https://id.example.test/')
    expect(parseMatrixConfig({ ...config, issuer: 'https://id.example.test/tenant/' }).issuer).toBe(
      'https://id.example.test/tenant/'
    )
    expect(matrixConfigurationKey(config)).not.toBe(
      matrixConfigurationKey({ ...config, issuer: 'https://other.example.test' })
    )

    for (const issuer of [
      'http://example.test',
      'https://secret@example.test',
      'https://id.example.test?token=secret',
      'file:///private'
    ]) {
      expect(() => parseMatrixConfig({ ...config, issuer })).toThrow()
    }
  })
  it('requires a distinct domain public client and binds its endpoint to the isolated profile', () => {
    const base = { issuer: 'https://id.test/', server: 'https://matrix.test', nativeClientId: 'matrix' }
    const domain = { nativeClientId: 'domain', resource: 'https://api.test' }
    const configured = parseMatrixConfig({ ...base, domain })

    expect(matrixConfigurationKey(configured)).toBe(
      matrixConfigurationKey({ ...configured, domain: { ...configured.domain!, callbackPort: 22884 } })
    )
    expect(matrixConfigurationKey(configured)).not.toBe(matrixConfigurationKey(parseMatrixConfig(base)))
    expect(matrixConfigurationKey(configured)).not.toBe(
      matrixConfigurationKey({ ...configured, domain: { ...domain, resource: 'https://other.test' } })
    )

    for (const invalid of [
      null,
      { ...domain, nativeClientId: 'matrix' },
      { ...domain, resource: 'http://remote.test' },
      { ...domain, resource: 'https://api.test/?secret=x' }
    ]) {
      expect(() => parseMatrixConfig({ ...base, domain: invalid })).toThrow()
    }
  })
})

it('bounds group preferences and never passes a renderer-provided owner or roster to the SDK', () => {
  const identity = { userId: '@owner:test', deviceId: 'D' }
  expect(
    parseMatrixCommand({
      kind: 'groupPolicy',
      roomId: '!room:test',
      identity,
      ownerId: '@foreign:test',
      agentIds: ['@foreign:test'],
      change: { dailyTurns: 30 }
    })
  ).toEqual({ kind: 'groupPolicy', roomId: '!room:test', identity, change: { dailyTurns: 30 } })
  for (const change of [
    { dailyTurns: 0 },
    { dailyTurns: 201 },
    { dailyTurns: 2.5 },
    { dailyTurns: 30, verified: true },
    { agentId: '@one:test', mode: 'unknown' }
  ]) {
    expect(() => parseMatrixCommand({ kind: 'groupPolicy', roomId: '!room:test', identity, change })).toThrow(
      'matrix_command_invalid'
    )
  }
  expect(() =>
    parseMatrixCommand({
      kind: 'ownerGroupPolicy',
      roomId: '!room:test',
      ownerId: identity.userId,
      agentIds: ['@one:test']
    })
  ).toThrow()
})

it('accepts only bounded Matrix forwarding identities and a retry nonce', () => {
  const input = {
    kind: 'forward' as const,
    roomId: '!source:test',
    eventId: '$event',
    toRoomId: '!target:test',
    dialogNonce: 'forward-dialog-1'
  }

  expect(parseMatrixCommand({ ...input, content: { forged: true } })).toEqual(input)

  for (const invalid of [
    { ...input, roomId: 'source' },
    { ...input, eventId: 'event' },
    { ...input, toRoomId: 'target' },
    { ...input, dialogNonce: '' },
    { ...input, dialogNonce: 'x'.repeat(129) }
  ]) {
    expect(() => parseMatrixCommand(invalid)).toThrow('matrix_command_invalid')
  }
})

it('accepts bounded owner migration intent and rejects raw SDK write authority from the window', () => {
  const input = {
    kind: 'agentConversation',
    identity: { userId: '@owner:test', deviceId: 'MAC' },
    agentId: '@agent:test',
    action: 'keep',
    roomId: '!room:test'
  }
  expect(parseMatrixCommand({ ...input, content: { role: 'main' }, replaceMain: true })).toEqual(input)
  expect(parseMatrixCommand({ ...input, action: 'preview' })).toEqual({ ...input, action: 'preview' })
  expect(parseMatrixCommand({ ...input, action: 'preview', roomId: undefined })).toEqual({
    kind: input.kind,
    identity: input.identity,
    agentId: input.agentId,
    action: 'preview'
  })
  for (const invalid of [
    { ...input, action: 'write' },
    { ...input, roomId: 'room' },
    { ...input, action: 'preview', roomId: 'room' },
    { ...input, agentId: 'agent' },
    { ...input, identity: { userId: '@owner:test', deviceId: '' } },
    { ...input, kind: 'writeConversationMarker' },
    { kind: 'createAssistant', name: '', invite: ['@agent:test'], direct: true, replaceMain: true },
    { kind: 'conversationAppVersions', ownerId: '@owner:test', devices: ['forged'] }
  ]) {
    expect(() => parseMatrixCommand(invalid)).toThrow('matrix_command_invalid')
  }
})

describe('reading what a chat has shared, for its info panel', () => {
  it('passes a bounded read and a thumbnail request through, dropping anything else', () => {
    expect(
      parseMatrixCommand({ kind: 'roomShared', roomId: '!r:test', section: 'files', limit: 3, from: 't1-2_3', extra: 1 })
    ).toEqual({ kind: 'roomShared', roomId: '!r:test', section: 'files', limit: 3, from: 't1-2_3' })
    expect(parseMatrixCommand({ kind: 'roomShared', roomId: '!r:test', section: 'media', limit: 6 })).toEqual({
      kind: 'roomShared',
      roomId: '!r:test',
      section: 'media',
      limit: 6
    })
    expect(parseMatrixCommand({ kind: 'roomSharedThumbnail', roomId: '!r:test', eventId: '$e' })).toEqual({
      kind: 'roomSharedThumbnail',
      roomId: '!r:test',
      eventId: '$e'
    })
  })

  it('refuses an unknown section, an unbounded limit, a malformed token or a non-event id', () => {
    for (const invalid of [
      { kind: 'roomShared', roomId: '!r:test', section: 'everything', limit: 3 },
      { kind: 'roomShared', roomId: '!r:test', section: 'links', limit: 0 },
      { kind: 'roomShared', roomId: '!r:test', section: 'links', limit: 61 },
      { kind: 'roomShared', roomId: '!r:test', section: 'links', limit: 3, from: 'has space' },
      { kind: 'roomShared', roomId: 'r:test', section: 'links', limit: 3 },
      { kind: 'roomSharedThumbnail', roomId: '!r:test', eventId: 'e' }
    ]) {
      expect(() => parseMatrixCommand(invalid)).toThrow('matrix_command_invalid')
    }
  })
})
