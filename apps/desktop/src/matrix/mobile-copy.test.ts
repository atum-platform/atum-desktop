import { describe, expect, it } from 'vitest'

import { LOCALE_OPTIONS } from '@/i18n'

import { mobileChatCopy, mobileScreensCopy } from './mobile-copy'

/** Every sentence a copy table can produce, each function called with samples. */
function sentences(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value]
  }

  if (typeof value === 'function') {
    return sentences((value as (...samples: unknown[]) => unknown)(...samplesFor(value)))
  }

  return value && typeof value === 'object' ? Object.values(value).flatMap(sentences) : []
}

/** A count for a one-argument formatter that counts, a name and a text for the rest. */
function samplesFor(fn: unknown): unknown[] {
  return (fn as (...args: unknown[]) => unknown).length === 2 ? ['Lan', 'xin chào'] : [7]
}

const LOCALES = LOCALE_OPTIONS.map(({ id }) => id)

describe('the iPhone chat copy', () => {
  it.each(LOCALES)('says every key in %s, with no empty sentence', locale => {
    const copy = mobileChatCopy[locale]

    expect(Object.keys(copy).sort()).toEqual(Object.keys(mobileChatCopy.en).sort())
    expect(Object.keys(copy.placeholder).sort()).toEqual(Object.keys(mobileChatCopy.en.placeholder).sort())

    for (const sentence of sentences(copy)) {
      expect(sentence.trim()).not.toBe('')
      expect(sentence).not.toMatch(/undefined|NaN|\[object/u)
    }
  })

  // Chats feel like messaging (plan §0.2): the transcript never shows work or status words, and
  // nothing on iOS points to buying (no purchase call to action until StoreKit is validated).
  it.each(LOCALES)('never says a working word, an internal word or a purchase word in %s', locale => {
    for (const sentence of sentences(mobileChatCopy[locale])) {
      expect(sentence).not.toMatch(/Đang chuẩn bị|Đang gửi|Đang xử lý|Dừng|Getting ready|Sending|Working|Stop/iu)
      expect(sentence).not.toMatch(/thiết bị|\bdevice\b|mã hóa|encrypt|Hermes|Matrix/iu)
      expect(sentence).not.toMatch(/\bMua\b|\bbuy\b|purchase|Proton|PayOS|VietQR|購入|购买|購買/iu)
    }
  })

  it.each(LOCALES)('keeps every argument it is given in %s', locale => {
    const copy = mobileChatCopy[locale]

    for (const count of [1, 2, 42]) {
      expect(copy.newMessages(count)).toContain(String(count))
    }

    expect(copy.composerPlaceholder('Lan')).toContain('Lan')
    expect(copy.incomingAnnouncement('Lan', 'xin chào')).toContain('Lan')
    expect(copy.incomingAnnouncement('Lan', 'xin chào')).toContain('xin chào')
    expect(copy.home.preview.byline('Lan', 'xin chào')).toContain('Lan')
    expect(copy.home.preview.byline('Lan', 'xin chào')).toContain('xin chào')
    expect(copy.home.preview.fileNamed('bao-cao.pdf')).toContain('bao-cao.pdf')
    expect(copy.info.memberCount(7)).toContain('7')
  })

  it('counts one new message in the singular in English', () => {
    const one = mobileChatCopy.en.newMessages(1)

    expect(one).not.toBe(mobileChatCopy.en.newMessages(2).replace('2', '1'))
  })

  it.each(LOCALES)('gives Moon and Andy onboarding copy with safe terms links in %s', locale => {
    const onboarding = mobileChatCopy[locale].appBot.onboarding

    expect(onboarding.consent('Moon')).toContain('Moon')
    expect(onboarding.connecting('Moon')).toContain('Moon')
    expect(onboarding.failure('Moon').trim()).not.toBe('')

    for (const value of Object.values(onboarding.birth)) {
      expect(value.trim()).not.toBe('')
    }

    for (const raw of [onboarding.moonTermsURL, onboarding.andyTermsURL]) {
      const url = new URL(raw)

      expect(url.protocol).toBe('https:')
      expect(url.host).not.toBe('')
      expect(url.username).toBe('')
      expect(url.password).toBe('')
      expect(url.hash).toBe('')
    }
  })
})

/** Every key path of a copy table, nested groups included. */
function keyPaths(value: object, prefix = ''): string[] {
  return Object.entries(value)
    .flatMap(([key, each]) =>
      each && typeof each === 'object' ? keyPaths(each as object, `${prefix}${key}.`) : [`${prefix}${key}`]
    )
    .sort()
}

describe('the iPhone screens copy', () => {
  it.each(LOCALES)('says every key in %s, with no empty sentence', locale => {
    const copy = mobileScreensCopy[locale]

    expect(keyPaths(copy)).toEqual(keyPaths(mobileScreensCopy.en))

    for (const sentence of sentences(copy)) {
      expect(sentence.trim()).not.toBe('')
      expect(sentence).not.toMatch(/undefined|NaN|\[object/u)
    }
  })

  it.each(LOCALES)('keeps the amount on the Get button in %s', locale => {
    expect(mobileScreensCopy[locale].store.getFor('4,000')).toContain('4,000')
  })
})
