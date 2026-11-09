import { describe, expect, it } from 'vitest'

import {
  matrixFirstPreviewLink,
  matrixLinkPreviewFromOpenGraph,
  matrixLinkPreviewImageMxc,
  matrixLinkPreviewKey,
  matrixLinkPreviewResult
} from './matrix-link-preview'

const PNG = 'data:image/png;base64,iVBORw0KGgo='
const INVITE = `https://atumplatform.com/j/${'a'.repeat(43)}`

describe('matrixFirstPreviewLink', () => {
  it('takes only the first web link in a message', () => {
    expect(matrixFirstPreviewLink('see https://example.com/a and https://example.org/b')).toBe('https://example.com/a')
  })

  it('leaves sentence punctuation and unopened brackets out of the link', () => {
    expect(matrixFirstPreviewLink('Read this: https://example.com/post.')).toBe('https://example.com/post')
    expect(matrixFirstPreviewLink('(see https://example.com/x)')).toBe('https://example.com/x')
    expect(matrixFirstPreviewLink('[the doc](https://example.com/doc)')).toBe('https://example.com/doc')
    expect(matrixFirstPreviewLink('https://en.wikipedia.org/wiki/Atum_(god)!')).toBe('https://en.wikipedia.org/wiki/Atum_(god)')
  })

  it('drops the fragment, which never changes a page preview', () => {
    expect(matrixFirstPreviewLink('https://example.com/a#part')).toBe('https://example.com/a')
  })

  it('ignores links in code and Markdown images', () => {
    expect(matrixFirstPreviewLink('`https://example.com/code`')).toBeNull()
    expect(matrixFirstPreviewLink('```\ncurl https://example.com/api\n```')).toBeNull()
    expect(matrixFirstPreviewLink('![chart](https://example.com/chart.png)')).toBeNull()
    expect(matrixFirstPreviewLink('`https://example.com/x` then https://example.org/y')).toBe('https://example.org/y')
  })

  it('never offers an invite link (a bearer token) or an Atum discovery link to a fetcher', () => {
    expect(matrixFirstPreviewLink(`Join us: ${INVITE}`)).toBeNull()
    expect(matrixFirstPreviewLink('https://atumplatform.com/#atum-store/skill/notes')).toBeNull()
    expect(matrixFirstPreviewLink(`${INVITE} and https://example.com/after`)).toBe('https://example.com/after')
  })

  it('refuses addresses that are not plain web pages', () => {
    expect(matrixFirstPreviewLink('ftp://example.com/file')).toBeNull()
    expect(matrixFirstPreviewLink('https://user:pw@example.com/')).toBeNull()
    expect(matrixFirstPreviewLink('http://localhost:3000/')).toBeNull()
    expect(matrixFirstPreviewLink('atum://message/v1/abc')).toBeNull()
    expect(matrixFirstPreviewLink(`https://example.com/${'x'.repeat(2100)}`)).toBeNull()
    expect(matrixFirstPreviewLink(undefined)).toBeNull()
  })
})

describe('matrixLinkPreviewKey', () => {
  it('is one key per link per UTC day', () => {
    const day = Date.UTC(2026, 10, 7)

    expect(matrixLinkPreviewKey('https://a.example/', day + 1000)).toBe(matrixLinkPreviewKey('https://a.example/', day + 80_000_000))
    expect(matrixLinkPreviewKey('https://a.example/', day)).not.toBe(matrixLinkPreviewKey('https://a.example/', day + 86_400_000))
    expect(matrixLinkPreviewKey('https://a.example/', day)).not.toBe(matrixLinkPreviewKey('https://b.example/', day))
  })
})

describe('matrixLinkPreviewFromOpenGraph', () => {
  const url = 'https://www.example.com/post'

  it('is no card when the page has neither a title nor a picture', () => {
    expect(matrixLinkPreviewFromOpenGraph(url, { 'og:description': 'Only words' })).toBeNull()
    expect(matrixLinkPreviewFromOpenGraph(url, {})).toBeNull()
    expect(matrixLinkPreviewFromOpenGraph(url, null)).toBeNull()
  })

  it('keeps visible text only, bounded, and the host without www', () => {
    const preview = matrixLinkPreviewFromOpenGraph(url, {
      'og:title': `  A\u0000 title\u202e   here ${'x'.repeat(400)}`,
      'og:site_name': 'Example',
      'og:description': 'Short'
    })

    expect(preview?.host).toBe('example.com')
    expect(preview?.siteName).toBe('Example')
    expect(preview?.title?.startsWith('A title here x')).toBe(true)
    expect(preview?.title?.length).toBe(300)
    expect(preview?.title?.endsWith('…')).toBe(true)
  })

  it('takes a picture only as a bounded image data URL', () => {
    expect(matrixLinkPreviewFromOpenGraph(url, {}, PNG)).toEqual({ url, host: 'example.com', image: PNG })
    expect(matrixLinkPreviewFromOpenGraph(url, {}, 'data:text/html;base64,PGh0bWw+')).toBeNull()
    expect(matrixLinkPreviewFromOpenGraph(url, {}, 'https://example.com/a.png')).toBeNull()
  })

  it('reads the stored picture only as an mxc URI', () => {
    expect(matrixLinkPreviewImageMxc({ 'og:image': 'mxc://chat.example/abc' })).toBe('mxc://chat.example/abc')
    expect(matrixLinkPreviewImageMxc({ 'og:image': 'https://example.com/a.png' })).toBeNull()
  })
})

describe('matrixLinkPreviewResult', () => {
  it('re-checks what the SDK answered', () => {
    expect(matrixLinkPreviewResult({ url: 'https://example.com/a', host: 'example.com', title: 'A' })).toEqual({
      url: 'https://example.com/a',
      host: 'example.com',
      title: 'A'
    })
    expect(matrixLinkPreviewResult({ url: 'javascript:alert(1)', title: 'A' })).toBeNull()
    expect(matrixLinkPreviewResult({ url: INVITE, title: 'A' })).toBeNull()
    expect(matrixLinkPreviewResult({ url: 'https://example.com/a', title: 'A', image: 'data:image/svg+xml;base64,PHN2Zz4=' })).toEqual({
      url: 'https://example.com/a',
      host: 'example.com',
      title: 'A'
    })
    expect(matrixLinkPreviewResult('nope')).toBeNull()
  })
})
