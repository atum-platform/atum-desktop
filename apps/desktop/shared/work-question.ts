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
  part: number
  parts: number
}

export function workAnswer(value: unknown): WorkAnswer | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }

  const a = value as Partial<WorkAnswer>

  if (
    a.v !== 1 ||
    typeof a.request_id !== 'string' ||
    a.state !== 'answered' ||
    !['non_google', 'google', 'unknown'].includes(a.data_class ?? '') ||
    typeof a.part !== 'number' ||
    typeof a.parts !== 'number' ||
    !Number.isSafeInteger(a.part) ||
    !Number.isSafeInteger(a.parts) ||
    a.part < 1 ||
    a.part > a.parts ||
    a.parts > 64
  ) {
    return undefined
  }

  return a as WorkAnswer
}
