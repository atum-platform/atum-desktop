import type { MatrixDrive } from './drive'

/**
 * The Drive client is not enabled for the shared sign-in trip until its first-party production
 * registration is verified. Keeping this false leaves today's Matrix -> Atum-account trip byte
 * for byte unchanged.
 */
export const DRIVE_CHAINED_SIGN_IN = false

/** The whole Drive continuation gets only this long to produce its safe authorization URL. */
export const MATRIX_DRIVE_CHAIN_WAIT_MS = 3_000

export interface MatrixDriveChain {
  continueTo(): Promise<string | undefined>
  cancel(): void
}

/**
 * The account owns browser-trip lifetime; Drive owns its engine and folder lifetime. This narrow
 * adapter joins those two lifetimes without teaching either side about the other's implementation.
 */
export function matrixDriveChain(
  drive: () => MatrixDrive | undefined,
  enabled: boolean = DRIVE_CHAINED_SIGN_IN
): MatrixDriveChain | undefined {
  if (!enabled) {
    return undefined
  }

  return {
    continueTo: async () => drive()?.prepareChainedAuthorization(),
    cancel: () => drive()?.cancelChainedAuthorization()
  }
}
