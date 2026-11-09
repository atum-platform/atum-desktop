import type { MatrixEnrollment, MatrixReadiness } from '../../shared/matrix'

import type { MatrixReadinessCheck } from './readiness'

/** Agent metadata belongs to the Atum grant. Human Matrix state still publishes
 * after that grant is lost, without reading participant custody as authority. */
export function readMatrixAgentPresentation<T>(available: boolean, read: () => T): T | undefined {
  return available ? read() : undefined
}

/** Custody is retained, but this enrollment no longer admits setup or execution. */
export function matrixEnrollmentAuthority(enrollment: MatrixEnrollment): MatrixReadinessCheck {
  return enrollment.state === 'withdrawn' ? { ok: false, code: 'authority_withdrawn' } : { ok: true }
}

/** Main's assistant gate: no automatic or manual setup through withdrawn custody,
 * including a refusal persisted while the existing setup awaited a provider. */
export async function admitMatrixEnrollmentSetup(
  enrollment: () => MatrixEnrollment,
  setup: () => Promise<void>
): Promise<MatrixReadinessCheck> {
  const before = matrixEnrollmentAuthority(enrollment())

  if (!before.ok) {
    return before
  }

  try {
    await setup()
  } catch (error) {
    const after = matrixEnrollmentAuthority(enrollment())

    if (!after.ok) {
      return after
    }

    throw error
  }

  return matrixEnrollmentAuthority(enrollment())
}

/** Enrollment truth outranks a still-ready host/watch. The last published blocked
 * view owns its presentation timestamp; this is not another authority store. */
export function projectMatrixEnrollmentReadiness(
  enrollment: MatrixEnrollment,
  current: MatrixReadiness | undefined,
  previous: MatrixReadiness | undefined,
  now = Date.now()
): MatrixReadiness | undefined {
  if (matrixEnrollmentAuthority(enrollment).ok) {
    return current
  }

  const blocked = [previous, current].find(value => value?.code === 'authority_withdrawn')

  return { phase: 'blocked', step: 'authority', code: 'authority_withdrawn', since: blocked?.since ?? now }
}
