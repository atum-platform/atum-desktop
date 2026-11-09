import { expect, it } from 'vitest'

import { MatrixWebPreviewOffers, matrixWebPreviewTarget } from './workbench-preview'

it('projects only bounded web targets, never credentials or file paths', () => {
  expect(matrixWebPreviewTarget({ url: 'http://localhost:3000/café', label: 'Local', bearer: 'private' })).toEqual({
    url: 'http://localhost:3000/caf%C3%A9',
    label: 'Local'
  })

  for (const url of [
    'file:///private/a',
    '/private/a',
    'javascript:alert(1)',
    'https://user:pass@example.test',
    'https://a.test/\n',
    'https://a.test/' + 'x'.repeat(4096)
  ]) {
    expect(matrixWebPreviewTarget({ url })).toBeUndefined()
  }
})

it('keeps URL private until a once-only scoped open and never trusts a foreign token', () => {
  const offers = new MatrixWebPreviewOffers(() => 10)
  offers.receive('owner/device/room', { url: 'https://example.test/secret-path', label: 'Preview' }, () => true)
  const offer = offers.view('owner/device/room')!
  expect(JSON.stringify(offer)).not.toContain('secret-path')
  expect(offers.view('foreign')).toBeUndefined()
  expect(() => offers.open('foreign', offer.id)).toThrow('unavailable')
  expect(() => offers.open('owner/device/room', 'forged')).toThrow('unavailable')
  expect(offers.open('owner/device/room', offer.id)).toEqual({ id: offer.id, url: 'https://example.test/secret-path' })
  expect(() => offers.open('owner/device/room', offer.id)).toThrow('unavailable')
})

it('retires expiry, original connection loss, scope changes and explicit dismissal', () => {
  let now = 10,
    alive = true

  const offers = new MatrixWebPreviewOffers(() => now)
  const target = { url: 'https://example.test/', label: 'Preview' }
  offers.receive('own', target, () => alive)
  const first = offers.view('own')!
  offers.receive('own', target, () => alive)
  expect(offers.view('own')?.id).toBe(first.id)
  now = first.expiresAt
  expect(() => offers.open('own', first.id)).toThrow('unavailable')
  offers.receive('own', target, () => alive)
  alive = false
  expect(offers.view('own')).toBeUndefined()
  alive = true
  expect(offers.view('own')).toBeUndefined()
  offers.receive('own', target, () => alive)
  offers.dismiss('own', offers.view('own')!.id)
  expect(offers.view('own')).toBeUndefined()
  offers.receive('own', target, () => alive)
  offers.clear()
  expect(offers.view('own')).toBeUndefined()
})

it('replaces a foreground target without allowing its previous token to open', () => {
  const offers = new MatrixWebPreviewOffers(() => 10)
  offers.receive('own', { url: 'https://example.test/one', label: 'First' }, () => true)
  const first = offers.view('own')!
  offers.receive('own', { url: 'https://example.test/two', label: 'Second' }, () => true)
  const second = offers.view('own')!
  expect(second.id).not.toBe(first.id)
  expect(() => offers.open('own', first.id)).toThrow('unavailable')
  expect(offers.open('own', second.id).url).toBe('https://example.test/two')
})

it('uses the real hostname for empty, oversized or control-bearing display labels', () => {
  for (const label of ['', '  ', 'x'.repeat(121), 'First\nSecond']) {
    expect(matrixWebPreviewTarget({ url: 'https://example.test/page', label })?.label).toBe('example.test')
  }

  expect(matrixWebPreviewTarget({ url: 'https://example.test/page', label: 'x'.repeat(120) })?.label).toHaveLength(120)
})
