import type {
  MatrixCompanyChannelDirectory,
  MatrixCompanyChannelDirectory11,
  MatrixCompanyRequest,
  MatrixCompanyValue
} from '../../shared/matrix-company'
import type { CompanyChannelAdmittedDirectory14Response } from '../../shared/matrix-company-team-space'

import { MatrixCompanyError } from './company'

/** Anything with the directory's channel rows: the 1.1 company-wide one or the 1.4 admitted one. */
export type CompanyChannelDirectoryValue =
  | MatrixCompanyChannelDirectory
  | MatrixCompanyChannelDirectory11
  | CompanyChannelAdmittedDirectory14Response

export interface CompanyDirectoryAccount {
  company(input: MatrixCompanyRequest, signal: AbortSignal): Promise<MatrixCompanyValue>
}

function isDirectory(value: MatrixCompanyValue): value is CompanyChannelDirectoryValue {
  return 'channels' in value
}

/**
 * The channels the platform currently admits this person to: the single authority that decides
 * which Matrix rooms are company channels (the room guard), and which rooms company search may
 * read.
 *
 * With channel admission active the 1.4 admitted directory is that authority; it lists public and
 * private channels alike. A server that does not serve it (older, or the feature is inactive:
 * 400 or 404) is read on 1.1 instead, which lists admitted public channels only, exactly as
 * the contract promises older clients. Nothing else falls back: a refused sign-in, a cancelled
 * request or a rate limit is a failed read, never a quieter one.
 */
export async function readCompanyChannelDirectory(
  account: CompanyDirectoryAccount,
  companyId: string,
  signal: AbortSignal
): Promise<CompanyChannelDirectoryValue> {
  try {
    const admitted = await account.company({ action: 'admitted-channels', companyId }, signal)

    if (isDirectory(admitted)) {
      return admitted
    }
  } catch (error) {
    const notServed = error instanceof MatrixCompanyError && ['missing', 'invalid'].includes(error.code)

    if (!notServed) {
      throw error
    }
  }

  signal.throwIfAborted()
  const listed = await account.company({ action: 'list-channels', companyId }, signal)

  if (!isDirectory(listed)) {
    throw new Error('matrix_company_directory_unavailable')
  }

  return listed
}
