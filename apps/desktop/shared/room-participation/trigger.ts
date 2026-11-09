import type { GroupTriggerFacts, TriggerKind } from './types'

export function classifyGroupTrigger(facts: GroupTriggerFacts): TriggerKind {
  if (
    facts.senderUserId !== facts.ownerUserId ||
    !facts.senderVerified ||
    facts.eventKind !== 'text' ||
    facts.mode === 'off' ||
    !facts.ownAgentIds.includes(facts.agentUserId)
  ) {
    return 'none'
  }

  const named = facts.mentions.filter(id => facts.ownAgentIds.includes(id))

  if (named.length) {
    return named.includes(facts.agentUserId) ? 'named' : 'none'
  }

  if (facts.replySenderId && facts.ownAgentIds.includes(facts.replySenderId)) {
    return facts.replySenderId === facts.agentUserId ? 'named' : 'none'
  }

  return facts.roomMode === 'meeting' && facts.mode === 'joins' ? 'everyone' : 'none'
}
