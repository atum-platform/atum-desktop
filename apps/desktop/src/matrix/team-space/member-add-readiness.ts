import { useCallback, useEffect, useRef, useState } from 'react'

import type { MatrixCompanyBridge } from '../../../shared/matrix-company'
import type { CompanyMemberAddReadiness112Response } from '../../../shared/matrix-company-team-space'

import { requestTeamSpace } from './request'

/**
 * What the viewer may do in one company (company-workspace/1.12 readiness): add directly, invite only, or neither.
 *
 * - `off`: the install does not serve direct add; the sheet keeps the one-press invite it had before.
 * - `checking`: asked, no answer yet (or asked again because an answer said the policy or roster moved). The sheet holds
 *   every action until it knows which one Add means.
 * - `unsupported`: the server does not serve 1.12 here (404/400), or the read failed before any answer. The sheet keeps
 *   the one-press invite, which the platform still decides.
 * - `ready`: the server's answer. A later failed read keeps it.
 */
export type MemberAddReadiness =
  | { state: 'off' }
  | { state: 'checking' }
  | { state: 'unsupported' }
  | { state: 'ready'; value: CompanyMemberAddReadiness112Response }

/** One read of the readiness. Exported for tests; the sheet uses `useMemberAddReadiness`. */
export async function readMemberAddReadiness(
  bridge: MatrixCompanyBridge,
  companyId: string,
  known: MemberAddReadiness
): Promise<MemberAddReadiness> {
  const result = await requestTeamSpace(bridge, { action: 'member-add-readiness', companyId })

  if (result.ok && result.value.companyId === companyId) {
    return { state: 'ready', value: result.value }
  }

  return known.state === 'ready' && known.value.companyId === companyId ? known : { state: 'unsupported' }
}

interface Held {
  /** The company and install state this answer belongs to. */
  scope: string
  readiness: MemberAddReadiness
}

/**
 * The readiness for the company a sheet was opened in, read when it opens, whenever the install starts or stops serving
 * direct add, and again on `reload`.
 *
 * Atomic by construction: what is returned is derived in render from the current company and install state. An answer
 * held for another company, or for the install before it changed, is never returned, so the render in which direct add
 * becomes available already says `checking` (no window where Add still sends the old invitation), and the render in which
 * it goes away already says `off`. Only the latest read applies. `reload({ hold: true })` returns to `checking` until the
 * new answer, for an answer that said the old one no longer holds.
 */
export function useMemberAddReadiness(
  bridge: MatrixCompanyBridge,
  companyId: string,
  enabled: boolean
): { readiness: MemberAddReadiness; reload(options?: { hold?: boolean }): void } {
  const scope = `${companyId}\n${enabled ? 'on' : 'off'}`
  const [held, setHeld] = useState<Held | undefined>(undefined)
  const generation = useRef(0)
  const latest = useRef({ scope, held })

  latest.current = { scope, held }

  const readiness: MemberAddReadiness = !enabled
    ? { state: 'off' }
    : held?.scope === scope ? held.readiness : { state: 'checking' }

  const reload = useCallback((options: { hold?: boolean } = {}) => {
    if (!enabled) {
      return
    }

    const mine = ++generation.current
    const asked = latest.current.scope
    const known = latest.current.held?.scope === asked ? latest.current.held.readiness : { state: 'checking' as const }

    if (options.hold) {
      setHeld({ scope: asked, readiness: { state: 'checking' } })
    }

    void readMemberAddReadiness(bridge, companyId, known).then(next => {
      // A late answer for an earlier read, another company or an install state since changed is not this sheet's.
      if (generation.current === mine && latest.current.scope === asked) {
        setHeld({ scope: asked, readiness: next })
      }
    })
  }, [bridge, companyId, enabled])

  useEffect(() => {
    if (!enabled) {
      generation.current += 1

      return
    }

    reload()

    return () => {
      generation.current += 1
    }
  }, [enabled, reload])

  return { readiness, reload }
}
