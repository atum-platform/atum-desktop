import type { MatrixCommand, MatrixIdentity, MatrixSnapshot } from '../../shared/matrix'
import type { MatrixWalletState } from '../../shared/matrix-wallet'

/** Only a credited provider fact plus the synced owner's unseen marker is a welcome. */
export function matrixStarterNotice(wallet: MatrixWalletState | undefined, marker: MatrixSnapshot['starterMarker'], ready: boolean): MatrixSnapshot['starter'] {
  const allowance = wallet?.state === 'ready' ? wallet.wallet.allowance : null

  return ready && marker === 'unseen' && allowance?.state === 'granted' &&
    ['founding', 'standard'].includes(allowance.kind) && Number.isSafeInteger(allowance.amount) && allowance.amount > 0
    ? { kind: allowance.kind, amount: allowance.amount } : undefined
}

/** A stale UI cannot consume a successor account's welcome, even on the same device. */
export function requireMatrixStarterAcknowledgement(
  input: Extract<MatrixCommand, { kind: 'starterSeen' }>,
  owner: MatrixIdentity | null | undefined,
  scope: string | undefined,
  offered: MatrixSnapshot['starter']
) {
  if (!owner || !scope || !offered || input.scope !== scope ||
    input.identity.userId !== owner.userId || input.identity.deviceId !== owner.deviceId) {
    throw new Error('matrix_starter_stale')
  }
}
