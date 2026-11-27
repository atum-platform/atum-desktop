import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import type { MatrixMessage, MatrixRoom, MatrixUiBridge } from '../../shared/matrix'

import { MatrixRichRow } from './rich-row'

const room: MatrixRoom = { id: '!room:test', membership: 'join', name: 'Room', encrypted: false }

const base: MatrixMessage = {
  body: '',
  attachment: false,
  id: '$event',
  sender: '@sender:test',
  timestamp: 1,
  own: false,
  encrypted: false,
  decryptionFailed: false,
  pending: false,
  failed: false
}

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'atumMatrix')
})

it('requests a map only when opening the received point', () => {
  const openLink = vi.fn(async () => {})
  window.atumMatrix = { openLink } as unknown as MatrixUiBridge
  render(<MatrixRichRow message={{ ...base, body: 'Meet here', rich: { kind: 'location', geoUri: 'geo:10.5,106.4' } }} room={room} />)

  expect(openLink).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Meet here' }))
  expect(openLink).toHaveBeenCalledExactlyOnceWith('geo:10.5,106.4')
})

it('uses the sticker body as alt text and loads bytes by event ID', async () => {
  const command = vi.fn(async () => new Uint8Array([1, 2, 3]))
  window.atumMatrix = { command } as unknown as MatrixUiBridge
  render(<MatrixRichRow message={{
    ...base, attachment: true, body: 'A waving hand', rich: { kind: 'sticker', mimeType: 'image/png' }
  }} room={room} />)
  const image = await screen.findByRole('img', { name: 'A waving hand' })
  expect(command).toHaveBeenCalledExactlyOnceWith({ kind: 'download', inline: true, roomId: room.id, eventId: base.id })
  expect(image.getAttribute('src')).toBe('data:image/png;base64,AQID')
})
