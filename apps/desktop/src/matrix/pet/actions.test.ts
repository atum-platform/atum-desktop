import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'

import type { MatrixPetBridge, MatrixPetView } from '../../../shared/matrix-pet'

import { usePetActions } from './actions'
import type { PetSelection } from './selection'

function view(
  value: Partial<MatrixPetView> = {},
  pet: MatrixPetView['selection']['pet'] = {
    ref: { kind: 'bundled', slug: 'cookie' },
    enabled: true,
    scale: 1
  }
): MatrixPetView {
  return {
    freshness: 'current',
    sprite: { enabled: true, displayName: 'Cookie', slug: 'cookie', spritesheetBase64: 'sprite', scale: 1 },
    selection: {
      owner: 'owner',
      agent: 'agent',
      revision: 1,
      pet,
      provenance: 'explicit',
      access: 'owned',
      visitEndsAt: null,
      serverTime: '2026-10-27T00:00:00Z'
    },
    ...value
  }
}

function setup(value: MatrixPetView = view(), properties: Partial<Parameters<typeof usePetActions>[0]> = {}) {
  const selection = {
    view: value,
    error: undefined,
    canEdit: true,
    write: vi.fn(async () => value)
  } as unknown as PetSelection

  return renderHook(() =>
    usePetActions({
      principal: 'account:1:agent',
      selection,
      openPicker: vi.fn(),
      closePicker: vi.fn(),
      pickerOpen: false,
      ...properties
    })
  )
}

it('derives the companion ref from the saved pet or the Gigi stand-in', () => {
  const bundled = setup()
  expect(bundled.result.current.chatRef).toEqual({ kind: 'bundled', slug: 'cookie' })
  bundled.unmount()

  const personal = setup(
    view({}, { ref: { kind: 'personal', pet_id: '00000000-0000-4000-8000-25c26055aeb6' }, enabled: true, scale: 1 })
  )
  expect(personal.result.current.chatRef).toEqual({
    kind: 'personal',
    pet_id: '00000000-0000-4000-8000-25c26055aeb6'
  })
  personal.unmount()

  const standIn = setup(
    view(
      { standIn: true, sprite: { enabled: true, displayName: 'Gigi', slug: 'gigi', spritesheetBase64: 'sprite' } },
      null
    )
  )
  expect(standIn.result.current.chatRef).toEqual({ kind: 'bundled', slug: 'gigi' })
  standIn.unmount()

  const unsupported = setup(
    view({ sprite: { enabled: true, displayName: 'Rex', slug: 'rex', spritesheetBase64: 'sprite' } }, null)
  )
  expect(unsupported.result.current.chatRef).toBeUndefined()
})

it('offers chat only with a visible pet, a closed ref and the companion bridge', () => {
  const chat = vi.fn() as MatrixPetBridge['chat']
  const history = vi.fn() as MatrixPetBridge['chatHistory']
  const without = setup()
  expect(without.result.current.actions.find(action => action.id === 'chat')?.disabled).toBe(true)
  without.unmount()

  const withBridge = setup(view(), { chat, history })
  expect(withBridge.result.current.actions.find(action => action.id === 'chat')?.disabled).toBe(false)
  expect(withBridge.result.current.chat).toBe(chat)
  expect(withBridge.result.current.history).toBe(history)
})

it('applies an allowlisted action once and drops it when the pet is hidden', async () => {
  const shown = setup()
  await waitFor(() => expect(shown.result.current.presentation.commands).toEqual([]))
  act(() => shown.result.current.onChatAction({ action: 'sit' }))
  await waitFor(() => expect(shown.result.current.presentation.commands).toEqual([{ action: 'sit' }]))
  act(() => shown.result.current.onChatAction({ action: 'go', place: 'center' }))
  await waitFor(() => expect(shown.result.current.presentation.commands).toEqual([{ action: 'go', place: 'center' }]))
  act(() => shown.result.current.onChatAction({ action: 'sleep' }))
  await waitFor(() => expect(shown.result.current.presentation.commands).toEqual([{ action: 'sleep' }]))
  shown.unmount()

  const hidden = setup(view({ sprite: undefined }))
  await waitFor(() => expect(hidden.result.current.presentation.commands).toEqual([]))
  act(() => hidden.result.current.onChatAction({ action: 'wave' }))
  expect(hidden.result.current.presentation.commands).toEqual([])
})
