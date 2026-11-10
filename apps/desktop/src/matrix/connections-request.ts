import { atom } from 'nanostores'

import { closeAssistantCard } from './assistant-card/store'

/**
 * Something outside Settings asked for Settings › Connections (the Mac sources band, a "Can use"
 * row that needs a fix). One count per request; the window opens the pane once (app.tsx).
 */
export const $matrixConnectionsRequests = atom(0)

export function openMatrixConnections(): void {
  // The assistant card sits above Settings; the fix lives on the account page, so it steps aside.
  closeAssistantCard()
  $matrixConnectionsRequests.set($matrixConnectionsRequests.get() + 1)
}
