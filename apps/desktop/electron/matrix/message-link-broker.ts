import {
  isMatrixMessageLinkCandidate,
  type MatrixMessageLinkTarget,
  parseMatrixMessageLink
} from '../../shared/matrix-message-link'

export type MatrixMessageLinkDelivery = 'accepted' | 'invalid' | 'not_message_link'

/** Process-local cold-start handoff. URLs are parsed once and only identifier targets survive. */
export class MatrixMessageLinkBroker {
  private pending: MatrixMessageLinkTarget | null = null

  deliver(value: unknown, publish?: (target: MatrixMessageLinkTarget) => void): MatrixMessageLinkDelivery {
    if (!isMatrixMessageLinkCandidate(value)) {return 'not_message_link'}
    const target = parseMatrixMessageLink(value)

    if (!target) {return 'invalid'}

    this.pending = target
    publish?.(target)

    return 'accepted'
  }

  take(): MatrixMessageLinkTarget | null {
    const target = this.pending
    this.pending = null

    return target
  }
}
