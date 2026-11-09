import { describe, expect, it, vi } from 'vitest'

import { confirmMigrationReport } from './migration-confirmation'
import type { MigrationReportModel } from './migration-report'

const model: MigrationReportModel = {
  report: { migrationId: 'migration', agentPrincipal: 'agent', issuedAt: 1, expiresAt: 2, holdUntil: 3,
    snapshots: [{ deviceServiceId: 'mac', sha256: 'a', bytes: 1, files: 1 }], report: null, reportSha256: null, missing: [] },
  choices: { defaultChoice: { drop: [], takeOther: [] }, drop: ['skills/spare'], takeOther: ['SOUL.md'] }
}

describe('native migration report choices', () => {
  it('shows the complete report before default consent and treats dismissal as cancellation', async () => {
    const show = vi.fn(async () => 0)
    expect(await confirmMigrationReport('en', model, show)).toEqual({ drop: [], takeOther: [] })
    expect(show.mock.calls).toHaveLength(1)
    expect(await confirmMigrationReport('en', model, async () => 2)).toBeNull()
  })

  it('binds every custom decision to the displayed path and cancels the entire choice if any prompt is dismissed', async () => {
    const responses = [1, 0, 1]
    const shown: string[] = []

    const answer = await confirmMigrationReport('en', model, async dialog => {
      shown.push(dialog.detail)

      return responses.shift()!
    })

    expect(answer).toEqual({ takeOther: ['SOUL.md'], drop: [] })
    expect(shown[1]).toContain('SOUL.md')
    expect(shown[2]).toContain('skills/spare')
    const cancelled = [1, 0, 2]
    expect(await confirmMigrationReport('en', model, async () => cancelled.shift()!)).toBeNull()
  })
})
