import { conversationFleetReady } from '../../../shared/agent-conversation'

/** Enumeration is authoritative; never drop a missing Mac from the report list. */
export function conversationMacFleetReady(
  devices: readonly string[] | undefined,
  reports: ReadonlyMap<string, unknown>,
  floor?: readonly [number, number, number]
): boolean {
  return (
    Boolean(devices?.length) &&
    conversationFleetReady(
      devices!.map(id => reports.get(id) ?? null),
      floor
    )
  )
}
