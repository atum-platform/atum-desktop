import { describe, expect, it, vi } from 'vitest'

import type { MatrixRoom } from '../../shared/matrix'

import { resolveCompanyFileAuthorityV2 } from './company-file-authority-v2'

const COMPANY = '00000000-0000-4000-8000-ccee3c97274b'
const CHANNEL = '00000000-0000-4000-8000-830c819b26f5'
const CONVERSATION = '00000000-0000-4000-8000-702d505cafbd'
const ROOM = '!company:test'
const SELF = 's'.repeat(43)
const OTHER = 'o'.repeat(43)

const channelRoom = { id: ROOM, companyChannel: { companyId: COMPANY, channelId: CHANNEL } } as MatrixRoom
const conversationRoom = { id: ROOM, companyConversation: { companyId: COMPANY, conversationId: CONVERSATION } } as MatrixRoom

function channelDirectory(visibility: 'public' | 'private' = 'private') {
  return {
    schemaVersion: 5,
    channels: [{
      channel: { id: CHANNEL, companyId: COMPANY, displayName: 'plans', visibility, state: 'active', topic: '',
        purpose: '', ownerMemberRef: SELF, authorityGeneration: 2, channelGeneration: 9, metadataRevision: 1 },
      selfAdmission: { memberRef: SELF, state: 'active', admissionEpoch: 3, admissionGeneration: 4 },
      memberCount: 2, room: { state: 'ready', roomId: ROOM }, actions: []
    }]
  }
}

function conversation(kind: 'dm' | 'group_dm', state: 'active' | 'read_only' = 'active') {
  return {
    schemaVersion: 6,
    conversations: [{ id: CONVERSATION, companyId: COMPANY, kind, state,
      participants: [
        { memberRef: OTHER, admissionEpoch: 2, handle: 'other', displayName: 'Other' },
        { memberRef: SELF, admissionEpoch: 5, handle: 'me', displayName: 'Me' },
        ...(kind === 'group_dm' ? [{ memberRef: 'z'.repeat(43), admissionEpoch: 7, handle: 'third', displayName: 'Third' }] : [])
      ].sort((left, right) => left.memberRef.localeCompare(right.memberRef)),
      participantSetDigest: 'd'.repeat(64), authorityGeneration: 2, conversationGeneration: 11,
      room: { state: 'ready', roomId: ROOM }, hidden: false }]
  }
}

const company = {
  schemaVersion: 2,
  company: { id: COMPANY, displayName: 'Atum', role: 'member', authorityGeneration: 1 },
  members: [
    { memberRef: SELF, role: 'member', state: 'active', self: true, handle: 'me', displayName: 'Me' },
    { memberRef: OTHER, role: 'member', state: 'active', self: false, handle: 'other', displayName: 'Other' }
  ],
  projects: [], defaultChannelId: CHANNEL
}

describe('current protected-file audience authority', () => {
  it('uses the private channel admission epoch and exact current channel generation', async () => {
    const account = { company: vi.fn(async input => input.action === 'admitted-channels' ? channelDirectory() : company) }
    await expect(resolveCompanyFileAuthorityV2(account as never, channelRoom, 'upload', AbortSignal.timeout(1_000)))
      .resolves.toEqual({ kind: 'v2', authority: {
        companyId: COMPANY,
        audience: { kind: 'channel', channel_id: CHANNEL, visibility: 'private' },
        viewerAdmissionEpoch: 3,
        audienceGeneration: 9
      } })
  })

  it.each(['dm', 'group_dm'] as const)('uses the %s participant set generation and viewer epoch', async kind => {
    const account = { company: vi.fn(async input => input.action === 'conversations' ? conversation(kind) : company) }
    await expect(resolveCompanyFileAuthorityV2(account as never, conversationRoom, 'upload', AbortSignal.timeout(1_000)))
      .resolves.toEqual({ kind: 'v2', authority: {
        companyId: COMPANY,
        audience: { kind: 'conversation', conversation_id: CONVERSATION },
        viewerAdmissionEpoch: 5,
        audienceGeneration: 11
      } })
  })

  it('refuses a revoked conversation participant before reserve or download', async () => {
    const account = { company: vi.fn(async input => input.action === 'conversations'
      ? { schemaVersion: 6, conversations: [] }
      : company) }

    await expect(resolveCompanyFileAuthorityV2(account as never, conversationRoom, 'download', AbortSignal.timeout(1_000)))
      .rejects.toThrow('matrix_company_file_denied')
  })
})
