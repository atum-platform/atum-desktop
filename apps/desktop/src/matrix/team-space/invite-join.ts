import { atom } from 'nanostores'
import { useEffect } from 'react'

import type { CompanyInviteLinkPreviewResponse, CompanyInviteLinkRedeemResponse } from '../../../shared/matrix-company-team-space'
import { parseMatrixInviteLinkPaste, validMatrixInviteLinkToken } from '../../../shared/matrix-invite-link'

export interface MatrixInviteJoinRequest {
  serial: number
  token?: string
  requestId?: string
  /** The signed-in account that previewed this bearer. It may not silently move to another account. */
  accountKey?: string
}

let serial = 0

/** Memory-only owner of the bearer token and its stable redeem UUID. */
export const $matrixInviteJoinRequest = atom<MatrixInviteJoinRequest | null>(null)

function newRequest(token?: string): MatrixInviteJoinRequest {
  return {
    serial: ++serial,
    ...(token ? { token, requestId: globalThis.crypto.randomUUID() } : {})
  }
}

export function openMatrixInviteJoinPaste(): MatrixInviteJoinRequest {
  const request = newRequest()
  $matrixInviteJoinRequest.set(request)

  return request
}

export function requestMatrixInviteJoinToken(token: string): MatrixInviteJoinRequest | null {
  if (!validMatrixInviteLinkToken(token)) {return null}
  const request = newRequest(token)
  $matrixInviteJoinRequest.set(request)

  return request
}

export function adoptMatrixInviteJoinPaste(request: MatrixInviteJoinRequest, value: string): MatrixInviteJoinRequest | null {
  const token = parseMatrixInviteLinkPaste(value)

  if (!token || $matrixInviteJoinRequest.get()?.serial !== request.serial) {return null}
  const adopted = { ...request, token, requestId: request.requestId ?? globalThis.crypto.randomUUID() }
  $matrixInviteJoinRequest.set(adopted)

  return adopted
}

export function bindMatrixInviteJoinAccount(request: MatrixInviteJoinRequest, accountKey: string): MatrixInviteJoinRequest | null {
  const current = $matrixInviteJoinRequest.get()

  if (!current || current.serial !== request.serial) {return null}
  if (current.accountKey && current.accountKey !== accountKey) {return null}
  const bound = current.accountKey ? current : { ...current, accountKey }
  if (bound !== current) {$matrixInviteJoinRequest.set(bound)}

  return bound
}

export function clearMatrixInviteJoinRequest(request: MatrixInviteJoinRequest): void {
  if ($matrixInviteJoinRequest.get()?.serial === request.serial) {
    $matrixInviteJoinRequest.set(null)
  }
}

/** Install the native cold/warm deep-link seam once. A signed-out renderer retains the request
 * in module memory until authentication mounts Team Space; it never writes browser storage. */
export function useMatrixInviteLinkBridge(): void {
  useEffect(() => {
    const bridge = window.atumMatrix.inviteLinks
    if (!bridge) {return}
    let live = true
    let liveToken: string | undefined
    const receive = (token: string) => {
      if (live && validMatrixInviteLinkToken(token)) {
        liveToken = token
        requestMatrixInviteJoinToken(token)
      }
    }
    const unsubscribe = bridge.subscribe(receive)
    void bridge.takePending().then(token => {
      if (token && token !== liveToken) {receive(token)}
    }).catch(() => {})

    return () => {
      live = false
      unsubscribe()
    }
  }, [])
}

export type InviteJoinFailure = 'invalid' | 'expired' | 'revoked' | 'exhausted' | 'wrong_account' | 'email_bound' | 'unavailable'
export type InviteJoinCompletion = 'joined' | 'already_member' | 'replayed'

export type InviteJoinState =
  | { stage: 'paste'; input: string }
  | { stage: 'previewing' }
  | { stage: 'preview'; preview: CompanyInviteLinkPreviewResponse }
  | { stage: 'redeeming'; preview: CompanyInviteLinkPreviewResponse }
  | { stage: 'complete'; preview: CompanyInviteLinkPreviewResponse; completion: InviteJoinCompletion }
  | { stage: 'failure'; failure: InviteJoinFailure; preview?: CompanyInviteLinkPreviewResponse }

export type InviteJoinAction =
  | { type: 'input'; value: string }
  | { type: 'previewing' }
  | { type: 'previewed'; preview: CompanyInviteLinkPreviewResponse; now: number }
  | { type: 'preview_failed' }
  | { type: 'redeeming' }
  | { type: 'redeemed'; value: CompanyInviteLinkRedeemResponse }
  | { type: 'redeem_failed'; now: number; unavailableLink: boolean }
  | { type: 'wrong_account' }
  /** The link was made for one email address (1.9): it is claimed by signing in with that address, never redeemed. */
  | { type: 'email_bound' }
  | { type: 'unavailable' }

export function initialInviteJoinState(request: MatrixInviteJoinRequest): InviteJoinState {
  return request.token ? { stage: 'previewing' } : { stage: 'paste', input: '' }
}

export function inviteJoinReducer(state: InviteJoinState, action: InviteJoinAction): InviteJoinState {
  switch (action.type) {
    case 'input': return { stage: 'paste', input: action.value }
    case 'previewing': return { stage: 'previewing' }
    case 'previewed':
      if (action.preview.expiresAt <= action.now) {
        return { stage: 'failure', failure: 'expired', preview: action.preview }
      }
      if (action.preview.usesRemaining === 0) {
        return { stage: 'failure', failure: 'exhausted', preview: action.preview }
      }

      return { stage: 'preview', preview: action.preview }
    case 'preview_failed': return { stage: 'failure', failure: 'invalid' }
    case 'redeeming':
      return state.stage === 'preview' ? { stage: 'redeeming', preview: state.preview } : state
    case 'redeemed': {
      if (state.stage !== 'redeeming') {return state}
      const completion = action.value.link.replayed
        ? 'replayed'
        : action.value.link.consumedNow
          ? 'joined'
          : 'already_member'

      return { stage: 'complete', preview: state.preview, completion }
    }
    case 'redeem_failed': {
      if (state.stage !== 'redeeming') {return { stage: 'failure', failure: 'unavailable' }}
      const failure = state.preview.expiresAt <= action.now
        ? 'expired'
        : state.preview.usesRemaining === 0
          ? 'exhausted'
          : action.unavailableLink
            ? 'revoked'
            : 'unavailable'

      return { stage: 'failure', failure, preview: state.preview }
    }
    case 'wrong_account': return { stage: 'failure', failure: 'wrong_account' }
    case 'email_bound': return { stage: 'failure', failure: 'email_bound' }
    case 'unavailable': return { stage: 'failure', failure: 'unavailable' }
  }
}
