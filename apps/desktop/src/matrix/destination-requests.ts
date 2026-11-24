import { atom } from 'nanostores'

/**
 * The person asked main for the Store or an app (the rail, the assistant card, a top-up, the
 * side panel's launcher). One count per request: the window brings that destination to the
 * front once (app.tsx), never again on a later snapshot that only repeats it.
 */
export const $matrixDestinationRequests = atom(0)

export function noteMatrixDestinationRequest(): void {
  $matrixDestinationRequests.set($matrixDestinationRequests.get() + 1)
}
