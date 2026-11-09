import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import type { MatrixUiBridge } from '../../shared/matrix'
import type { MatrixProfile, MatrixProfilesBridge } from '../../shared/matrix-profile'

import { MatrixProfileAvatar } from './profile-avatar'

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'atumMatrix')
})

const profile = { userId: '@atum:test', displayName: 'Atum', avatarMxc: 'mxc://matrix.test/photo' }
const target = { kind: 'agent' as const, principal: '00000000-0000-4000-8000-bd7662a5eeb4' }
const dataUrl = 'data:image/png;base64,iVBORw0KGgo='

it('brands Main while using only the canonical assistant photo and brand fallback', async () => {
  const read = vi.fn<MatrixProfilesBridge['read']>().mockResolvedValue({ ...profile, avatarUrl: dataUrl })
  window.atumMatrix = { profiles: { read } } as unknown as MatrixUiBridge

  const view = render(
    <MatrixProfileAvatar
      avatarUrl={dataUrl}
      brand
      className="size-8"
      id={target.principal}
      name="Atum"
      profile={profile}
      scopeKey="human/MAC"
      target={target}
    />
  )

  expect(view.container.querySelector('img')?.getAttribute('src')).toBe(dataUrl)
  await act(async () => {})
  fireEvent.error(view.container.querySelector('img')!)
  await waitFor(() => expect(view.container.querySelector('[data-atum-eclipse-face]')).toBeTruthy())
  expect(read).not.toHaveBeenCalled()
})

it('never falls back to Matrix profile media for an agent without a canonical photo', async () => {
  const read = vi.fn<MatrixProfilesBridge['read']>().mockResolvedValue({ ...profile, avatarUrl: dataUrl })
  window.atumMatrix = { profiles: { read } } as unknown as MatrixUiBridge

  const view = render(
    <MatrixProfileAvatar
      className="size-8"
      id={target.principal}
      name="Atum"
      profile={profile}
      scopeKey="human/MAC"
      target={target}
    />
  )

  expect(view.getByText('A')).toBeTruthy()
  expect(view.container.querySelector('img')).toBeNull()
  expect(read).not.toHaveBeenCalled()
  expect(view.container.innerHTML).not.toContain('mxc://')
  view.rerender(
    <MatrixProfileAvatar
      className="size-8"
      id={target.principal}
      name={'A\u0301tum'}
      profile={{ ...profile, avatarMxc: null }}
      scopeKey="human/MAC"
      target={target}
    />
  )
  expect(view.getByText('A\u0301')).toBeTruthy()
  expect(view.container.querySelector('img')).toBeNull()
})

it('renders the canonical generated mark instead of an initial when no photo exists', () => {
  window.atumMatrix = {} as MatrixUiBridge
  const view = render(
    <MatrixProfileAvatar
      className="size-8"
      id={target.principal}
      mark={{ shape: 'heart', color: 'coral' }}
      name="Helper"
      scopeKey="human/MAC"
      target={target}
    />
  )
  expect(view.container.querySelector('[data-atum-agent-mark="heart:coral"]')).toBeTruthy()
  expect(view.queryByText('H')).toBeNull()
  expect(view.container.querySelector('img')).toBeNull()
})

it('cannot paint a late read from an old account/media revision, and ignores a mismatched SDK identity', async () => {
  let finish!: (value: MatrixProfile) => void

  const read = vi
    .fn<MatrixProfilesBridge['read']>()
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    .mockResolvedValue({ ...profile, userId: '@other:test', avatarUrl: dataUrl })

  window.atumMatrix = { profiles: { read } } as unknown as MatrixUiBridge

  const humanTarget = { kind: 'human' as const }
  const view = render(
    <MatrixProfileAvatar
      className="size-8"
      id={target.principal}
      name="Atum"
      profile={profile}
      scopeKey="old-account/MAC"
      target={humanTarget}
    />
  )

  view.rerender(
    <MatrixProfileAvatar
      className="size-8"
      id={target.principal}
      name="Atum"
      profile={{ ...profile, avatarMxc: 'mxc://matrix.test/new' }}
      scopeKey="new-account/MAC"
      target={humanTarget}
    />
  )
  await act(async () => finish({ ...profile, avatarUrl: dataUrl }))
  expect(view.container.querySelector('img')).toBeNull()
  expect(view.getByText('A')).toBeTruthy()
})
