export const WORK_DELIVERABLE_STATUS_CHANNEL = 'atum:work:deliverable-status'
export const WORK_DELIVERABLE_OPEN_CHANNEL = 'atum:work:deliverable-open'

export interface WorkDeliverableId {
  threadId: string
  runId: string
  artifactId: string
}

export type WorkDeliverableStatus =
  | { state: 'syncing' | 'saved'; artifactId: string; name: string; previewName?: string }
  | { state: 'drive_unavailable' | 'changed' | 'invalid' | 'no_room' | 'retry' | 'cancelled' }

export type WorkDeliverableReply =
  | { type: 'work-deliverable-pinned'; artifactId: string; accepted: boolean }
  | { type: 'work-deliverable-ack'; artifactId: string; status: WorkDeliverableStatus }

export function parseWorkDeliverableId(value: unknown): WorkDeliverableId | undefined {
  if (!value || typeof value !== 'object') {return undefined}
  const { threadId, runId, artifactId } = value as Partial<WorkDeliverableId>
  const id = (item: unknown): item is string => typeof item === 'string' && item.length > 0 && item.length <= 255

  if (id(threadId) && id(runId) && typeof artifactId === 'string' &&
      /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(artifactId)) {
    return { threadId, runId, artifactId }
  }
}
