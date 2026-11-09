import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  type ThreadMessageLike,
  useExternalStoreRuntime
} from '@assistant-ui/react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { MatrixRoom, MatrixSnapshot } from '../../../shared/matrix'
import { MATRIX_ASSISTANT_ROOM_TYPE } from '../../../shared/matrix-assistant-room'
import type { MatrixStoreItem } from '../../../shared/matrix-store'

import { $matrixStoreDraft, MatrixStoreDraftSeed, matrixStoreTryAction, matrixStoreTryRoom } from './store-try'

afterEach(() => {
  cleanup()
  $matrixStoreDraft.set(null)
  Reflect.deleteProperty(window, 'atumMatrix')
})

const OWNER = '@owner:test'
const ATUM = '@atum:test'
const MOON = '@moon:test'
const ATUM_ID = '00000000-0000-4000-8000-8bf0ba5bdf79'
const MOON_ID = '00000000-0000-4000-8000-141ebcee2e7f'

function room(id: string, agent: string, principal: string, lastActiveAt: number): MatrixRoom {
  return {
    id,
    name: id,
    membership: 'join',
    encrypted: true,
    roomType: MATRIX_ASSISTANT_ROOM_TYPE,
    agentPrincipal: principal,
    lastActiveAt,
    participants: [
      { userId: OWNER, membership: 'join' },
      { userId: agent, membership: 'join' }
    ]
  }
}

const snapshot: MatrixSnapshot = {
  state: 'ready',
  identity: { userId: OWNER, deviceId: 'D' },
  assistant: { userId: ATUM, deviceId: 'A' },
  rooms: [
    room('!atum-old:test', ATUM, 'agent-atum', 1),
    room('!atum-new:test', ATUM, 'agent-atum', 5),
    room('!moon:test', MOON, 'agent-moon', 3)
  ],
  roomId: null,
  messages: [],
  error: null,
  agents: [
    {
      principal: 'agent-atum',
      userId: ATUM,
      assistantId: ATUM_ID,
      isDefault: true,
      ready: true,
      hermes: 'ready',
      atumModel: true
    },
    {
      principal: 'agent-moon',
      userId: MOON,
      assistantId: MOON_ID,
      name: 'Moon',
      isDefault: false,
      ready: true,
      hermes: 'ready',
      atumModel: true
    }
  ]
}

const skill = {
  kind: 'skill',
  itemId: 'skill/trip-planner',
  tryPrompt: { en: 'Plan a weekend in Đà Lạt.', vi: 'Lên kế hoạch cuối tuần ở Đà Lạt.' }
} as unknown as MatrixStoreItem

describe('Try it now', () => {
  it('tries a skill in the newest chat with the assistant that has it, and a pet with the default assistant', () => {
    expect(matrixStoreTryRoom(snapshot, skill, MOON_ID)).toBe('!moon:test')
    expect(matrixStoreTryRoom(snapshot, skill, ATUM_ID)).toBe('!atum-new:test')
    expect(matrixStoreTryRoom(snapshot, { kind: 'pet' }, MOON_ID)).toBe('!atum-new:test')
  })

  it('offers nothing when that assistant has no chat yet', () => {
    expect(matrixStoreTryRoom({ ...snapshot, rooms: [] }, skill, MOON_ID)).toBeNull()
    expect(matrixStoreTryAction({ ...snapshot, rooms: [] }, skill, MOON_ID, 'en')).toBeNull()
  })

  it('opens the chat and leaves the example, unsent, for its composer', async () => {
    const command = vi.fn(async () => null)
    window.atumMatrix = { command } as unknown as typeof window.atumMatrix

    matrixStoreTryAction(snapshot, skill, MOON_ID, 'vi')!()
    expect($matrixStoreDraft.get()).toEqual({ roomId: '!moon:test', text: 'Lên kế hoạch cuối tuần ở Đà Lạt.' })
    await waitFor(() => expect(command).toHaveBeenCalledWith({ kind: 'select', roomId: '!moon:test' }))
  })
})

function Composer({ roomId }: { roomId: string }) {
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: [],
    convertMessage: message => message,
    onNew: async () => {}
  })

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <MatrixStoreDraftSeed roomId={roomId} />
      <ComposerPrimitive.Root>
        <ComposerPrimitive.Input aria-label="Message" data-slot="composer-rich-input" />
      </ComposerPrimitive.Root>
    </AssistantRuntimeProvider>
  )
}

describe('the composer seed', () => {
  it('puts the draft for its own chat in the box once, and leaves another chat’s draft alone', async () => {
    render(<Composer roomId="!moon:test" />)

    act(() => $matrixStoreDraft.set({ roomId: '!atum-new:test', text: 'Not for Moon' }))
    expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).value).toBe('')
    expect($matrixStoreDraft.get()).not.toBeNull()

    act(() => $matrixStoreDraft.set({ roomId: '!moon:test', text: 'Plan a weekend in Đà Lạt.' }))
    await waitFor(() =>
      expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).value).toBe(
        'Plan a weekend in Đà Lạt.'
      )
    )
    expect($matrixStoreDraft.get()).toBeNull()
  })
})
