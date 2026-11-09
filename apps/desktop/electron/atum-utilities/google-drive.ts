import { GoogleContentUnavailable, googleJson, googleResponse, UtilityFailure } from './google'

const API = 'https://www.googleapis.com/drive/v3/files'
const FIELDS = 'id,name,mimeType,modifiedTime,viewedByMeTime,webViewLink,size'

const EXPORT_TYPES: Record<string, string> = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.presentation': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv'
}

const MODIFIED_AFTER = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/
const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T|$)/

/** A real calendar day: Date.parse would otherwise normalize 2026-02-31 into March. */
function realCalendarDay(value: string): boolean {
  const match = CALENDAR_DATE.exec(value)

  if (!match) { return false }
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)

  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

/** A day or RFC 3339 instant, normalized to UTC so it can sit inside a Drive query literally. */
function modifiedAfterQuery(value: unknown): string {
  if (value === undefined) { return '' }

  if (typeof value !== 'string' || value.length > 64 || !MODIFIED_AFTER.test(value) ||
      !realCalendarDay(value) || !Number.isFinite(Date.parse(value))) {
    throw new UtilityFailure('invalid_input')
  }

  return new Date(Date.parse(value)).toISOString()
}

/** Fixed endpoints, literal search terms and bounded text; no caller-supplied URL. */
export async function readDrive(fetchImpl: typeof fetch, token: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
  const headers = { authorization: `Bearer ${token}` }

  if (!input.action) { return googleJson(fetchImpl, 'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)', { headers, signal }) }

  if (input.action === 'files') {
    if (input.query !== undefined && (typeof input.query !== 'string' || input.query.length > 500)) { throw new UtilityFailure('invalid_input') }
    if (input.sort !== undefined && input.sort !== 'modified' && input.sort !== 'viewed') { throw new UtilityFailure('invalid_input') }
    const term = typeof input.query === 'string' ? input.query.replace(/\\/g, '\\\\').replace(/'/g, "\\'") : ''
    const after = modifiedAfterQuery(input.modifiedAfter)

    const query = new URLSearchParams({
      q: `trashed = false${term ? ` and fullText contains '${term}'` : ''}${after ? ` and modifiedTime > '${after}'` : ''}`,
      pageSize: '20', orderBy: input.sort === 'viewed' ? 'viewedByMeTime desc' : 'modifiedTime desc',
      spaces: 'drive', corpora: 'user', includeItemsFromAllDrives: 'true', supportsAllDrives: 'true',
      fields: `nextPageToken,incompleteSearch,files(${FIELDS})`
    })

    const result = await googleJson(fetchImpl, `${API}?${query}`, { headers, signal })

    return { files: result.files ?? [], more: Boolean(result.nextPageToken) || result.incompleteSearch === true }
  }

  if (input.action !== 'file' || typeof input.id !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(input.id)) { throw new UtilityFailure('invalid_input') }
  const url = `${API}/${encodeURIComponent(input.id)}`
  const file = await googleJson(fetchImpl, `${url}?${new URLSearchParams({ fields: `${FIELDS},capabilities(canDownload)`, supportsAllDrives: 'true' })}`, { headers, signal })

  if (file.capabilities?.canDownload === false) { return { file, contentUnavailable: 'download_restricted' } }
  const exportType = EXPORT_TYPES[String(file.mimeType)]
  const plainText = /^text\//.test(String(file.mimeType)) || ['application/json', 'application/xml'].includes(file.mimeType)

  if (!exportType && !plainText) {
    return {
      file,
      contentUnavailable: 'unsupported_type',
      contentNote: 'Atum can read Google Docs, Sheets, Slides and plain text; PDF and Word files are not supported yet.'
    }
  }
  let response: Response

  try {
    response = await googleResponse(fetchImpl, exportType
      ? `${url}/export?${new URLSearchParams({ mimeType: exportType })}`
      : `${url}?alt=media&supportsAllDrives=true`, { headers, signal })
  } catch (error) {
    if (error instanceof GoogleContentUnavailable) { return { file, contentUnavailable: error.reason } }
    throw error
  }

  const reader = response.body?.getReader()

  if (!reader) { throw new UtilityFailure('network') }
  const chunks: Uint8Array[] = []
  const byteLimit = 160_000
  let bytes = 0
  let truncated = false

  try {
    for (;;) {
      const { done, value } = await reader.read()

      if (done) { break }
      const remaining = byteLimit - bytes
      chunks.push(value.slice(0, remaining))
      bytes += Math.min(remaining, value.length)

      if (bytes >= byteLimit) {
        truncated = true

        break
      }
    }
  } catch { throw new UtilityFailure('network') }
  finally { await reader.cancel().catch(() => {}) }

  const text = Buffer.concat(chunks).toString('utf8')
  // A code-unit limit must not leave half a Unicode surrogate pair in output.
  const content = text.slice(0, 40_000).replace(/[\uD800-\uDBFF]$/, '')

  return {
    file, text: content, more: truncated || text.length > content.length,
    ...(exportType === 'text/csv' ? { contentNote: 'First sheet only (CSV export).' } : {})
  }
}
