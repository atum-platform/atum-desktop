/** Additive atum.weekly-roundup/1 response, owned by the platform occurrence ledger. */
export interface RoutineCoverage {
  profile: 'atum.routine-coverage/1'
  sinceMs: number
  throughMs: number
  firstRoundup: boolean
  includesMorningBrief: boolean
  timezone: string
  header: string
}
export function validRoutineCoverage(value: unknown): value is RoutineCoverage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as RoutineCoverage
  return Object.keys(v).sort().join(',') === 'firstRoundup,header,includesMorningBrief,profile,sinceMs,throughMs,timezone' &&
    v.profile === 'atum.routine-coverage/1' && Number.isSafeInteger(v.sinceMs) && v.sinceMs >= 0 &&
    Number.isSafeInteger(v.throughMs) && v.throughMs > v.sinceMs && v.throughMs-v.sinceMs <= 28*86400000 &&
    typeof v.firstRoundup === 'boolean' && typeof v.includesMorningBrief === 'boolean' &&
    typeof v.timezone === 'string' && v.timezone.length > 0 && v.timezone.length <= 128 &&
    typeof v.header === 'string' && v.header.length > 0 && v.header.length <= 2048
}
/** Only call with authenticated platform coverage. Never infer dates from model/inventory text. */
export function routineRunPrompt(prompt: string, coverage?: RoutineCoverage): string {
  return coverage ? `${coverage.header}\n\n${prompt}` : prompt
}
