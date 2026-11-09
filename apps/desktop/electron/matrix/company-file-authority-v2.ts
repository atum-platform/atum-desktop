import type { MatrixRoom } from '../../shared/matrix'
import type { MatrixCompanySnapshot11, MatrixCompanyValue } from '../../shared/matrix-company'
import type {
  CompanyChannelAdmittedDirectory14Response,
  CompanyConversationDirectory15Response
} from '../../shared/matrix-company-team-space'

import type { CompanyDirectoryAccount } from './company-directory'
import { readCompanyChannelDirectory } from './company-directory'
import { MatrixCompanyFileError } from './company-files'
import type { MatrixCompanyFileAuthorityV2 } from './company-files-v2'

interface AuthorityAccount extends CompanyDirectoryAccount {
  company(input: { action: 'conversations' | 'read'; companyId: string }, signal: AbortSignal): Promise<MatrixCompanyValue>
}

export type MatrixCompanyFileAuthorityResolution =
  | { kind: 'v2'; authority: MatrixCompanyFileAuthorityV2 }
  | { kind: 'legacy-public'; companyId: string; channelId: string }

const denied = (): never => { throw new MatrixCompanyFileError('denied', undefined, 'revoked') }

function admittedDirectory(value: unknown): value is CompanyChannelAdmittedDirectory14Response {
  return Boolean(value && typeof value === 'object' && Array.isArray(Reflect.get(value, 'channels')) &&
    Reflect.get(value, 'channels').every((item: unknown) => item && typeof item === 'object' && Reflect.has(item, 'selfAdmission')))
}

function conversations(value: unknown): value is CompanyConversationDirectory15Response {
  return Boolean(value && typeof value === 'object' && Array.isArray(Reflect.get(value, 'conversations')))
}

function companySnapshot(value: unknown): value is MatrixCompanySnapshot11 {
  return Boolean(value && typeof value === 'object' && Reflect.get(value, 'schemaVersion') === 2 &&
    Array.isArray(Reflect.get(value, 'members')))
}

/** A fresh platform read supplies the epoch and generation used by the file grant. Renderer rosters grant nothing. */
export async function resolveCompanyFileAuthorityV2(
  account: AuthorityAccount,
  room: MatrixRoom,
  operation: 'upload' | 'download',
  signal: AbortSignal
): Promise<MatrixCompanyFileAuthorityResolution> {
  const channel = room.companyChannel

  if (channel) {
    const directory = await readCompanyChannelDirectory(account, channel.companyId, signal)

    if (!admittedDirectory(directory)) {
      // The frozen 1.1 path remains valid only for the historical company-wide public channel family.
      const legacy = directory.channels.find(item => item.channel.id === channel.channelId &&
        item.channel.companyId === channel.companyId && item.room.state === 'ready' && item.room.roomId === room.id)

      if (!legacy) {return denied()}

      return { kind: 'legacy-public', companyId: channel.companyId, channelId: channel.channelId }
    }

    const item = directory.channels.find(value => value.channel.id === channel.channelId &&
      value.channel.companyId === channel.companyId && value.room.state === 'ready' && value.room.roomId === room.id)

    if (!item || item.selfAdmission.state !== 'active' || operation === 'upload' && item.channel.state !== 'active') {return denied()}

    return { kind: 'v2', authority: {
      companyId: channel.companyId,
      audience: { kind: 'channel', channel_id: channel.channelId, visibility: item.channel.visibility },
      viewerAdmissionEpoch: item.selfAdmission.admissionEpoch,
      audienceGeneration: item.channel.channelGeneration
    } }
  }

  const binding = room.companyConversation

  if (!binding) {throw new MatrixCompanyFileError('unsupported')}

  const [listed, snapshot] = await Promise.all([
    account.company({ action: 'conversations', companyId: binding.companyId }, signal),
    account.company({ action: 'read', companyId: binding.companyId }, signal)
  ])

  if (!conversations(listed) || !companySnapshot(snapshot)) {throw new MatrixCompanyFileError('unsupported')}

  const conversation = listed.conversations.find(value => value.id === binding.conversationId &&
    value.companyId === binding.companyId && value.room.state === 'ready' && value.room.roomId === room.id)

  const selfRef = snapshot.members.find(member => member.self && member.state === 'active')?.memberRef
  const participant = selfRef ? conversation?.participants.find(value => value.memberRef === selfRef) : undefined

  if (!conversation || !participant || operation === 'upload' && conversation.state !== 'active') {return denied()}

  return { kind: 'v2', authority: {
    companyId: binding.companyId,
    audience: { kind: 'conversation', conversation_id: binding.conversationId },
    viewerAdmissionEpoch: participant.admissionEpoch,
    audienceGeneration: conversation.conversationGeneration
  } }
}
