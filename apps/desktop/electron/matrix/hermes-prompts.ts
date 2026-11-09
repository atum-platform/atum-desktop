import { randomUUID } from 'node:crypto'

import {
  MATRIX_PROMPT_MAX,
  type MatrixHermesPrompt,
  type MatrixHermesPromptAnswer,
  type MatrixHermesPromptContent
} from '../../shared/matrix'

export type MatrixHermesAsk = (
  prompt: MatrixHermesPromptContent,
  signal: AbortSignal,
  deadlineAt: number
) => Promise<MatrixHermesPromptAnswer>

/** Only documented display fields cross into the renderer, never raw payloads. */
export function readMatrixHermesPrompt(
  type: string,
  value: unknown
): { requestId: string; content: MatrixHermesPromptContent } {
  const row = value as Record<string, unknown> | null

  const text = (key: string, max = 16000) => {
    const value = row?.[key]

    if (typeof value !== 'string' || value.length > max) {
      throw new Error('matrix_hermes_prompt_invalid')
    }

    return value
  }

  const requestId = text('request_id', 128)

  if (!requestId) {
    throw new Error('matrix_hermes_prompt_invalid')
  }

  if (type === 'sudo.request') {
    return { requestId, content: { kind: 'sudo' } }
  }

  if (type === 'secret.request') {
    const envVar = typeof row?.env_var === 'string' ? row.env_var : ''
    const prompt = typeof row?.prompt === 'string' ? row.prompt : ''

    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(envVar) || prompt.length > 2000) {
      throw new Error('matrix_hermes_prompt_invalid')
    }

    return { requestId, content: { kind: 'secret', envVar, prompt } }
  }

  if (type === 'approval.request') {
    return {
      requestId,
      content: {
        kind: 'approval',
        command: text('command'),
        description: text('description'),
        allowOnce: row?.choices === undefined || (Array.isArray(row.choices) && row.choices.includes('once'))
      }
    }
  }

  const question = text('question')

  if (
    !question ||
    (row?.choices != null &&
      (!Array.isArray(row.choices) ||
        row.choices.length > 20 ||
        row.choices.some(choice => typeof choice !== 'string' || !choice.trim() || choice.length > 200)))
  ) {
    throw new Error('matrix_hermes_prompt_invalid')
  }

  return { requestId, content: { kind: 'clarify', question, choices: (row?.choices as string[] | null) ?? [] } }
}

/** One invocation's ephemeral UI capabilities, not a permission policy/store.
 * Removal is synchronous; a delayed response cannot target a replacement card.
 */
export class MatrixHermesPrompts {
  private readonly pending = new Map<
    string,
    {
      prompt: MatrixHermesPrompt
      signal: AbortSignal
      resolve: (answer: MatrixHermesPromptAnswer) => void
    }
  >()

  constructor(private readonly changed: () => void) {}

  snapshot(): MatrixHermesPrompt[] {
    return [...this.pending.values()].map(entry => entry.prompt)
  }

  readonly ask: MatrixHermesAsk = (content, signal, deadlineAt) => {
    signal.throwIfAborted()

    if (this.pending.size >= 8) {
      throw new Error('matrix_hermes_prompt_limit')
    }

    const id = randomUUID()

    return new Promise((resolve, reject) => {
      const remove = () => {
        signal.removeEventListener('abort', abort)
        this.pending.delete(id)
        this.changed()
      }

      const abort = () => {
        remove()
        reject(new Error('matrix_hermes_prompt_expired'))
      }

      this.pending.set(id, {
        prompt: { ...content, id, deadlineAt },
        signal,
        resolve: answer => {
          remove()
          resolve(answer)
        }
      })
      signal.addEventListener('abort', abort, { once: true })
      this.changed()
    })
  }

  /** Whether this turn asked prompt `id`: a response goes to the agent whose turn asked. */
  asked(id: unknown): boolean {
    return typeof id === 'string' && this.pending.has(id)
  }

  respond(value: unknown): void {
    const row = value as Record<string, unknown> | null
    const entry = row && typeof row.id === 'string' ? this.pending.get(row.id) : undefined

    if (!entry || entry.signal.aborted || Date.now() >= entry.prompt.deadlineAt || row?.kind !== entry.prompt.kind) {
      throw new Error('matrix_hermes_prompt_expired')
    }

    if (entry.prompt.kind === 'approval') {
      if (row.choice !== 'deny' && !(row.choice === 'once' && entry.prompt.allowOnce)) {
        throw new Error('matrix_hermes_response_invalid')
      }

      entry.resolve({ kind: 'approval', choice: row.choice })
    } else if (entry.prompt.kind === 'sudo') {
      if (typeof row.password !== 'string' || row.password.length > 1024) {
        throw new Error('matrix_hermes_response_invalid')
      }

      entry.resolve({ kind: 'sudo', password: row.password })
    } else if (entry.prompt.kind === 'secret') {
      if (typeof row.value !== 'string' || row.value.length > 16000) {
        throw new Error('matrix_hermes_response_invalid')
      }

      entry.resolve({ kind: 'secret', value: row.value })
    } else {
      if (typeof row.answer !== 'string' || row.answer.length > MATRIX_PROMPT_MAX) {
        throw new Error('matrix_hermes_response_invalid')
      }

      entry.resolve({ kind: 'clarify', answer: row.answer })
    }
  }
}
