import { describe, expect, it } from 'vitest'

import { canHostInPanel, formatResourceSize, parseDmResources } from './dm-resources'

const PLANE_URL = 'https://deployment.example.invalid/resources/la-so.html'

describe('parseDmResources', () => {
  it('returns nothing for a message with no attachments', () => {
    expect(parseDmResources([])).toEqual([])
    expect(parseDmResources(undefined)).toEqual([])
    expect(parseDmResources(null)).toEqual([])
    expect(parseDmResources('nope')).toEqual([])
  })

  it('normalizes a snake_case attachment from the hosted plane', () => {
    expect(
      parseDmResources([
        { id: 'attachment-1', name: 'Lá số.html', mime_type: 'text/html', size_bytes: 4096, url: PLANE_URL }
      ])
    ).toEqual([
      { id: 'attachment-1', kind: 'page', mimeType: 'text/html', name: 'Lá số.html', sizeBytes: 4096, url: PLANE_URL }
    ])
  })

  it('accepts the camelCase and alternate key spellings a plane may use', () => {
    const [resource] = parseDmResources([
      {
        attachmentId: 'a-2',
        fileName: 'receipt.pdf',
        contentType: 'application/pdf',
        byteSize: '2048',
        href: PLANE_URL
      }
    ])

    expect(resource).toMatchObject({ id: 'a-2', kind: 'document', name: 'receipt.pdf', sizeBytes: 2048 })
  })

  it('falls back to the URL filename when the attachment has no name', () => {
    expect(parseDmResources([{ url: PLANE_URL }])[0]!.name).toBe('la-so.html')
  })

  it('infers image, document, and page kinds without a declared kind', () => {
    const kinds = parseDmResources([
      { name: 'chart.png', url: 'https://cdn.example.test/a/chart.png' },
      { name: 'notes.md', url: 'https://cdn.example.test/a/notes.md' },
      { url: 'https://moon.example.test/embed/laso/9' }
    ]).map(resource => resource.kind)

    expect(kinds).toEqual(['image', 'document', 'page'])
  })

  it('honours an explicitly declared kind over inference', () => {
    expect(parseDmResources([{ kind: 'image', name: 'thing.bin', url: PLANE_URL }])[0]!.kind).toBe('image')
  })

  it('drops every non-https target — a DM can never reach the local disk', () => {
    expect(
      parseDmResources([
        { name: 'a', url: 'file:///etc/passwd' },
        { name: 'b', url: 'data:text/html,<script>alert(1)</script>' },
        { name: 'c', url: 'javascript:alert(1)' },
        { name: 'd', url: 'http://insecure.example.test/x.png' },
        { name: 'e', url: '/home/example/secrets.txt' }
      ])
    ).toEqual([])
  })

  it('drops malformed entries but keeps the good ones alongside them', () => {
    const resources = parseDmResources([null, 'string', 42, [], {}, { url: PLANE_URL, name: 'ok' }])

    expect(resources).toHaveLength(1)
    expect(resources[0]!.name).toBe('ok')
  })

  it('de-duplicates repeated attachment ids within one message', () => {
    expect(
      parseDmResources([
        { id: 'a', url: PLANE_URL },
        { id: 'a', url: PLANE_URL }
      ])
    ).toHaveLength(1)
  })
})

describe('canHostInPanel', () => {
  it('allows the hosted plane and Supabase storage', () => {
    expect(canHostInPanel(PLANE_URL)).toBe(true)
    expect(canHostInPanel('https://public-fixture.supabase.co/storage/v1/object/x.png')).toBe(true)
  })

  it('refuses an unknown origin, so it opens in the browser instead', () => {
    expect(canHostInPanel('https://moon.example.test/embed/laso/9')).toBe(false)
  })

  it('refuses a lookalike host that merely ends with an allowlisted name', () => {
    expect(canHostInPanel('https://evil-deployment.example.invalid/x')).toBe(false)
    expect(canHostInPanel('https://api.atumplatform.com/resources/la-so.html')).toBe(true)
    expect(canHostInPanel('https://account.atumplatform.com/resources/la-so.html')).toBe(true)
    expect(canHostInPanel('https://evil-api.atumplatform.com/resources/la-so.html')).toBe(false)
    expect(canHostInPanel('https://notsupabase.co/x')).toBe(false)
  })

  it('refuses non-https and unparseable targets', () => {
    expect(canHostInPanel('http://deployment.example.invalid/x')).toBe(false)
    expect(canHostInPanel('not a url')).toBe(false)
  })
})

describe('formatResourceSize', () => {
  it('formats bytes through gigabytes and omits an absent size', () => {
    expect(formatResourceSize(null)).toBeNull()
    expect(formatResourceSize(512, 'en')).toBe('512 B')
    expect(formatResourceSize(4096, 'en')).toBe('4 KB')
    expect(formatResourceSize(1_572_864, 'en')).toBe('1.5 MB')
  })
})
