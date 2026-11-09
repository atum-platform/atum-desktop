/**
 * Cloud-only desktop policy: assistants live in the cloud. The desktop
 * never offers to move an assistant to a Mac or to make a Mac its home, and every new assistant it
 * creates asks for the cloud. An assistant that already lives on a Mac can still leave for the
 * cloud.
 *
 * This is the ONE place the desktop decides it. It is not a user setting and has no config key:
 * the Mac move/home engine stays in the tree, dormant, and only tests pass `false` to exercise it.
 * Reach-down is untouched: the device service, files, terminal, computer use, the ChatGPT relay,
 * Drive and the Mac source services keep working for cloud assistants.
 */
export const AGENT_HOMES_CLOUD_ONLY = true

/** The places a home surface may offer: under cloud-only, the cloud and nothing else. */
export function offeredHomeKinds(cloudOnly: boolean = AGENT_HOMES_CLOUD_ONLY): ReadonlySet<'cloud' | 'mac'> {
  return new Set(cloudOnly ? ['cloud'] : ['cloud', 'mac'])
}

/**
 * The legacy priority list (F1, an assistant not yet on the D1 home record): under cloud-only no
 * edit may put a Mac in front of the cloud. A reorder may move the cloud up, or shuffle Macs behind
 * it, but never push the cloud further down.
 */
export function cloudOnlyAllowsOrder(
  previous: readonly string[],
  next: readonly string[],
  cloudOnly: boolean = AGENT_HOMES_CLOUD_ONLY
): boolean {
  if (!cloudOnly) {
    return true
  }

  const before = previous.indexOf('cloud')
  const after = next.indexOf('cloud')

  return before < 0 || after < 0 || after <= before
}

/**
 * F1 switches under cloud-only: a Mac may be turned off but never on, and the cloud may be turned
 * on but never off. Both other directions would hand the assistant to a Mac.
 */
export function cloudOnlyLocksSwitch(
  kind: 'cloud' | 'mac',
  enabled: boolean,
  cloudOnly: boolean = AGENT_HOMES_CLOUD_ONLY
): boolean {
  return cloudOnly && (kind === 'mac' ? !enabled : enabled)
}
