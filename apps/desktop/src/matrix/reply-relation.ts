function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** The parent event for either legacy threads or a standard Matrix rich reply. */
export function matrixReplyRoot(content: Record<string, unknown>): string | undefined {
  const relation = record(content['m.relates_to'])

  if (!relation) {
    return undefined
  }

  if (relation.rel_type === 'm.thread' && typeof relation.event_id === 'string') {
    return relation.event_id
  }

  const reply = relation.rel_type === undefined ? record(relation['m.in_reply_to']) : undefined

  return typeof reply?.event_id === 'string' ? reply.event_id : undefined
}
