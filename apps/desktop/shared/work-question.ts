export const WORK_REQUEST_KEY = 'io.atum.work_request'
export const WORK_ANSWER_KEY = 'io.atum.work_answer'
export interface WorkQuestion {
  agent: string
  question?: string
  request_id: string
}
export interface WorkAnswer {
  v: 1
  request_id: string
  state: 'answered'
  data_class: 'non_google' | 'google' | 'unknown'
  /** A terminal outcome carries all ordered part event IDs, including itself. */
  parts?: string[]
}
export function workAnswer(value: unknown): WorkAnswer | undefined {
  if (!value || typeof value !== 'object') return undefined
  const a = value as Partial<WorkAnswer>
  if (
    a.v !== 1 ||
    typeof a.request_id !== 'string' ||
    a.state !== 'answered' ||
    !['non_google', 'google', 'unknown'].includes(a.data_class ?? '') ||
    (a.parts !== undefined &&
      (!Array.isArray(a.parts) ||
        a.parts.length > 64 ||
        a.parts.some(id => typeof id !== 'string' || !id.startsWith('$'))))
  )
    return undefined
  return a as WorkAnswer
}
