export const WORK_REQUEST_KEY = 'io.atum.work_request'
export const WORK_ANSWER_KEY = 'io.atum.work_answer'
export const WORK_LEARNING_MSGTYPE = 'io.atum.work_learning'
export const WORK_LEARNING_CHANNEL = 'atum:work:submit-learning'

export interface WorkLearningModel {
  instanceId: string
  model: string
  options?: { id: string; value: string | boolean }[]
}

export interface WorkLearningRequest {
  server: string
  followup: boolean
  model: WorkLearningModel
  document?: string
}

const uuid = '[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}'
export const workLearningSessionId = new RegExp(`^${uuid}$`, 'u')
const workLearningThreadId = new RegExp(`^work-learning-(${uuid})-(${uuid})$`, 'u')

export function workLearningThread(value: string) {
  const match = workLearningThreadId.exec(value)
  return match ? { agent: match[1]!, session: match[2]! } : undefined
}

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
  learning?: unknown
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
