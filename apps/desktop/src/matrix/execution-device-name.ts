import type { ExecutionDeviceName } from '../../shared/execution-policy'

/** The Mac model family names a Computer Name may carry. Only a possessive is stripped in front of
 * one of these, so an owner who named their Mac "Mac's Pro" keeps that name (the apostrophe is not
 * a possessive there). */
const MAC_MODEL_PREFIX = /^(?:MacBook|Mac mini|Mac Studio|Mac Pro|iMac)\b/u

/**
 * The owner's Computer Name usually carries the owner's own name — "Owner's MacBook Air",
 * "MacBook Air mẫu" — and a failover row names the Mac, not the person (§9.4
 * "Real names"). Strips the two possessive shapes the platform's registry holds today:
 * a leading "<Name>'s" (English) when what follows is a Mac model, and a trailing
 * " của <Name>" (Vietnamese).
 */
export function withoutDevicePossessive(name: string): string {
  const trimmed = name.trim()
  const variant = /^.+?['’]s\s+(.+)$/u.exec(trimmed)?.[1]?.trim() ?? ''
  const stripped = variant && MAC_MODEL_PREFIX.test(variant) ? variant : trimmed

  return stripped.replace(/\s+của\s+\S.*$/u, '').trim()
}

/**
 * The real name for one Mac: the owner's `displayName` for it with its possessive removed,
 * else the model (`readMatrixMacModel` on this Mac). Undefined when neither says anything,
 * so the caller keeps the stable ordinal name ("Mac 2" / "Máy Mac 2").
 */
export function executionDeviceRealName(device: Pick<ExecutionDeviceName, 'displayName' | 'model'>): string | undefined {
  const named = withoutDevicePossessive(device.displayName)
  const model = device.model ? withoutDevicePossessive(device.model) : ''

  return named || model || undefined
}
