/**
 * The authenticated readiness report of the Mac that holds an agent's home (`home.readiness.report`).
 *
 * "Reachable" is the platform's word for this and it means three facts about the AGENT SERVICE, never about
 * the device hub: the home is accessible on disk, the agent's runtime is usable, and Matrix intake works. The
 * platform stamps the report with its own receive time and keeps its own `lastReadyAtPlatform`: this Mac's
 * clock is only ever reported as a fact (`reportedAtLocal`), not used as one.
 *
 * It is sent only while this Mac is the home and holds a live lease term (the report is fenced by the lease),
 * signed fresh each time. A Mac that is not the home reports nothing.
 */
import type { HomeReadinessObservation } from './contract'
import type { HomeContext } from './runtime-ops'
import { failureWord, signedCall } from './signed-call'
import { type Standing } from './standing'

export type ReadinessResult =
  | { sent: true; observation: HomeReadinessObservation }
  | { sent: false; reason: string }

/** Only the settled home reports: a Mac that drains, activates or stands down is not asserting it can answer. */
const reports = (standing: Standing): boolean => standing.state === 'home'

export async function reportReadiness(ctx: HomeContext, agent: string, signal: AbortSignal): Promise<ReadinessResult> {
  const result = await signedCall<HomeReadinessObservation>(
    { standing: ctx.standing, auth: ctx.auth, leaseFacts: a => ctx.runtime.leaseFacts(a) },
    agent,
    null,
    reports,
    ({ lease }) => {
      const checks = ctx.runtime.readiness(agent)

      return ctx.auth
        .sign('ReadinessReport', meta => ({
          meta,
          fence: lease,
          reportedAtLocal: ctx.now(),
          powerState: ctx.runtime.power(),
          checks: {
            homeAccessible: checks.homeAccessible,
            runtimeUsable: checks.runtimeUsable,
            matrixIntakeWorking: checks.matrixIntakeWorking
          }
        }))
        .then(body => ctx.platform.reportReadiness(agent, body as never, signal))
    },
    signal
  )

  return result.ok === true ? { sent: true, observation: result.value } : { sent: false, reason: failureWord(result.failure) }
}
