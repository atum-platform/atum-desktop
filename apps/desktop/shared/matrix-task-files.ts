/**
 * The encrypted owner-to-cloud rendezvous for explicitly selected task files.
 * This is only a promise of owner-issued grants; it is never file authority.
 */
export const MATRIX_TASK_FILES_KEY = 'io.atum.task-files'

export interface MatrixTaskFilesPromise {
  version: 1
  requestIds: string[]
}

const REQUEST_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u

/** Parse the strict, additive encrypted-message extension without throwing. */
export function parseMatrixTaskFilesPromise(value: unknown): MatrixTaskFilesPromise | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const row = value as Record<string, unknown>
  const keys = Object.keys(row)

  if (
    keys.length !== 2 ||
    !keys.includes('version') ||
    !keys.includes('requestIds') ||
    row.version !== 1 ||
    !Array.isArray(row.requestIds) ||
    row.requestIds.length < 1 ||
    row.requestIds.length > 4 ||
    !row.requestIds.every(id => typeof id === 'string' && REQUEST_ID.test(id)) ||
    new Set(row.requestIds).size !== row.requestIds.length
  ) {
    return null
  }

  return { version: 1, requestIds: [...row.requestIds] }
}
