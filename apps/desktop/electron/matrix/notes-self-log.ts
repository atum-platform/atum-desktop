const FAILURE_CODES = new Set([
  'matrix_notes_self_stale', 'matrix_notes_self_create_unconfirmed', 'matrix_notes_self_uncertain',
  'matrix_notes_self_quarantined', 'matrix_notes_self_readonly', 'matrix_notes_self_offline',
  'matrix_notes_self_company_invalid', 'matrix_notes_self_unavailable', 'matrix_not_ready',
  'matrix_busy', 'matrix_command_invalid', 'matrix_operation_failed'
])

/** Cover the whole IPC handler, including validation/readiness failures before SDK dispatch. */
export function logNotesSelfOpenFailures<Sender, Request extends { kind?: string; command?: unknown }, Result>(
  handler: (event: Sender, request: Request) => Promise<Result>,
  log: (line: string) => void
): (event: Sender, request: Request) => Promise<Result> {
  return async (event, request) => {
    try {
      return await handler(event, request)
    } catch (error) {
      const command = request?.command

      if (request?.kind === 'command' && command && typeof command === 'object' &&
        'kind' in command && command.kind === 'notesSelfOpen') {
        const message = error instanceof Error ? error.message : ''
        const code = FAILURE_CODES.has(message) ? message : 'unexpected'
        log(`[Matrix] notes-self open outcome=failed code=${code}`)
      }

      throw error
    }
  }
}
