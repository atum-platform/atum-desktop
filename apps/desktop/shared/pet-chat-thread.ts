import type { AtumPetChatTurn } from './pet-chat/atum-pet-chat'

/** A long session keeps only its newest turns; the history holds at most eight anyway. */
const SESSION_MAX = 40

/**
 * What a pet chat box shows: the pet's stored history (`recent`), then the turns this session
 * saw answered that the history does not hold. A reply's top-level `reply` is the answer;
 * `recent` is only the stored history and can be empty or lag (a first chat, or the
 * platform's fallback when the model fails). Session turns are presentation only: they are
 * never written into `recent`, so a reopened chat shows what was really kept.
 *
 * Stored turns are the newest at the end of `recent`, so the session is matched against the
 * history from both ends, in order. It never compares clocks, and an old "hi" further back in
 * the history is not mistaken for today's.
 */
export function petChatUnsaved(recent: readonly AtumPetChatTurn[], session: readonly AtumPetChatTurn[]) {
  const unsaved: AtumPetChatTurn[] = []
  let stored = recent.length - 1

  for (let index = session.length - 1; index >= 0; index -= 1) {
    const turn = session[index]!
    const match = recent[stored]

    if (match && match.role === turn.role && match.text.trim() === turn.text.trim()) {
      stored -= 1
    } else {
      unsaved.unshift(turn)
    }
  }

  return unsaved
}

/** The session after one answered message: the sent words, then the pet's reply. */
export function petChatAnswered(
  session: readonly AtumPetChatTurn[],
  sent: { text: string; at: string },
  reply: { text: string; at: string }
): AtumPetChatTurn[] {
  const next: AtumPetChatTurn[] = [...session, { role: 'user', text: sent.text, at: sent.at }]

  if (reply.text.trim()) {
    next.push({ role: 'pet', text: reply.text, at: reply.at })
  }

  return next.slice(-SESSION_MAX)
}
