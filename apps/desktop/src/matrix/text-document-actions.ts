import type { MatrixCommand } from '../../shared/matrix'

import { clearLocalMatrixRoomDrafts } from './composer-draft'
import { noteMatrixDestinationRequest } from './destination-requests'

export type MatrixDocumentDetachPrepare = (() => Promise<void>) & {
  /** Restores the visible editor only if this exact preflight remains active. */
  resumeAfterActionFailure?: (error: unknown) => void
}

interface ActiveDetach {
  prepare: MatrixDocumentDetachPrepare
  resumeAfterActionFailure?: (error: unknown) => void
}

let active: ActiveDetach | null = null

/** One visible editor owns this preflight. It retains no document bytes or authority. */
export function registerMatrixDocumentDetach(prepare: MatrixDocumentDetachPrepare): () => void {
  const registration: ActiveDetach = { prepare, resumeAfterActionFailure: prepare.resumeAfterActionFailure }
  active = registration

  return () => { if (active === registration) {active = null} }
}

/** Wait for an acknowledged draft/save before a user action removes the editor. */
export function runMatrixDocumentAction<T>(action: () => Promise<T>): Promise<T> {
  const registration = active

  if (!registration) {return action()}

  return registration.prepare().then(() => {
    if (active !== registration) {throw new Error('MATRIX_TEXT_DOCUMENT_UNAVAILABLE')}

    return action().catch(error => {
      // A rejected action leaves this still-mounted pane usable again. Do not
      // revive an editor that was replaced or unmounted during the action.
      if (active === registration) { registration.resumeAfterActionFailure?.(error) }
      throw error
    })
  })
}

export function prepareMatrixDocumentClose(): Promise<void> {
  return runMatrixDocumentAction(() => Promise.resolve())
}

export function runMatrixCommand(command: MatrixCommand): Promise<unknown> {
  const action = async () => {
    const result = await window.atumMatrix.command(command)

    if (command.kind === 'forget') {clearLocalMatrixRoomDrafts(command.roomId)}

    return result
  }

  // The person asked for the Store or an app: it comes to the front now, so a place they pick
  // while main answers still wins.
  if (command.kind === 'selectApp' || command.kind === 'discoverApps') {
    noteMatrixDestinationRequest()
  }

  return ['select', 'notesSelfOpen', 'selectApp', 'discoverApps', 'leave', 'forget', 'create', 'join'].includes(command.kind)
    ? runMatrixDocumentAction(action) : action()
}
