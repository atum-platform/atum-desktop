import type { MatrixRoom } from '../../shared/matrix'
import type { MatrixCompanyPresentationBinding } from '../../shared/matrix-company-presentation'

import type { CompanyAIView } from './company-desktop-adapter'
import { companyPrivateCosRoom, type CompanyPrivateCosState } from './team-space/private-cos-store'

/**
 * The bound company agent a room's agent-turns/1.6 working lines and interim remarks must come from.
 * A channel: the company's own Chief of Staff (its platform view) in that channel. A private Chief of
 * Staff room: the platform's ready pair binding for exactly this joined room. Display only; without a
 * binding no company line or remark is drawn as one (the standard message remains).
 */
export function companyChannelPresentationBinding(
  room: Pick<MatrixRoom, 'companyChannel' | 'id'> | undefined,
  view: Pick<CompanyAIView, 'agent' | 'companyId'> | undefined
): MatrixCompanyPresentationBinding | undefined {
  const channel = room?.companyChannel

  if (!room || !channel || !view || view.companyId !== channel.companyId) {
    return undefined
  }

  return {
    companyId: channel.companyId,
    agentPrincipal: view.agent.principal,
    agentUserId: view.agent.userId,
    roomId: room.id,
    audience: { kind: 'channel', channelId: channel.channelId }
  }
}

export function privateCosPresentationBinding(
  state: CompanyPrivateCosState | undefined,
  room: MatrixRoom | undefined
): MatrixCompanyPresentationBinding | undefined {
  const view = state?.view

  if (!room || view?.state !== 'ready' || companyPrivateCosRoom(state, [room])?.id !== room.id) {
    return undefined
  }

  return {
    companyId: view.pair.companyPrincipal,
    agentPrincipal: view.binding.agentPrincipal,
    agentUserId: view.binding.agentUserId,
    roomId: view.binding.roomId,
    audience: {
      kind: 'private',
      memberPrincipal: view.pair.memberPrincipal,
      membershipIncarnation: view.pair.membershipIncarnation
    }
  }
}
