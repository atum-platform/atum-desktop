/** Public monthly-employment contracts shared by Electron and the renderer.
 * No instruction body, credential, or executable entitlement is carried here.
 */
export interface AtumAgentHire {
  id: string
  assistant_id: string
  item_id: string
  offer_id: string
  offer_version: number
  price_protons: number
  billing_interval: 'month'
  renewal_enabled: boolean
  period_start: string
  period_end: string
  state: 'active' | 'paused'
  renewal_error: string | null
  cancelled_at: string | null
}

export interface AtumExecutionTask {
  task_id: string
  assistant_id: string
  assistant_identity_id: string
  conversation_id: string
  skill_id: string | null
}

export interface AtumHireResult {
  outcome: 'completed' | 'already_active' | 'offer_changed'
  subscription: AtumAgentHire | null
  offer?: { id: string; version: number; price_protons: number; billing_interval: 'month' }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new Error('invalid_response:hiring') }
  return value as Record<string, unknown>
}
const string = (value: unknown, max = 256): string => {
  if (typeof value !== 'string' || !value || value.length > max) { throw new Error('invalid_response:hiring') }
  return value
}
const uuid = (value: unknown): string => {
  const id = string(value)
  if (!UUID.test(id)) { throw new Error('invalid_response:hiring_identity') }
  return id
}
const integer = (value: unknown, minimum: number): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) { throw new Error('invalid_response:hiring_price') }
  return value
}
const date = (value: unknown): string => {
  const result = string(value)
  if (!Number.isFinite(Date.parse(result))) { throw new Error('invalid_response:hiring_date') }
  return result
}

export function parseAgentHire(value: unknown): AtumAgentHire {
  const row = object(value)
  if (row.billing_interval !== 'month' || typeof row.renewal_enabled !== 'boolean' ||
    !['active', 'paused'].includes(String(row.state))) { throw new Error('invalid_response:hiring_state') }
  const periodStart = date(row.period_start)
  const periodEnd = date(row.period_end)
  if (Date.parse(periodEnd) <= Date.parse(periodStart)) { throw new Error('invalid_response:hiring_period') }
  return { id: uuid(row.id), assistant_id: uuid(row.assistant_id), item_id: string(row.item_id, 128),
    offer_id: uuid(row.offer_id), offer_version: integer(row.offer_version, 1), price_protons: integer(row.price_protons, 0),
    billing_interval: 'month', renewal_enabled: row.renewal_enabled, period_start: periodStart, period_end: periodEnd,
    state: row.state as AtumAgentHire['state'], renewal_error: row.renewal_error === null ? null : string(row.renewal_error, 64),
    cancelled_at: row.cancelled_at === null ? null : date(row.cancelled_at) }
}

export function parseAgentHires(value: unknown): AtumAgentHire[] {
  const row = object(value)
  if (!Array.isArray(row.subscriptions)) { throw new Error('invalid_response:hiring_list') }
  return row.subscriptions.map(parseAgentHire)
}

export function parseHireResult(value: unknown): AtumHireResult {
  const row = object(value)
  if (row.outcome === 'offer_changed') {
    const offer = object(row.offer)
    if (offer.billing_interval !== 'month') { throw new Error('invalid_response:hiring_interval') }
    return { outcome: 'offer_changed', subscription: null, offer: { id: uuid(offer.id), version: integer(offer.version, 1),
      price_protons: integer(offer.price_protons, 0), billing_interval: 'month' } }
  }
  if (row.outcome !== 'completed' && row.outcome !== 'already_active') { throw new Error('invalid_response:hiring_outcome') }
  return { outcome: row.outcome, subscription: parseAgentHire(row.subscription) }
}

export function parseExecutionTask(value: unknown): AtumExecutionTask {
  const row = object(value)
  const conversation = string(row.conversation_id)
  const skill = row.skill_id === null ? null : string(row.skill_id, 128)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(conversation) ||
    (skill !== null && !/^[a-z0-9][a-z0-9/_-]{0,127}$/u.test(skill))) { throw new Error('invalid_response:execution_task') }
  return { task_id: uuid(row.task_id), assistant_id: uuid(row.assistant_id), assistant_identity_id: uuid(row.assistant_identity_id),
    conversation_id: conversation, skill_id: skill }
}
