import { describe, expect, it, vi } from 'vitest'

import { logNotesSelfOpenFailures } from './notes-self-log'

describe('notes-self open failure logging at the main IPC boundary', () => {
  it.each(['matrix_notes_self_uncertain', 'matrix_notes_self_offline', 'matrix_not_ready',
    'Secret @owner:test !room:test message content'])('logs only a closed outcome code for %s', async message => {
    const error = new Error(message)
    const log = vi.fn()
    const handle = logNotesSelfOpenFailures(async () => { throw error }, log)
    await expect(handle(null, { kind: 'command', command: { kind: 'notesSelfOpen', companyId: 'private' } }))
      .rejects.toBe(error)
    expect(log).toHaveBeenCalledExactlyOnceWith(
      `[Matrix] notes-self open outcome=failed code=${message.startsWith('matrix_') ? message : 'unexpected'}`
    )
  })

  it('does not log successful opens or unrelated failures', async () => {
    const log = vi.fn()
    const success = logNotesSelfOpenFailures(async () => ({ roomId: '!private:test' }), log)
    await expect(success(null, { kind: 'command', command: { kind: 'notesSelfOpen' } }))
      .resolves.toEqual({ roomId: '!private:test' })
    const failure = logNotesSelfOpenFailures(async () => { throw new Error('private') }, log)
    await expect(failure(null, { kind: 'command', command: { kind: 'send' } })).rejects.toThrow()
    expect(log).not.toHaveBeenCalled()
  })
})
