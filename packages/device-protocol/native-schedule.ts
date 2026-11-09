import type { MacJobFireResponse } from './vendor/mac-jobs-0.7.72/mac-jobs'
import type { RoutineCoverage } from './routine-coverage'
type WireFire = NonNullable<Extract<MacJobFireResponse, { operation: 'claimed' }>['fire']>
// Consume only the fields this mapping owns; cloud validates its broader definition separately.
type Fire = Pick<WireFire, 'jobId' | 'definitionRevision' | 'definitionDigest' | 'arm'> & {
  coverage?: RoutineCoverage
  nativeDefinition: Pick<WireFire['nativeDefinition'], 'name'>
  atumExtension: { profile: 'atum.managed-job-extension/1'; routine: { notifications: boolean } } |
    { profile: 'atum.managed-sweep-extension/1' }
}
/** AtumCronScheduler's arm-to-occurrence mapping, shared by cloud and Mac. */
export function nativeScheduleForFire(agentPrincipal: string, fire: Fire) {
  if (fire.atumExtension.profile !== 'atum.managed-job-extension/1') {throw Error('sweep_requires_native_admission')}
  return {
      ...(fire.coverage ? { coverage: fire.coverage } : {}),
      scheduleId: fire.jobId,
      definitionDigest: fire.definitionDigest,
      nextOccurrenceAt: fire.arm.occurrenceAt,
      catchupWindowMs: fire.arm.catchupWindowMs,
      title: fire.nativeDefinition.name,
      notifications: fire.atumExtension.routine.notifications,
      nativeJob: {
        agentPrincipal: agentPrincipal,
        jobId: fire.jobId,
        definitionRevision: fire.definitionRevision,
        definitionDigest: fire.definitionDigest,
        nextOccurrenceAt: fire.arm.occurrenceAt,
        nextTrigger: fire.arm.nextTrigger,
        executionGeneration: fire.arm.executionGeneration
      }
    }
}
