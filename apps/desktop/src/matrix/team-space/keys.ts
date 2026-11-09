import type { MatrixIdentity } from '../../../shared/matrix'

/** The renderer's account scope for every cached Team Space answer; none may cross it. */
export const teamSpaceAccountKey = (identity: MatrixIdentity | null | undefined): string =>
  identity ? `${identity.userId}:${identity.deviceId}` : 'signed-out'

/** One company within one account. */
export const teamSpaceKey = (accountKey: string, companyId: string): string => `${accountKey}\n${companyId}`
