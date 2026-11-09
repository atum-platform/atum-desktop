import type { AtumMentionTargetCandidate } from '@/lib/atum-messaging-client'

export interface DmMentionSelection extends AtumMentionTargetCandidate {
  endOffset: number
  startOffset: number
}

export const LEGACY_ATUM_TARGET: AtumMentionTargetCandidate = {
  target: { type: 'assistant', id: 'binh-minh' },
  revision: 0,
  displayName: 'Atum',
  avatar: ''
}

export function mentionLabel(target: Pick<AtumMentionTargetCandidate, 'displayName'>): string {
  return `@${target.displayName}`
}

/** The server can list a room agent for attribution without granting an invocation. */
export function mentionIsInvocable(target: Pick<AtumMentionTargetCandidate, 'availability'>): boolean {
  return target.availability === undefined || target.availability === 'available'
}

export function selectedMention(content: string, startOffset: number, target: AtumMentionTargetCandidate): DmMentionSelection | null {
  const label = mentionLabel(target)

  if (content.slice(startOffset, startOffset + label.length) !== label) {
    return null
  }

  return { ...target, startOffset, endOffset: startOffset + label.length }
}

/** Legacy unit-test and old-composer compatibility helper. */
export function selectedAtumMention(content: string, startOffset: number): DmMentionSelection | null {
  return selectedMention(content, startOffset, LEGACY_ATUM_TARGET)
}

/**
 * Carry a selection only through the actual changed interval. Searching the
 * new text for its label would attach an identity to an unrelated literal
 * mention, especially when two assistants share a display name.
 */
export function reconcileMentionSelections(
  previousContent: string,
  content: string,
  selections: readonly DmMentionSelection[],
  caret: number
): DmMentionSelection[] {
  if (previousContent === content) {return [...selections]}

  // Anchor the changed interval to the browser's post-input caret. A maximal
  // common prefix alone mistakes deletion of the FIRST of two identical tokens
  // for deletion of the second, silently moving its identity to a literal.
  const shift = content.length - previousContent.length
  const previousChangeEnd = caret - shift

  if (caret < 0 || caret > content.length || previousChangeEnd < 0 || previousChangeEnd > previousContent.length ||
    previousContent.slice(previousChangeEnd) !== content.slice(caret)) {
    return [] // Unsupported/non-contiguous edit: require an explicit reselection.
  }

  let prefix = 0

  while (prefix < Math.min(previousChangeEnd, caret) && previousContent[prefix] === content[prefix]) {
    prefix += 1
  }

  return selections.flatMap(selection => {
    if (selection.endOffset <= prefix) {
      return [selection]
    }

    if (selection.startOffset >= previousChangeEnd) {
      return [{ ...selection, startOffset: selection.startOffset + shift, endOffset: selection.endOffset + shift }]
    }

    return []
  })
}

export function mentionSearchStart(content: string, caret: number): number | null {
  const beforeCaret = content.slice(0, caret)
  const match = beforeCaret.match(/(?:^|\s)@([^\s@]*)$/u)

  return match ? caret - (match[1]?.length ?? 0) - 1 : null
}
