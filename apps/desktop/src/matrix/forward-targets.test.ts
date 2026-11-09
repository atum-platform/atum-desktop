import { expect, it } from 'vitest'

import type { MatrixAgentView, MatrixRoom } from '../../shared/matrix'

import { matrixForwardNeedsLocalInvocation, matrixForwardTargets } from './forward-targets'

const owner = '@owner:test'
const company = '00000000-0000-4000-8000-8c031eadb7f3'
const otherCompany = '00000000-0000-4000-8000-6b8e755910f9'
const agent = { userId: '@agent:test', name: 'Atum', ready: true, hermes: 'ready', principal: 'agent', isDefault: true, atumModel: true } as MatrixAgentView
const room = (id: string, extra: Partial<MatrixRoom> = {}): MatrixRoom => ({
  id, name: id, membership: 'join', encrypted: false, canSend: true, lastActiveAt: 1,
  participants: [{ userId: owner, membership: 'join' }, { userId: '@person:test', membership: 'join' }],
  ...extra
})

it('never yields a company source target outside its company except an owned assistant', () => {
  const source = room('!source:test', { companyChannel: { companyId: company, channelId: '00000000-0000-4000-8000-16b7785de2e4' } })
  const same = room('!same:test', { companyChannel: { companyId: company, channelId: '00000000-0000-4000-8000-bc03cb7700cb' } })
  const outside = room('!outside:test')
  const other = room('!other:test', { companyChannel: { companyId: otherCompany, channelId: '00000000-0000-4000-8000-01fa0cf1cb6e' } })
  const assistant = room('!assistant:test', {
    roomType: 'io.atum.assistant', assistant: true,
    participants: [{ userId: owner, membership: 'join' }, { userId: agent.userId, membership: 'join' }]
  })
  const channels = [{ loading: false, channels: [
    { id: source.companyChannel!.channelId, companyId: company, displayName: 'source', state: 'active', room: { state: 'ready', roomId: source.id } },
    { id: same.companyChannel!.channelId, companyId: company, displayName: 'same', state: 'active', room: { state: 'ready', roomId: same.id } },
    { id: other.companyChannel!.channelId, companyId: otherCompany, displayName: 'other', state: 'active', room: { state: 'ready', roomId: other.id } }
  ] }] as never

  const targets = matrixForwardTargets({
    rooms: [source, same, outside, other, assistant], ownerUserId: owner, agents: [agent], sourceRoomId: source.id,
    encryptedFile: false, defaultAssistantName: 'Atum', channelStates: channels
  })

  expect(targets.map(target => target.room.id).sort()).toEqual([assistant.id, same.id, source.id].sort())
})

it('keeps plain rows visible but disables them for an encrypted file', () => {
  const targets = matrixForwardTargets({
    rooms: [room('!plain:test'), room('!encrypted:test', { encrypted: true })],
    ownerUserId: owner, sourceRoomId: '!plain:test', encryptedFile: true, defaultAssistantName: 'Atum'
  })

  expect(targets.find(target => target.room.id === '!plain:test')?.disabled).toBe('encrypted_file')
  expect(targets.find(target => target.room.id === '!encrypted:test')?.disabled).toBeUndefined()
})

it('invokes only the local answer path, so a cloud forward produces exactly one cloud answer', () => {
  const target = { room: room('!assistant:test'), name: 'Atum', assistant: agent }

  expect(matrixForwardNeedsLocalInvocation(target)).toBe(true)
  expect(matrixForwardNeedsLocalInvocation({ ...target, assistant: { ...agent, answering: 'cloud' } })).toBe(false)
})
