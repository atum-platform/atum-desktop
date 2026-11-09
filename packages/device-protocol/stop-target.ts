/** Frozen agent-home/1.2 Stop targets shared by the controller and Matrix publisher. */
const SYNTHETIC_EVENT = /^\$atum-(?:occurrence-[0-9a-f-]{36}|followup-[0-9a-f-]{36}\.[0-9a-f-]{36})$/
export function validStopEvent(value: unknown): value is string {
  if (typeof value !== 'string' || !SYNTHETIC_EVENT.test(value)) return false
  const ids = value.startsWith('$atum-occurrence-') ? [value.slice(17)] : value.slice(15).split('.')
  return ids.every(id => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))
}
