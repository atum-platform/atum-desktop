import { z } from 'zod'

const option = z.object({ label: z.string().min(1).max(200), value: z.string().min(1).max(200).optional() })
export const nativeQuestion = z.object({
  id: z.string().min(1).max(512),
  question: z.string().min(1).max(2400),
  options: z.array(option).max(12),
  multiSelect: z.boolean().optional(),
  allowCustomAnswer: z.boolean().optional()
})

type Question = z.infer<typeof nativeQuestion>

export function renderQuestion(question: Question): string {
  return [question.question.trim(), ...question.options.map((option, index) => `${index + 1}. ${option.label.trim()}`)].join('\n')
}

export function questionAnswers(question: Question, body: string): Record<string, string | string[]> | undefined {
  // Matrix rich replies may include the quoted fallback before the owner's answer.
  const text = body.replace(/^(?:>[^\n]*\n)+\n/u, '').trim()
  if (!text || text.length > 12_000) {return undefined}

  const pick = (input: string): string | undefined => {
    const value = input.trim().toLowerCase()
    const byNumber = /^[1-9]\d*$/u.test(value) ? question.options[Number(value) - 1] : undefined
    const match = byNumber ?? question.options.find(option =>
      option.label.trim().toLowerCase() === value || option.value?.trim().toLowerCase() === value)
    return match && (match.value ?? match.label)
  }

  // Match a complete option first, so commas within its label remain literal.
  const single = pick(text)
  if (!question.multiSelect) {
    return single || !question.options.length || question.allowCustomAnswer !== false
      ? { [question.id]: single ?? text }
      : undefined
  }
  if (single) {return { [question.id]: [single] }}

  const lines = text.split(/\r?\n/u).map(line => line.trim()).filter(Boolean)
  const commaChoices = lines.length === 1 && text.includes(',') ? text.split(',').map(pick) : []
  const mapped = commaChoices.length && commaChoices.every(value => value !== undefined)
    ? commaChoices
    : lines.map(line => pick(line) ?? (question.allowCustomAnswer !== false ? line : undefined))
  return mapped.every(value => value !== undefined) ? { [question.id]: mapped } : undefined
}
