import { createProfile, updateProfileSoul } from '@/hermes'
import { normalizeProfileKey, refreshProfiles } from '@/store/profile'

import { ATUM_AGENT_ID, ATUM_MANAGED_BY, type AtumAgent } from './agents'

/**
 * Making an agent, from three things a person can answer.
 *
 * The user gives a name, who the agent is, and what it does. Everything else
 * is derived: a filesystem-safe id from the name, an avatar, Atum's own model
 * and skills by cloning the master, Atum's approval posture (applied by the
 * main process before that agent's backend starts), and the shared document
 * workspace. Nothing about Hermes profiles reaches the person asking.
 */

/** Matches the assistant-registry contract. Atum never silently cuts a name. */
export const ATUM_ASSISTANT_NAME_MAX = 40
export const AGENT_TEXT_MAX = 2_000

export interface CreateAtumAgentInput {
  /** What the user typed. Becomes the display name and the basis for the id. */
  name: string
  /** Who the agent is. */
  persona: string
  /** What the agent does. */
  job: string
  /** A symbol for the roster row. */
  avatar: string
}

export interface CreateAtumAgentResult {
  id: string
}

/** Validate a product assistant name before either profile write can begin. */
export function atumAssistantName(value: string): string {
  const name = value.trim()

  if (!name) {
    throw new Error('agent_name_required')
  }

  if (name.length > ATUM_ASSISTANT_NAME_MAX) {
    throw new Error('agent_name_too_long')
  }

  if (Array.from(name).some(character => {
    const code = character.codePointAt(0) ?? 0

    return code < 0x20 || code === 0x7f
  })) {
    throw new Error('agent_name_invalid')
  }

  return name
}

const NON_SLUG = /[^a-z0-9]+/gu
const COMBINING_MARKS = /[̀-ͯ]/gu
const D_WITH_STROKE = /[đĐ]/gu

/**
 * A filesystem-safe id from a human name. Vietnamese tone marks are folded
 * rather than dropped, so "Trợ lý Marketing" becomes "tro-ly-marketing" and
 * not a string of hyphens.
 */
export function agentIdFromName(name: string): string {
  const folded = name
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .replace(D_WITH_STROKE, 'd')
    .toLowerCase()
    .replace(NON_SLUG, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 48)

  // A name made entirely of characters that cannot be slugified still has to
  // produce a usable id, and an id must start with a letter or digit.
  return /^[a-z0-9]/u.test(folded) ? folded : `agent${folded ? `-${folded}` : ''}`.replace(/-+$/u, '')
}

/** The first id not already taken, so two "Marketing" agents can coexist. */
export function availableAgentId(name: string, taken: readonly string[]): string {
  const base = agentIdFromName(name)
  const used = new Set([...taken.map(normalizeProfileKey), ATUM_AGENT_ID])

  if (!used.has(base)) {
    return base
  }

  for (let suffix = 2; suffix < 1_000; suffix += 1) {
    const candidate = `${base}-${suffix}`

    if (!used.has(candidate)) {
      return candidate
    }
  }

  return `${base}-${Date.now()}`
}

/**
 * One file holds who the agent is and what it does, because Hermes reads it
 * from the agent's own home. The alternative, a workspace instruction file,
 * would collide: every agent shares one document folder.
 */
export function agentSoulDocument({ name, persona, job }: Pick<CreateAtumAgentInput, 'name' | 'persona' | 'job'>): string {
  const sections = [`# ${name.trim()}`]

  if (persona.trim()) {
    sections.push(`## Who you are\n\n${persona.trim()}`)
  }

  if (job.trim()) {
    sections.push(`## What you do\n\n${job.trim()}`)
  }

  return `${sections.join('\n\n')}\n`
}

/**
 * Create the agent, then give it its instructions.
 *
 * The profile must exist before its instructions can be written, so this is
 * two calls. If the second fails the agent still exists and is usable, which
 * is why the caller is told which step failed rather than being left to guess
 * whether anything was made.
 */
export async function createAtumAgent(
  input: CreateAtumAgentInput,
  existing: readonly AtumAgent[]
): Promise<CreateAtumAgentResult> {
  const name = atumAssistantName(input.name)

  const id = availableAgentId(name, existing.map(agent => agent.id))

  const created = await createProfile({
    avatar: input.avatar.trim(),
    // Clone the master so a new agent arrives with the same model, skills, and
    // settings the person already knows, rather than an empty shell.
    clone_from: ATUM_AGENT_ID,
    display_name: name,
    managed_by: ATUM_MANAGED_BY,
    // The id, not the display name: this is the profile's filesystem-safe key.
    name: id
  })

  // The server is the authority on the id it actually made.
  const agentId = normalizeProfileKey(created?.name) || id

  await updateProfileSoul(agentId, agentSoulDocument({ job: input.job, name, persona: input.persona }))

  // The agent exists and has its instructions by now. Refreshing the list is
  // how it appears in the roster, not part of making it — letting a failed
  // refresh throw told the user creation had failed, so they tried again and
  // got a second agent with a suffixed id.
  try {
    await refreshProfiles()
  } catch {
    // The roster will pick it up on the next refresh.
  }

  return { id: agentId }
}
