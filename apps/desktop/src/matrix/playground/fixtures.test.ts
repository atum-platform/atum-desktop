import { expect, it } from 'vitest'

import { appBotDisclosureVersion } from '../../../shared/app-catalog'
import { matrixModelRouteId } from '../../../shared/matrix-models'
import { directAppBotForRoom } from '../app-bots/direct-app'

import { playgroundBridge, PlaygroundStore } from './bridge'
import { PLAYGROUND_MESSAGES, scenarioSnapshot } from './fixtures'
import {
  PLAYGROUND_COMPANY_CHANNEL_ID,
  PLAYGROUND_COMPANY_ID,
  PLAYGROUND_COMPANY_ROOM_ID,
  playgroundPlaceBridges,
  playgroundPlaces
} from './places-fixtures'

it('keeps connected routes local and reads a validated selection back from the same catalog', async () => {
  const store = new PlaygroundStore('chat-model-picker', 'en')
  const bridge = playgroundBridge(store)
  const roomId = store.current.roomId!

  expect(store.current.displayPreferences).not.toHaveProperty('modelPicker')
  expect(store.current.agents?.find(agent => agent.isDefault)).toMatchObject({
    answering: 'cloud',
    macRole: 'standby',
    cloudModel: { current: 'default' }
  })

  const before = await bridge.modelCatalog!(roomId)
  expect(before.destination).toBe('this_mac')
  expect(before.routes.every(route => route.destination === 'this_mac')).toBe(true)
  expect(before.routes.find(route => route.current)?.id).toBe(
    matrixModelRouteId('openai-codex', 'gpt-5.6-sol')
  )
  expect(before.accounts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: 'openai-codex', connection: 'plan', ready: true }),
      expect.objectContaining({ id: 'anthropic', connection: 'key', ready: true }),
      expect.objectContaining({ id: 'ollama', connection: 'local', ready: true }),
      expect.objectContaining({ id: 'openrouter', ready: false })
    ])
  )

  const anthropic = matrixModelRouteId('anthropic', 'claude-sonnet-4-6')
  await expect(bridge.selectModelRoute!(roomId, anthropic, 'conversation_override')).rejects.toThrow(
    'matrix_connected_model_unavailable'
  )
  await expect(bridge.selectModelRoute!(roomId, anthropic, 'agent_default')).resolves.toEqual({
    status: 'applied',
    current: anthropic
  })

  const after = await bridge.modelCatalog!(roomId)
  expect(after.current).toBe(anthropic)
  expect(after.routes.find(route => route.current)).toMatchObject({
    id: anthropic,
    provider: 'anthropic',
    destination: 'this_mac'
  })
  expect(store.current.localModel).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-4-6' })

  await bridge.command({ kind: 'setModel', roomId, model: 'nhat-thuc' })
  expect(store.current.agents?.find(agent => agent.isDefault)?.cloudModel?.current).toBe('nhat-thuc')
  expect((await bridge.modelCatalog!(roomId)).current).toBe(anthropic)
})

it('provides one canonical linked Moon room with menu, status and private history capabilities', async () => {
  const snapshot = scenarioSnapshot('chat-moon-app')
  const room = snapshot.rooms.find(each => each.id === snapshot.roomId)!
  const moon = directAppBotForRoom(snapshot, room)!
  const bridges = playgroundPlaceBridges(playgroundPlaces(new URLSearchParams()), () => snapshot)

  expect(room).toMatchObject({ direct: true, encrypted: true, membership: 'join' })
  expect(room.participants?.map(member => member.userId)).toEqual([
    snapshot.identity!.userId,
    moon.bot!.user_id
  ])
  expect(moon).toMatchObject({ app: 'moon', link: { state: 'linked' }, has_history: true })
  expect(moon.bot).toMatchObject({ state: 'active', consent: 'accepted', open_route_id: 'chat' })
  expect(appBotDisclosureVersion(moon)).toBe(moon.bot!.disclosure_version)

  const menu = await bridges.apps!.menu(moon.app_id)
  expect(menu.routes.filter(route => route.id === moon.bot!.open_route_id)).toHaveLength(1)
  expect(menu.routes.map(route => route.id)).toContain('readings')
  expect(menu.actions?.map(action => action.id)).toEqual(['chat', 'tarot', 'match', 'top-up'])

  const history = await bridges.apps!.history(moon.app_id)
  expect(history.entries.map(entry => entry.role)).toEqual(['owner', 'app'])
  expect(await bridges.apps!.botStatus(moon.app_id)).toMatchObject({
    consent: { state: 'accepted', disclosure_version: moon.bot!.disclosure_version },
    link: { state: 'linked', ready: true, available: true }
  })
})

it('binds the long Team Space fixture to the company directory while Home stays separate', async () => {
  const snapshot = scenarioSnapshot('team-space-threads')
  const companyRoom = snapshot.rooms.find(room => room.id === PLAYGROUND_COMPANY_ROOM_ID)!
  const bridges = playgroundPlaceBridges(playgroundPlaces(new URLSearchParams()), () => snapshot)

  expect(snapshot.companyWorkspaceEnabled).toBe(true)
  expect(snapshot.roomId).toBe(PLAYGROUND_COMPANY_ROOM_ID)
  expect(companyRoom.companyChannel).toEqual({
    companyId: PLAYGROUND_COMPANY_ID,
    channelId: PLAYGROUND_COMPANY_CHANNEL_ID
  })
  expect(companyRoom.encrypted).toBe(false)
  expect(snapshot.messages).toEqual(PLAYGROUND_MESSAGES[PLAYGROUND_COMPANY_ROOM_ID])
  expect(snapshot.messages.length).toBeGreaterThan(20)
  expect(snapshot.threads?.some(thread => thread.replies.length > 0)).toBe(true)

  const listed = await bridges.companies!.request({ action: 'list-channels', companyId: PLAYGROUND_COMPANY_ID })
  expect(listed.ok).toBe(true)
  if (!listed.ok || listed.value.schemaVersion !== 2 || !('channels' in listed.value)) {
    throw new Error('expected company channels v2 fixture')
  }
  expect(listed.value.channels[0]).toMatchObject({
    channel: { id: PLAYGROUND_COMPANY_CHANNEL_ID, companyId: PLAYGROUND_COMPANY_ID },
    room: { state: 'ready', roomId: PLAYGROUND_COMPANY_ROOM_ID }
  })

  const store = new PlaygroundStore('team-space-threads', 'en')
  store.select('!linh:example.invalid')
  expect(store.current.roomId).toBe('!linh:example.invalid')
  expect(store.current.messages).toEqual(PLAYGROUND_MESSAGES['!linh:example.invalid'])
  expect(store.current.rooms.find(room => room.id === PLAYGROUND_COMPANY_ROOM_ID)?.companyChannel).toBeTruthy()

  store.select(PLAYGROUND_COMPANY_ROOM_ID)
  expect(store.current.messages).toEqual(PLAYGROUND_MESSAGES[PLAYGROUND_COMPANY_ROOM_ID])
  expect(store.current.messages.length).toBeGreaterThan(20)
  expect(store.current.members?.length).toBeGreaterThan(0)
})
