import { z } from 'zod'

const option = z.object({ label: z.string().min(1).max(200), value: z.string().min(1).max(200).optional() })
export const nativeQuestions = z.array(z.object({
  id: z.string().min(1).max(512),
  question: z.string().min(1).max(2400),
  options: z.array(option).max(12),
  multiSelect: z.boolean().optional(),
  allowCustomAnswer: z.boolean().optional()
})).min(1).max(6).refine(questions => new Set(questions.map(question => question.id)).size === questions.length)

type Questions = z.infer<typeof nativeQuestions>

export function questionAnswers(questions: Questions, body: string): Record<string, string | string[]> | undefined {
  // Matrix rich replies may include the quoted fallback before the owner's answer.
  const text = body.replace(/^(?:>[^\n]*\n)+\n/u, '').trim()
  const lines = questions.length === 1 ? [text] : text.split(/\r?\n/u).map(line => line.trim()).filter(Boolean)

  if (lines.length !== questions.length || !text || text.length > 12_000) {
    return undefined
  }

  const entries: [string, string | string[]][] = []

  for (const [index, question] of questions.entries()) {
    const line = questions.length === 1 ? lines[index] : lines[index].replace(new RegExp(`^${index + 1}[.)]\\s+`, 'u'), '')
    const chosen = question.multiSelect ? line.split(',') : [line]

    const mapped = chosen.map(part => {
      const value = part.trim()
      const match = question.options.find(each => each.label === value || each.value === value)

      return match ? match.value ?? match.label : !question.options.length || question.allowCustomAnswer !== false ? value : ''
    })

    if (mapped.some(value => !value)) {
      return undefined
    }

    entries.push([question.id, question.multiSelect ? mapped : mapped[0]])
  }

  return Object.fromEntries(entries)
}
