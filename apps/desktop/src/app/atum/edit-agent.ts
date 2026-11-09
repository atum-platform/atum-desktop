import { getProfileSoul, updateProfileIdentity, updateProfileSoul } from '@/hermes'
import { normalizeProfileKey, refreshProfiles } from '@/store/profile'

import { ATUM_AGENT_ID } from './agents'
import { agentSoulDocument, atumAssistantName } from './create-agent'

/**
 * Changing an assistant after it exists: its name, its symbol, and the two
 * answers that became its instructions. The same three things the create
 * sheet asked for, read back and written again — nothing about Hermes
 * profiles reaches the person editing.
 */

export interface AtumAgentInstructions {
  persona: string
  job: string
}

export interface EditAtumAgentInput {
  id: string
  name: string
  /** Legacy symbols are not rewritten by the photo editor. */
  avatar?: string
  /** `null` leaves the instructions untouched (they were not shown, or not changed). */
  instructions: AtumAgentInstructions | null
}

/**
 * Read the persona and job back out of an instructions document Atum wrote.
 *
 * Returns `null` for a document Atum did not write — a hand-edited file with
 * its own headings, or prose before the first heading — because rewriting
 * that from two text boxes would silently throw the rest of it away. The
 * edit sheet then offers identity only.
 */
export function parseAgentSoulDocument(content: string): AtumAgentInstructions | null {
  const text = content.replace(/\r\n/gu, '\n').trim()

  if (!text) {
    return { job: '', persona: '' }
  }

  const lines = text.split('\n')

  if (!/^# .+/u.test(lines[0] ?? '')) {
    return null
  }

  const sections = new Map<string, string[]>()
  let current: string | null = null

  for (const line of lines.slice(1)) {
    const heading = /^## (.+)$/u.exec(line)

    if (heading) {
      current = heading[1]!.trim()

      if (sections.has(current)) {
        return null
      }

      sections.set(current, [])

      continue
    }

    if (current === null) {
      if (line.trim()) {
        return null
      }

      continue
    }

    sections.get(current)!.push(line)
  }

  for (const title of sections.keys()) {
    if (title !== 'Who you are' && title !== 'What you do') {
      return null
    }
  }

  const body = (title: string) => (sections.get(title) ?? []).join('\n').trim()

  return { job: body('What you do'), persona: body('Who you are') }
}

/**
 * What the edit sheet starts from. A missing document reads as empty
 * instructions, which is what a brand-new assistant made with no answers has.
 */
export async function loadAtumAgentInstructions(agentId: string): Promise<AtumAgentInstructions | null> {
  const soul = await getProfileSoul(normalizeProfileKey(agentId))

  return soul.exists ? parseAgentSoulDocument(soul.content) : { job: '', persona: '' }
}

/**
 * Save the edit. Identity first, then instructions only when they were shown
 * and changed. If the second step fails the name and symbol are already saved,
 * which is why the caller is told which step failed rather than being left to
 * guess whether anything was kept.
 */
export async function editAtumAgent(input: EditAtumAgentInput): Promise<void> {
  const id = normalizeProfileKey(input.id)

  if (!id || id === ATUM_AGENT_ID) {
    throw new Error('agent_not_editable')
  }

  const name = atumAssistantName(input.name)

  await updateProfileIdentity(id, {
    ...(input.avatar === undefined ? {} : { avatar: input.avatar.trim() }),
    display_name: name
  })

  if (input.instructions) {
    await updateProfileSoul(id, agentSoulDocument({ job: input.instructions.job, name, persona: input.instructions.persona }))
  }

  // The change is saved by now. Refreshing is how the roster shows the new
  // name, not part of saving it; a failed refresh must not read as a failed edit.
  try {
    await refreshProfiles()
  } catch {
    // The roster will pick it up on the next refresh.
  }
}
