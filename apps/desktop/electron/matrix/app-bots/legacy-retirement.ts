import type { AppBotTrustState } from './trust'

/** All conditions are per person; an unavailable app never removes a working legacy copy. */
export interface AppBotLegacyRetirementReadiness {
  botState: AppBotTrustState
  officialDmExists: boolean
  botJoinedOfficialDm: boolean
  consentAccepted: boolean
  linkReady: boolean
  firstBotAnswerReceived: boolean
}

export function canRetireLegacyAppCopy(readiness: AppBotLegacyRetirementReadiness): boolean {
  return (
    readiness.botState === 'active' &&
    readiness.officialDmExists &&
    readiness.botJoinedOfficialDm &&
    readiness.consentAccepted &&
    readiness.linkReady &&
    readiness.firstBotAnswerReceived
  )
}

/** A per-person host suppresses itself whenever the official bot is a room member. */
export function legacyAppCopyDisposition(roomMembers: readonly string[], botUserId: string): 'ignored' | 'eligible' {
  return roomMembers.includes(botUserId) ? 'ignored' : 'eligible'
}
