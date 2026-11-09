import type { MatrixMessage } from '../../shared/matrix'

/** Safe Markdown projection of the two strictly parsed greeting anchors. */
export function privateCosGreetingMarkdown(message: MatrixMessage): string | undefined {
  const pill = message.privateCosAgentPill
  const board = message.privateCosBoardLink

  return pill && board
    ? message.body
        .replace(pill.label, `[${pill.label}](${pill.href})`)
        .replace(`${board.title}: ${board.href}`, `[${board.title}](${board.href})`)
    : undefined
}
