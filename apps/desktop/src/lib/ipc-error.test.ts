import { describe, expect, it } from 'vitest'

import { ipcErrorMessage } from './ipc-error'

describe('IPC error messages', () => {
  it.each([
    [new Error("Error invoking remote method 'atum:put': Error: google_workspace_local_only"), 'google_workspace_local_only'],
    [new Error('google_workspace_local_only'), 'google_workspace_local_only'],
    ['other error', 'other error'],
    [undefined, '']
  ])('preserves the main-process error code', (error, expected) => {
    expect(ipcErrorMessage(error)).toBe(expected)
  })
})
