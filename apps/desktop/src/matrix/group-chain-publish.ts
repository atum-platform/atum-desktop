import { CHAIN_DEPTH_MAX } from '../../shared/room-participation/limits'
import { groupTypedMentions } from '../../shared/room-participation/mentions'
import type { GroupChainPublication } from '../../shared/room-participation/runtime'
import type { ChainStamp } from '../../shared/room-participation/types'

export const GROUP_CHAIN_KEY = 'io.atum.chain'

/** Stamps are untrusted content. Only the native ancestor walk and canonical claim authorize them. */
export function parseGroupChain(value: unknown): ChainStamp | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return
  }

  const row = value as Record<string, unknown>
  const event = (value: unknown) => typeof value === 'string' && /^\$\S+$/.test(value) && value.length <= 1024

  if (
    Object.keys(row).length !== 3 ||
    !event(row.origin) ||
    !event(row.parent) ||
    !Number.isSafeInteger(row.depth) ||
    Number(row.depth) < 1 ||
    Number(row.depth) > CHAIN_DEPTH_MAX
  ) {
    return
  }

  return { origin: row.origin as string, parent: row.parent as string, depth: Number(row.depth) }
}

/** Native supplies the current joined own roster and owner origin after the claim. */
export function groupChainPublication(body: string, value: GroupChainPublication) {
  const chain = parseGroupChain({ origin: value.origin, parent: value.parent, depth: value.depth })

  if (!chain) {
    throw new Error('matrix_group_chain_invalid')
  }

  const mentions = groupTypedMentions(body, value.recipients)

  return { [GROUP_CHAIN_KEY]: chain, ...(mentions.length ? { 'm.mentions': { user_ids: mentions } } : {}) }
}
