import type { MatrixCompanyAIFileRef } from '../../shared/matrix-company-ai'
import type { MatrixCompanyFileRefV1 } from '../../shared/matrix-company-files'

import { type MatrixCompanyFileControllerPorts, readCompanyFile } from './company-file-controller'
import { MatrixCompanyFileError } from './company-files'

function transportReference(file: MatrixCompanyAIFileRef): MatrixCompanyFileRefV1 {
  if (file.v === 1) {
    return file
  }

  return {
    v: 1,
    company_id: file.company_id,
    channel_id: file.audience.channel_id,
    file_id: file.file_id,
    revision: 1,
    name: file.name,
    content_type: file.content_type,
    size: file.size,
    sha256: file.sha256
  }
}

/** Every attachment open mints a fresh protected download grant before exposing bytes to the save boundary. */
export async function openMatrixCompanyBoardAttachment(
  file: MatrixCompanyAIFileRef,
  ports: MatrixCompanyFileControllerPorts,
  save: (opened: { name: string; bytes: Uint8Array }) => Promise<void>,
  signal: AbortSignal
): Promise<void> {
  const opened = await readCompanyFile(transportReference(file), ports, signal)

  if (!ports.current()) {
    throw new MatrixCompanyFileError('cancelled')
  }

  await save(opened)

  if (!ports.current()) {
    throw new MatrixCompanyFileError('cancelled')
  }
}
