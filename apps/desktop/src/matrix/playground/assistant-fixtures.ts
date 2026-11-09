import type { MatrixSnapshot } from '../../../shared/matrix'
import type {
  MatrixAssistantCard,
  MatrixAssistantCardResult,
  MatrixAssistantCardsBridge
} from '../../../shared/matrix-assistant-card'
import { checkAssistantName, isAssistantNameLocked } from '../../../shared/matrix-assistant-name'
import { renameSoulHeading } from '../../../shared/matrix-assistant-persona'

/** Atum's built-in persona under the primary's name, as the card shows it before the owner
 * writes one (a stand-in: the real text lives with native, electron/matrix/atum-soul.ts). */
function primarySoul(name: string): string {
  return `You are ${name}, the person’s own assistant in the Atum app. If they give you another name, use it from then on and remember it.

You can do real work for them: read and organise files, write and edit documents, run commands, search and browse the web, use their apps, and keep reminders and scheduled tasks.

Be warm, brief and capable. Reply in the language they write in. Lead with the answer or the result, then offer one useful next step.`
}

const SOULS: Record<string, { soul: string; skills: string[] }> = {
  'agent-moon': {
    soul: '# Lan\n\n## Who you are\n\nĐiềm tĩnh, nói ngắn gọn.\n\n## What you do\n\nLo lịch họp và email công việc.',
    skills: ['google-calendar', 'gmail', 'web-search']
  }
}

/**
 * The assistant card's records in the playground: one per assistant on the roster, kept in
 * memory, renamed into the snapshot as main would (`?card=offline` refuses every write).
 */
export function playgroundAssistants(
  snapshot: () => MatrixSnapshot,
  emit: (next: MatrixSnapshot) => void,
  options: { offline?: boolean } = {}
): MatrixAssistantCardsBridge {
  const cards = new Map<string, MatrixAssistantCard>()

  const card = (principal: string): MatrixAssistantCard | undefined => {
    const agent = snapshot().agents?.find(each => each.principal === principal)

    if (!agent) {
      return undefined
    }

    let value = cards.get(principal)

    if (!value) {
      const seed = SOULS[principal]

      value = {
        principal,
        displayName: agent.name ?? 'Atum',
        isDefault: agent.isDefault,
        soul: agent.isDefault ? primarySoul(agent.name ?? 'Atum') : (seed?.soul ?? ''),
        inherited: agent.isDefault,
        skills: seed?.skills ?? (agent.isDefault ? ['web-search', 'reminders'] : []),
        definitionRevision: 3,
        identityRevision: 2
      }
      cards.set(principal, value)
    }

    return value
  }

  return {
    read: async principal => {
      const value = card(principal)

      return value ? { ok: true, card: value } : { ok: false, error: 'missing' }
    },
    save: async (change): Promise<MatrixAssistantCardResult> => {
      await new Promise(resolve => setTimeout(resolve, 250))
      const current = card(change.principal)

      if (!current) {
        return { ok: false, error: 'missing' }
      }

      if (options.offline) {
        return { ok: false, error: 'offline' }
      }

      if (
        change.expectedDefinitionRevision !== current.definitionRevision ||
        change.expectedIdentityRevision !== current.identityRevision
      ) {
        return { ok: false, error: 'conflict', card: current }
      }

      let next = { ...current }

      if (change.displayName !== undefined) {
        if (isAssistantNameLocked(current)) {
          return { ok: false, error: 'locked' }
        }

        const checked = checkAssistantName(change.displayName, {
          primary: current.isDefault,
          principal: change.principal,
          others: (snapshot().agents ?? []).map(each => ({ principal: each.principal, name: each.name }))
        })

        if (checked.ok === false) {
          return {
            ok: false,
            error:
              checked.problem === 'duplicate' ? 'duplicate' : checked.problem === 'reserved' ? 'reserved' : 'invalid'
          }
        }

        next = {
          ...next,
          displayName: checked.name,
          // The primary's built-in persona goes by its new name, as native writes it.
          soul: next.inherited ? primarySoul(checked.name) : renameSoulHeading(change.soul ?? next.soul, checked.name),
          identityRevision: next.identityRevision + 1
        }
      }

      if (change.soul !== undefined) {
        // Cleared on the primary: back to Atum's own persona.
        const inherited = current.isDefault && !change.soul.trim()
        next = {
          ...next,
          soul: inherited ? primarySoul(next.displayName) : renameSoulHeading(change.soul, next.displayName),
          inherited
        }
      }

      next.definitionRevision += 1
      cards.set(change.principal, next)
      const now = snapshot()

      emit({
        ...now,
        agents: now.agents?.map(each =>
          each.principal === change.principal ? { ...each, name: next.displayName } : each
        )
      })

      return { ok: true, card: next }
    },
    avatar: async change => {
      const current = snapshot()
      const avatarUrl = change.avatar ? URL.createObjectURL(new Blob([Uint8Array.from(change.avatar.bytes).buffer], {
        type: change.avatar.type
      })) : null

      emit({
        ...current,
        agents: current.agents?.map(each =>
          each.principal === change.principal ? { ...each, avatarUrl } : each
        )
      })

      return (current.agents ?? []).some(each => each.principal === change.principal)
        ? { ok: true, avatarUrl }
        : { ok: false, error: 'missing' }
    }
  }
}
