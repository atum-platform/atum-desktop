import { render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MatrixUiBridge } from '../../shared/matrix'

import { MatrixMemberAvatar } from './member-avatar'
import { $matrixMemberAvatars, loadMatrixMemberAvatar } from './member-avatars'

const AVATAR = 'data:image/png;base64,iVBORw0KGgo='

beforeEach(() => {
  $matrixMemberAvatars.set({})
})

afterEach(() => {
  Reflect.deleteProperty(window, 'atumMatrix')
  vi.restoreAllMocks()
})

describe('member avatars', () => {
  it("paints a person's authenticated photo in place of their initial", async () => {
    const member = vi.fn(async (userId: string) => ({ userId, avatarUrl: AVATAR }))

    window.atumMatrix = { profiles: { member } } as unknown as MatrixUiBridge

    const { container } = render(
      <MatrixMemberAvatar avatarMxc="mxc://matrix.test/linh" className="size-6" id="@linh:test" name="Linh" />
    )

    await waitFor(() => expect(container.querySelector('img')?.getAttribute('src')).toBe(AVATAR))
    expect(member).toHaveBeenCalledWith('@linh:test')
  })

  it('asks once per person and media revision, and keeps the initial when there is no photo', async () => {
    const member = vi.fn(async (userId: string) => ({ userId, avatarUrl: null }))

    window.atumMatrix = { profiles: { member } } as unknown as MatrixUiBridge
    loadMatrixMemberAvatar('@quan:test', 'mxc://matrix.test/quan')
    loadMatrixMemberAvatar('@quan:test', 'mxc://matrix.test/quan')
    await waitFor(() => expect(member).toHaveBeenCalledTimes(1))
    expect($matrixMemberAvatars.get()['@quan:test']).toEqual({
      mxc: 'mxc://matrix.test/quan',
      avatarUrl: null
    })

    loadMatrixMemberAvatar('@quan:test', 'mxc://matrix.test/quan-2')
    await waitFor(() => expect(member).toHaveBeenCalledTimes(2))
  })

  it("keeps a person's initial rather than a broken image when the bridge fails", async () => {
    const member = vi.fn(async () => Promise.reject(new Error('unavailable')))

    window.atumMatrix = { profiles: { member } } as unknown as MatrixUiBridge

    const { container } = render(
      <MatrixMemberAvatar avatarMxc="mxc://matrix.test/lan" className="size-6" id="@lan:test" name="Lan" />
    )

    await waitFor(() => expect(member).toHaveBeenCalled())
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toBe('L')
  })
})
