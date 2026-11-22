import type { WorkQuestion } from '../../../shared/work-question'
export type { WorkQuestion }
export interface Caller {
  threadId: string
  providerSessionId: string
  providerInstanceId: string
}
export interface Answer {
  body: string
  dataClass: 'non_google' | 'google' | 'unknown'
}
export interface Result {
  state:
    | 'answered'
    | 'waiting'
    | 'timed_out'
    | 'unavailable'
    | 'cancelled'
    | 'google_requires_atum'
    | 'provenance_unavailable'
  request_id: string
  question_event_id?: string
  answer?: string
  provenance?: Answer['dataClass']
}

export function validQuestion(value: unknown): value is WorkQuestion {
  if (!value || typeof value !== 'object') {
    return false
  }

  const q = value as Record<string, unknown>

  return (
    Object.keys(q).every(k => ['agent', 'question', 'request_id'].includes(k)) &&
    typeof q.agent === 'string' &&
    q.agent.length > 0 &&
    q.agent.length <= 256 &&
    typeof q.request_id === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(q.request_id) &&
    (q.question === undefined ||
      (typeof q.question === 'string' && q.question.trim().length > 0 && q.question.length <= 8000))
  )
}
