import { parseRoomPolicy, parseRoomUsage } from '../../../shared/room-participation'
import type { GroupPolicyRead } from '../../../shared/room-participation/runtime'

/** The native boundary checks SDK projections before acting on them. */
export function requireGroupPolicyRead(value: unknown): GroupPolicyRead {
  const read = value as Partial<GroupPolicyRead> | null
  const policy = parseRoomPolicy(read?.policy)
  const usage = parseRoomUsage(read?.usage)

  if (!read || !read.policy || !policy.ok || !usage.ok) {throw new Error('matrix_group_policy_unreadable')}

  return { policy: policy.value, usage: usage.value }
}
