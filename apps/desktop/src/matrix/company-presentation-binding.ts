import type { MatrixRoom } from '../../shared/matrix'
import type { MatrixCompanyPresentationBinding } from '../../shared/matrix-company-presentation'

import type { CompanyAIView } from './company-desktop-adapter'
import { companyPrivateCosRoom, type CompanyPrivateCosState } from './team-space/private-cos-store'

/**
 * The bound company agent a room's agent-turns/1.6 working lines and interim remarks must come from.
 * A channel: the company's own Chief of Staff, from a platform view read after the channel's latest
 * membership change or stranger marker and within its bounded age (`fresh`: the caller re-reads it,
 * `useCompanyAIStatus`, `useCompanyStrangerSignal`), and joined to the channel. A private Chief of Staff room: the platform's ready pair binding for exactly
 * this joined room, rechecked against the room's live members on every render (`companyPrivateCosRoom`:
 * exactly you and the bound agent joined, the marker's executor), so a reassigned agent joining or the
 * bound one leaving closes it at once; the store re-reads the view on focus, online and its quiet
 * refresh (`recheckCompanyPrivateCos`). Display only, and fail closed: without a
 * binding (unknown or changing) no company line or remark is drawn as one (the standard message remains).
 */
export function companyChannelPresentationBinding(
  room: Pick<MatrixRoom, 'companyChannel' | 'id' | 'participants'> | undefined,
  view: Pick<CompanyAIView, 'agent' | 'companyId'> | undefined,
  fresh: boolean
): MatrixCompanyPresentationBinding | undefined {
  const channel = room?.companyChannel

  if (
    !room ||
    !channel ||
    !view ||
    !fresh ||
    view.companyId !== channel.companyId ||
    !room.participants?.some(member => member.userId === view.agent.userId && member.membership === 'join')
  ) {
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
