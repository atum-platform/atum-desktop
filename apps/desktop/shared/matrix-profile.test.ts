import { expect, it } from 'vitest'

import {
  MATRIX_PROFILE_PHOTO_MAX_BYTES,
  matrixProfileMxc,
  matrixProfilePhoto,
  matrixProfileTarget
} from './matrix-profile'

it.each([
  ['image/jpeg', [0xff, 0xd8, 0xff]],
  ['image/png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  ['image/webp', [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]]
])('accepts %s bytes, not an extension or declared MIME alone', (type, values) => {
  const bytes = new Uint8Array(values as number[])
  const photo = matrixProfilePhoto({ type, bytes })
  expect(photo.type).toBe(type)
  expect(photo.bytes).toEqual(bytes)
  expect(photo.bytes).not.toBe(bytes)
  expect(() => matrixProfilePhoto({ type: 'image/svg+xml', bytes })).toThrow('type')
})

it('allows exactly 2 MiB and rejects oversized, empty or disguised active content', () => {
  const bytes = new Uint8Array(MATRIX_PROFILE_PHOTO_MAX_BYTES)
  bytes.set([0xff, 0xd8, 0xff])
  expect(matrixProfilePhoto({ type: 'image/jpeg', bytes }).bytes.length).toBe(MATRIX_PROFILE_PHOTO_MAX_BYTES)
  expect(() =>
    matrixProfilePhoto({ type: 'image/jpeg', bytes: new Uint8Array(MATRIX_PROFILE_PHOTO_MAX_BYTES + 1) })
  ).toThrow('size')
  expect(() => matrixProfilePhoto({ type: 'image/jpeg', bytes: new Uint8Array() })).toThrow('type')
  expect(() => matrixProfilePhoto({ type: 'image/png', bytes: new TextEncoder().encode('<svg/>') })).toThrow('type')
})

it('permits only native-resolved own person or owned-agent targets, never an SDK user or app', () => {
  expect(matrixProfileTarget({ kind: 'human', userId: '@other:test' })).toEqual({ kind: 'human' })
  expect(matrixProfileTarget({ kind: 'agent', principal: '00000000-0000-4000-8000-bd7662a5eeb4' })).toEqual({
    kind: 'agent',
    principal: '00000000-0000-4000-8000-bd7662a5eeb4'
  })

  for (const target of [{ kind: 'app', principal: 'mail' }, { kind: 'agent', userId: '@other:test' }, null]) {
    expect(() => matrixProfileTarget(target)).toThrow('invalid')
  }
})

it('accepts only a bounded Matrix content URI, not an arbitrary image or authenticated URL', () => {
  expect(matrixProfileMxc('mxc://matrix.test/owned')).toBe('mxc://matrix.test/owned')

  for (const url of [
    'https://matrix.test/image',
    'data:image/png;base64,AA==',
    'mxc://matrix.test/a?token=secret',
    'mxc://matrix.test/a/b',
    'mxc://bad host/a'
  ]) {
    expect(matrixProfileMxc(url)).toBeNull()
  }
})
