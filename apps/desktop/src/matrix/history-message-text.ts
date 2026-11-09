// Pure text helper shared by the desktop's history search and the cloud controller's company
// message search. It must stay free of UI state (nanostores, React): the controller bundles it.

/** What the Markdown renderer shows as words, without link destinations or formatting marks. */
export function historyMessageText(body: string): string {
  return body
    .replace(/!\[([^\]]*)\]\([^\n)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^\n)]*\)/gu, '$1')
    .replace(/<[^>\n]+>/gu, ' ')
    .replace(/[*_~`]/gu, '')
}
