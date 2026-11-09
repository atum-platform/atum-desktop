import { readFileSync } from 'node:fs'

import { afterEach, expect, it, vi } from 'vitest'

import { listMatrixAgentDefinitions } from './agent-definition'
import { matrixDefaultAgent, matrixRetiredRootCustody, matrixRosterChanges } from './agent-routing'

afterEach(() => vi.unstubAllGlobals())

// An optional private acceptance input is the exact JSON bytes returned by the
// verified owner-scoped SQL projection. It never goes into Git or review jobs.
it.runIf(Boolean(process.env.ATUM_RETIREMENT_ROSTER_PROOF))('decodes live SQL bytes and chooses only the explicit retired root for cleanup', async () => {
  const bytes = readFileSync(process.env.ATUM_RETIREMENT_ROSTER_PROOF!, 'utf8')
  const wire = JSON.parse(bytes)
  const expected = wire[0].retired_agents[0]
  vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes, { headers: { 'Content-Type': 'application/json' } })))

  const roster = await listMatrixAgentDefinitions('https://acceptance.invalid/api', {
    issuer: 'https://acceptance.invalid/', subject: 'synthetic', accessToken: 'synthetic', refreshToken: 'synthetic'
  }, AbortSignal.timeout(1000))

  const primary = matrixDefaultAgent(roster)
  const root = matrixRetiredRootCustody({ roster, rootPrincipal: expected.principal, productDefaultPrincipal: primary.principal })
  expect(root).toMatchObject({ principal: expected.principal, status: 'retired', isDefault: false })
  expect(primary).toMatchObject({ principal: wire[0].principal, status: 'active', isDefault: true })
  expect(matrixRosterChanges({ roster, defaultPrincipal: expected.principal, known: [], keep: new Set() }).active)
    .toHaveLength(wire.length)
  expect(matrixRetiredRootCustody({ roster: roster.filter(row => row.status === 'active'),
    rootPrincipal: expected.principal, productDefaultPrincipal: primary.principal })).toBeUndefined()
})
