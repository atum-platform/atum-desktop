import {
  isMatrixInviteDeepLinkCandidate,
  parseMatrixInviteDeepLink
} from '../../shared/matrix-invite-link'

export type MatrixInviteLinkDelivery = 'accepted' | 'invalid' | 'not_invite_link'

/** Process-local bearer handoff. The raw URL is discarded immediately and the token is never persisted or logged. */
export class MatrixInviteLinkBroker {
  private pending: string | null = null

  deliver(value: unknown, publish?: (token: string) => void): MatrixInviteLinkDelivery {
    if (!isMatrixInviteDeepLinkCandidate(value)) {return 'not_invite_link'}
    const token = parseMatrixInviteDeepLink(value)

    if (!token) {return 'invalid'}

    this.pending = token
    publish?.(token)

    return 'accepted'
  }

  take(): string | null {
    const token = this.pending
    this.pending = null

    return token
  }
}
