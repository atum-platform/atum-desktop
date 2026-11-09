/**
 * A stable, opaque Matrix account-data event type for one logical target.
 *
 * Matrix account data is last-write-wins per event type. Giving each target its
 * own type is therefore the concurrency boundary: two devices changing
 * different targets never replace one another's JSON document. The clear-text
 * target remains inside the private account-data content; it is not copied into
 * the event type.
 */
export async function matrixTargetAccountDataType(prefix: string, target: string): Promise<string> {
  const bytes = new TextEncoder().encode(target)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  const suffix = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')

  return `${prefix}${suffix}`
}
