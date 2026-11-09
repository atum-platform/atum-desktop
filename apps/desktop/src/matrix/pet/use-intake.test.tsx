import { act, cleanup, renderHook } from '@testing-library/react'
import { createClient, EventType, MatrixEvent, Room, RoomEvent } from 'matrix-js-sdk'
import { afterEach, expect, it, vi } from 'vitest'

import type { MatrixSnapshot } from '../../../shared/matrix'
import { createEngineState, decide } from '../../../shared/pet-engine/decide'
import { profileFor } from '../../../shared/pet-engine/profile'
import { matrixMessage } from '../message'

import type { PetIntentMessage } from './intake'
import { createPetLiveEvents } from './live-events'
import { holdPetPresentation } from './store'
import { usePetIntentIntake } from './use-intake'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function snapshot(): MatrixSnapshot {
  return {
    state: 'ready',
    identity: { userId: '@owner:test', deviceId: 'DEVICE' },
    petScope: 'account:1',
    rooms: [
      {
        id: '!room:test',
        name: 'Agent',
        membership: 'join',
        encrypted: true,
        direct: true,
        assistant: true,
        agentPrincipal: '@agent:test'
      }
    ],
    roomId: '!room:test',
    messages: [],
    error: null
  }
}

function encrypted(
  id: string,
  mixin: unknown = { v: 1, intents: [{ action: 'go', place: 'left' }, { action: 'wave' }] }
) {
  const event = new MatrixEvent({
    type: EventType.RoomMessage,
    room_id: '!room:test',
    event_id: id,
    sender: '@agent:test',
    origin_server_ts: Date.now(),
    content: { msgtype: 'm.text', body: 'Here is my reply', 'io.atum.pet': mixin }
  })

  event.makeEncrypted(
    EventType.RoomMessageEncrypted,
    { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'synthetic' },
    'curve',
    'ed'
  )

  return event
}

it('projects a real SDK encrypted event, excludes SDK backfill, and delivers ordered commands to the engine', () => {
  const client = createClient({ baseUrl: 'https://example.invalid', userId: '@owner:test' })
  const live = createPetLiveEvents<MatrixEvent>()
  live.loaded('!room:test')
  client.on(RoomEvent.Timeline, (event, room, toStart, removed, data) =>
    live.observed(event, room?.roomId ?? '', Boolean(toStart), Boolean(removed), data?.liveEvent === true)
  )
  const room = new Room('!room:test', client, '@owner:test')
  const event = encrypted('$live')
  client.emit(RoomEvent.Timeline, event, room, false, false, { liveEvent: true, timeline: room.getLiveTimeline() })
  const history = encrypted('$history')
  client.emit(RoomEvent.Timeline, history, room, true, false, { liveEvent: true, timeline: room.getLiveTimeline() })
  const current = snapshot()
  current.messages = [
    matrixMessage(history, '@owner:test', new Set(), room, live.has(history, room.roomId))!,
    matrixMessage(event, '@owner:test', new Set(), room, live.has(event, room.roomId))!
  ]
  const presentation = holdPetPresentation(JSON.stringify(['account:1', '@agent:test']), 0)

  const { rerender, unmount } = renderHook(({ value }) => usePetIntentIntake(value, true, false, true), {
    initialProps: { value: current }
  })

  expect(presentation.store.get().commands).toEqual([{ action: 'go', place: 'left' }, { action: 'wave' }])
  const batch = presentation.store.get().commands

  const state = createEngineState({
    now: 0,
    x: 150,
    y: 100,
    profile: profileFor('walk'),
    stateRows: ['idle', 'wave', 'walk']
  })

  expect(
    decide(
      state,
      { width: 300, floorY: 100, free: [{ left: 0, right: 200 }], perches: [] },
      { work: 'idle', idleMs: 0, away: false, reducedMotion: false },
      batch,
      () => 0.9
    ).state.pendingCommands
  ).toEqual([{ action: 'wave' }])
  rerender({ value: { ...current, messages: [...current.messages] } })
  expect(presentation.store.get().commands).toBe(batch)
  unmount()
  presentation.release()
})

it('consumes hidden/reduced replies without delayed replay and isolates sign-out/account retirement', () => {
  const current = snapshot()
  const event = encrypted('$hidden')
  current.messages = [matrixMessage(event, '@owner:test', new Set(), undefined, true)!]

  const { rerender, unmount } = renderHook(
    ({ value, shown, reduced }) => usePetIntentIntake(value, shown, reduced, true),
    { initialProps: { value: current, shown: false, reduced: false } }
  )

  const principal = JSON.stringify(['account:1', '@agent:test'])
  const presentation = holdPetPresentation(principal, 0)
  expect(presentation.store.get().commands).toEqual([])
  rerender({ value: current, shown: true, reduced: false })
  expect(presentation.store.get().commands).toEqual([])
  const fresh = matrixMessage(encrypted('$reduced'), '@owner:test', new Set(), undefined, true) as PetIntentMessage
  rerender({ value: { ...current, messages: [fresh] }, shown: true, reduced: true })
  rerender({ value: { ...current, messages: [fresh] }, shown: true, reduced: false })
  expect(presentation.store.get().commands).toEqual([])
  act(() =>
    rerender({ value: { ...current, identity: null, state: 'signed_out', messages: [] }, shown: true, reduced: false })
  )
  unmount()
  presentation.release()
  const replacement = holdPetPresentation(principal, 1)
  expect(replacement.store.get().commands).toEqual([])
  replacement.release()
})

it('keeps malformed cosmetic data from hiding the normal decrypted text', () => {
  const message = matrixMessage(
    encrypted('$bad', { v: 1, intents: [{ action: 'wave', text: 'secret' }] }),
    '@owner:test',
    new Set()
  )

  expect(message?.body).toBe('Here is my reply')
  expect(message).not.toHaveProperty('petIntents')
})
