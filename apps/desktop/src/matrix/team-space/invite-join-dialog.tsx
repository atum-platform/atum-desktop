import { type FormEvent, useCallback, useEffect, useReducer, useRef } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/i18n'

import type { MatrixCompanyBridge } from '../../../shared/matrix-company'
import { matrixTeamSpaceCopy } from '../../../shared/matrix-team-space-copy'

import {
  $matrixInviteJoinRequest,
  adoptMatrixInviteJoinPaste,
  bindMatrixInviteJoinAccount,
  clearMatrixInviteJoinRequest,
  initialInviteJoinState,
  type InviteJoinFailure,
  inviteJoinReducer,
  type MatrixInviteJoinRequest
} from './invite-join'
import { teamSpaceLayoutCopy } from './layout-copy'
import { requestTeamSpace } from './request'

export interface InviteJoinDialogProps {
  accountKey: string
  bridge: MatrixCompanyBridge
  cancelLabel: string
  onJoined(companyId: string): Promise<void>
  request: MatrixInviteJoinRequest
}

const nowSeconds = () => Math.floor(Date.now() / 1000)

export function InviteJoinDialog({ accountKey, bridge, cancelLabel, onJoined, request }: InviteJoinDialogProps) {
  const { locale } = useI18n()
  const copy = teamSpaceLayoutCopy(locale)
  const teamCopy = matrixTeamSpaceCopy(locale)
  const [state, dispatch] = useReducer(inviteJoinReducer, request, initialInviteJoinState)
  const live = useRef(true)
  const previewing = useRef(false)

  useEffect(() => () => {live.current = false}, [])

  const current = useCallback(() =>
    live.current && $matrixInviteJoinRequest.get()?.serial === request.serial, [request.serial])

  const preview = useCallback(async (candidate: MatrixInviteJoinRequest) => {
    if (!candidate.token || previewing.current) {return}
    if (candidate.accountKey && candidate.accountKey !== accountKey) {
      dispatch({ type: 'wrong_account' })

      return
    }
    const bound = bindMatrixInviteJoinAccount(candidate, accountKey)

    if (!bound) {
      dispatch({ type: 'wrong_account' })

      return
    }

    previewing.current = true
    dispatch({ type: 'previewing' })
    const result = await requestTeamSpace(bridge, { action: 'invite-link-preview', token: bound.token! })
    previewing.current = false

    if (!current()) {return}
    if (!result.ok) {
      dispatch(result.reason === 'email_invite_claim_required'
        ? { type: 'email_bound' }
        : result.error === 'missing' || result.reason === 'invite_link_unavailable'
          ? { type: 'preview_failed' }
          : { type: 'unavailable' })

      return
    }

    dispatch({ type: 'previewed', preview: result.value, now: nowSeconds() })
  }, [accountKey, bridge, current])

  useEffect(() => {
    if (request.token) {void preview(request)}
    // A request serial is one flow. Paste adoption invokes preview directly without restarting it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.serial])

  const close = () => clearMatrixInviteJoinRequest(request)

  const submitPaste = (event: FormEvent) => {
    event.preventDefault()
    if (state.stage !== 'paste') {return}
    const adopted = adoptMatrixInviteJoinPaste(request, state.input)

    if (!adopted) {
      dispatch({ type: 'preview_failed' })

      return
    }

    void preview(adopted)
  }

  const join = async () => {
    const active = $matrixInviteJoinRequest.get()

    if (state.stage !== 'preview' || !active?.token || !active.requestId || active.serial !== request.serial) {return}
    if (active.accountKey !== accountKey) {
      dispatch({ type: 'wrong_account' })

      return
    }

    dispatch({ type: 'redeeming' })
    const result = await requestTeamSpace(bridge, {
      action: 'invite-link-redeem',
      requestId: active.requestId,
      token: active.token
    })

    if (!current()) {return}
    if (!result.ok && result.reason === 'email_invite_claim_required') {
      dispatch({ type: 'email_bound' })

      return
    }
    if (!result.ok) {
      dispatch({
        type: 'redeem_failed',
        now: nowSeconds(),
        unavailableLink: result.error === 'missing' || result.reason === 'invite_link_unavailable'
      })

      return
    }

    dispatch({ type: 'redeemed', value: result.value })

    try {
      await onJoined(result.value.companyId)
      if (current()) {clearMatrixInviteJoinRequest(request)}
    } catch {
      if (current()) {dispatch({ type: 'unavailable' })}
    }
  }

  const failureText: Record<InviteJoinFailure, string> = {
    invalid: copy.invalidInviteLink,
    expired: copy.expiredInviteLink,
    revoked: copy.revokedInviteLink,
    exhausted: copy.exhaustedInviteLink,
    wrong_account: copy.wrongAccountInvite,
    email_bound: teamCopy.refusal.email_invite_claim_required,
    unavailable: copy.inviteUnavailable
  }

  const emailBound = state.stage === 'failure' && state.failure === 'email_bound'
  const previewValue = 'preview' in state ? state.preview : undefined
  const inviter = previewValue?.inviter.displayName ??
    (previewValue?.inviter.handle ? `@${previewValue.inviter.handle}` : undefined)
  const completion = state.stage === 'complete'
    ? state.completion === 'already_member' ? copy.alreadyMemberInvite : copy.inviteJoined
    : undefined

  return (
    <div
      aria-labelledby="matrix-invite-join-title"
      aria-modal="true"
      className="grid w-full max-w-sm gap-4 rounded-(--atum-r-card) bg-(--atum-card) p-5 shadow-(--atum-glass-edge)"
      data-matrix-invite-join
      role="dialog"
    >
      <div>
        <h2 className="text-(length:--atum-t-section) font-semibold tracking-tight text-(--atum-ink)" id="matrix-invite-join-title">
          {copy.joinInviteTitle}
        </h2>
        {state.stage === 'paste' && <p className="mt-1 text-sm text-(--atum-ink-muted)">{copy.inviteLinkHint}</p>}
      </div>

      {state.stage === 'paste' && (
        <form className="grid gap-3" onSubmit={submitPaste}>
          <Input
            aria-label={copy.inviteLinkLabel}
            autoFocus
            onChange={event => dispatch({ type: 'input', value: event.currentTarget.value })}
            placeholder="https://account.atumplatform.com/j/…"
            value={state.input}
          />
          <div className="flex justify-end gap-2">
            <Button onClick={close} type="button" variant="text">{cancelLabel}</Button>
            <Button disabled={!state.input.trim()} type="submit">{copy.previewInvite}</Button>
          </div>
        </form>
      )}

      {state.stage === 'previewing' && <p className="text-sm text-(--atum-ink-muted)" role="status">{copy.previewingInvite}</p>}

      {previewValue && (
        <div className="grid gap-1 text-sm text-(--atum-ink)" data-matrix-invite-preview>
          <p className="font-medium">{copy.invitedTo(previewValue.company.displayName)}</p>
          {inviter && <p className="text-(--atum-ink-muted)">{copy.inviteFrom(inviter)}</p>}
          <p className="text-(--atum-ink-muted)">
            {copy.inviteExpires(new Date(previewValue.expiresAt * 1000).toLocaleString(locale, {
              dateStyle: 'medium', timeStyle: 'short'
            }))}
          </p>
        </div>
      )}

      {/* A link made for one email address is not a failure: it says what to do, once, with one way out. */}
      {emailBound && (
        <p className="text-sm text-(--atum-ink)" data-matrix-invite-email-bound role="status">{failureText.email_bound}</p>
      )}
      {state.stage === 'failure' && !emailBound && <p className="text-sm text-destructive" role="alert">{failureText[state.failure]}</p>}
      {completion && <p aria-live="polite" className="text-sm text-(--atum-ink-muted)" role="status">{completion}</p>}

      {emailBound && (
        <div className="flex justify-end">
          <Button autoFocus onClick={close} type="button">{teamCopy.inviteSheet.ok}</Button>
        </div>
      )}

      {state.stage !== 'paste' && !emailBound && (
        <div className="flex justify-end gap-2">
          <Button onClick={close} type="button" variant="text">{cancelLabel}</Button>
          {state.stage === 'preview' && <Button onClick={() => void join()}>{copy.joinInvite}</Button>}
          {state.stage === 'redeeming' && <Button disabled>{copy.joiningInvite}</Button>}
          {state.stage === 'failure' && state.failure === 'unavailable' && request.token && (
            <Button onClick={() => void preview($matrixInviteJoinRequest.get() ?? request)}>{copy.previewInvite}</Button>
          )}
        </div>
      )}
    </div>
  )
}
