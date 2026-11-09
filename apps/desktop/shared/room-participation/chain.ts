import { CHAIN_DEPTH_MAX, CHAIN_ORIGIN_AGE_MS, CHAIN_TURNS_MAX } from './limits'
import type { RoomPort } from './ports'
import type { ChainDecision, ChainFacts, ChainRefusal } from './types'

const refuse = (code: ChainRefusal): ChainDecision => ({ allowed: false, code })

/** Read each ancestor through the owner SDK; event stamps supply no authority themselves. */
export async function verifyChain(facts: ChainFacts, port: Pick<RoomPort, 'readOwnerEvent'>): Promise<ChainDecision> {
  if (facts.roomMode !== 'meeting') {
    return refuse('shared_room')
  }

  if (facts.spokenAgentIds.at(-1) === facts.agentUserId) {
    return refuse('repeat_agent')
  }

  if (!Number.isSafeInteger(facts.originTurns) || facts.originTurns >= CHAIN_TURNS_MAX) {
    return refuse('origin_cap')
  }

  if (facts.originTurns < 1) {
    return refuse('invalid_chain')
  }

  if (!facts.budgetAllowed) {
    return refuse('room_cap')
  }

  if (!facts.ownAgentIds.includes(facts.agentUserId)) {
    return refuse('foreign_sender')
  }

  let id = facts.eventId
  let origin = ''
  let depth = 0
  let remaining = 0
  let childSender = ''
  let childAt = facts.now
  const seen = new Set<string>()

  for (let walked = 0; walked <= CHAIN_DEPTH_MAX; walked++) {
    if (seen.has(id)) {
      return refuse('invalid_chain')
    }

    seen.add(id)
    const event = await port.readOwnerEvent(facts.roomId, id)

    if (!event) {
      return refuse('missing_event')
    }

    if (event.eventId !== id || event.roomId !== facts.roomId || event.eventKind !== 'text') {
      return refuse('invalid_chain')
    }

    if (!event.senderVerified) {
      return refuse('untrusted_sender')
    }

    if (event.senderUserId === facts.ownerUserId) {
      if (!origin || id !== origin || remaining !== 0 || event.chain) {
        return refuse('invalid_chain')
      }

      if (!Number.isSafeInteger(event.at) || event.at > facts.now || facts.now - event.at > CHAIN_ORIGIN_AGE_MS) {
        return refuse('stale_origin')
      }

      const named = event.mentions.filter(sender => facts.ownAgentIds.includes(sender))

      if ((named.length && !named.includes(childSender)) || event.at > childAt) {
        return refuse('invalid_chain')
      }

      return { allowed: true, origin, depth }
    }

    if (!facts.ownAgentIds.includes(event.senderUserId)) {
      return refuse(walked === 0 ? 'foreign_sender' : 'invalid_chain')
    }

    if (
      !Number.isSafeInteger(event.at) ||
      event.at < 0 ||
      event.at > childAt ||
      event.at > facts.now ||
      (childSender && !event.mentions.includes(childSender))
    ) {
      return refuse('invalid_chain')
    }

    // A can answer B after A handed work to B. Only an immediate self-handoff is
    // refused; the existing event, depth, turn, age and budget bounds still cap loops.
    if ((walked === 0 && event.senderUserId === facts.agentUserId) || event.senderUserId === childSender) {
      return refuse('repeat_agent')
    }

    if (walked === 0 && !event.mentions.includes(facts.agentUserId)) {
      return refuse('not_addressed')
    }

    const stamp = event.chain

    if (
      !stamp ||
      !Number.isInteger(stamp.depth) ||
      stamp.depth < 1 ||
      stamp.depth > CHAIN_DEPTH_MAX ||
      !stamp.origin ||
      !stamp.parent
    ) {
      return refuse('invalid_chain')
    }

    if (walked === 0) {
      origin = stamp.origin
      depth = stamp.depth
      remaining = depth
    }

    if (stamp.origin !== origin || stamp.depth !== remaining) {
      return refuse('invalid_chain')
    }

    remaining--
    childSender = event.senderUserId
    childAt = event.at
    id = stamp.parent
  }

  return refuse('invalid_chain')
}
