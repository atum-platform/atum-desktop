import { routineRunPrompt, type RoutineCoverage } from './routine-coverage'
/** Shared native projection: the platform owns the clock; Hermes owns execution. */
export function nativeJobProjection<T extends object>(definition: T, occurrenceAt: number, coverage?: RoutineCoverage) {
  if (!Number.isSafeInteger(occurrenceAt) || occurrenceAt < 0) {throw Error('native_job_projection_invalid')}
  const instant = new Date(occurrenceAt).toISOString()

  return { jobs: [{ ...definition, ...(coverage && 'prompt' in definition && typeof definition.prompt === 'string' ? { prompt: routineRunPrompt(definition.prompt, coverage) } : {}), enabled: true, state: 'scheduled', next_run_at: instant,
    created_at: instant, updated_at: instant, last_run_at: null, last_status: null,
    last_error: null, last_delivery_error: null, fire_claim: null, run_claim: null }], updated_at: instant }
}
