import { describe, expect, it } from 'vitest'

import { MANAGED_FAILURE_CODES, managedModelFailureCopy, parseManagedModelFailure } from './atum-managed-model-failure'

describe('managed model failure boundary', () => {
  it.each(MANAGED_FAILURE_CODES)('accepts and supplies visible copy for %s', code => {
    const parsed = parseManagedModelFailure({
      version: 1,
      code,
      access_alias: 'binh-minh',
      phase: 'pre_dispatch',
      recovery: 'retry',
      transient: true,
      preserve_draft: true
    })

    expect(parsed?.code).toBe(code)
    expect(managedModelFailureCopy(parsed!).message).not.toContain(code)
    expect(managedModelFailureCopy(parsed!).action).not.toBe('')
  })

  it.each(['managed_request_outcome_unknown', 'managed_request_in_progress', 'managed_request_cancelled'])('refuses a replay action for %s even when an upstream hint requests retry', code => {
    const failure = parseManagedModelFailure({ version: 1, code, access_alias: 'binh-minh', phase: 'post_dispatch', recovery: 'retry', transient: true, preserve_draft: false })
    expect(failure).toMatchObject({ recovery: 'pause', transient: false })
    expect(managedModelFailureCopy(failure!).message).not.toMatch(/safe to retry/i)
  })

  it('rejects wrong versions, unknown codes, aliases, and fields', () => {
    const base = {
      version: 1,
      code: 'rate_limited',
      access_alias: 'binh-minh',
      phase: 'pre_dispatch',
      recovery: 'retry',
      transient: true,
      preserve_draft: true
    }

    expect(parseManagedModelFailure({ ...base, version: 2 })).toBeNull()
    expect(parseManagedModelFailure({ ...base, code: 'secret_provider_error' })).toBeNull()
    expect(parseManagedModelFailure({ ...base, access_alias: 'other' })).toBeNull()
    expect(parseManagedModelFailure({ ...base, leaked_body: 'no' })).toBeNull()
  })
})
