import type { MarkdownHost } from '@/components/assistant-ui/markdown-surface'

import { parseDiscoveryLink } from '../../shared/discovery-links'
import { parseMatrixMessageLink } from '../../shared/matrix-message-link'

import { $matrixStoreListingRequest, $matrixStoreShelfRequest } from './store/top-up'
import { parseCompanyBoardLink, requestCompanyBoardLink } from './team-space/board-links'
import { requestMatrixMessageLink } from './team-space/message-links'
import { runMatrixCommand } from './text-document-actions'

const MESSAGE_LINK = /atum:\/\/message\/v1\/[A-Za-z0-9_-]+/giu

function linkifyMessageLinks(value: string): string {
  return value.replace(MESSAGE_LINK, (link, offset: number, source: string) => {
    if (!parseMatrixMessageLink(link) || (source[offset - 1] === '<' && source[offset + link.length] === '>')) {
      return link
    }

    return `<${link}>`
  })
}

/** Standard Markdown autolinks for valid bare message links, without touching inline/fenced code. */
export function prepareMatrixMessageLinks(value: string): string {
  let cursor = 0
  let output = ''

  while (cursor < value.length) {
    const start = value.indexOf('`', cursor)
    if (start < 0) {return output + linkifyMessageLinks(value.slice(cursor))}

    output += linkifyMessageLinks(value.slice(cursor, start))
    let endOfRun = start + 1
    while (value[endOfRun] === '`') {endOfRun += 1}
    const run = value.slice(start, endOfRun)
    const close = value.indexOf(run, endOfRun)

    if (close < 0) {return output + value.slice(start)}
    const end = close + run.length
    output += value.slice(start, end)
    cursor = end
  }

  return output
}

export async function openMatrixMarkdownLink(url: string): Promise<void> {
  const message = parseMatrixMessageLink(url)
  if (message) {
    requestMatrixMessageLink(message)

    return
  }
  const board = parseCompanyBoardLink(url)
  if (board) {
    requestCompanyBoardLink(board)

    return
  }
  const destination = parseDiscoveryLink(url)
  if (!destination) {
    await window.atumMatrix.openLink(url)
    return
  }
  if (destination.kind === 'app') {
    await runMatrixCommand({ kind: 'selectApp', appId: destination.appId })
    return
  }
  $matrixStoreListingRequest.set(destination.itemId)
  $matrixStoreShelfRequest.set(destination.shelf)
  try {
    await runMatrixCommand({ kind: 'discoverApps' })
  } catch (error) {
    if ($matrixStoreListingRequest.get() === destination.itemId) { $matrixStoreListingRequest.set(null) }
    if ($matrixStoreShelfRequest.get() === destination.shelf) { $matrixStoreShelfRequest.set(null) }
    throw error
  }
}

/** First-party discovery fragments navigate Atum. Other web links use the default
 * browser through main; local file access is not admitted by this host. */
export const MATRIX_MARKDOWN_HOST: MarkdownHost = {
  openLink: url => void openMatrixMarkdownLink(url).catch(() => {}),
  prepareMarkdown: prepareMatrixMessageLinks,
  resolveLink: url =>
    typeof url === 'string' && (parseMatrixMessageLink(url) || parseCompanyBoardLink(url)) ? url : null
}
