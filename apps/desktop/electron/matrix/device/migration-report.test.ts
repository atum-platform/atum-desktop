import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import type { MigrationReconcileReport, MigrationReport, MigrationSnapshot } from '../../../../../packages/device-protocol/migration-messages'

import { canonicalJson } from './canonical'
import {
  inspectMigrationChoice,
  inspectMigrationReport,
  migrationChoiceFields,
  type MigrationChoiceInspection,
  migrationChoicePrompt,
  migrationReportConfirmation,
  type MigrationReportContext
} from './migration-report'

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../packages/device-protocol/fixtures/device-service/fixtures')
const read = <T>(name: string) => JSON.parse(readFileSync(path.join(fixtures, name), 'utf8')) as T
type TwoMacReport = Omit<MigrationReport, 'snapshots' | 'report' | 'reportSha256'> & {
  snapshots: [MigrationSnapshot, MigrationSnapshot]
  report: MigrationReconcileReport
  reportSha256: string
}
type OneMacReport = Omit<MigrationReport, 'snapshots' | 'report' | 'reportSha256'> & {
  snapshots: [MigrationSnapshot]
  report: null
  reportSha256: null
}
const twoMac = read<{ body: MigrationReport }>('migration-report.frame.json').body as TwoMacReport
const oneMac = read<{ body: MigrationReport }>('migration-report-one-mac.frame.json').body as OneMacReport

function context(report: MigrationReport = twoMac, now = report.issuedAt): MigrationReportContext {
  const snapshot = report.snapshots[0]!

  return {
    migrationId: report.migrationId,
    agentPrincipal: report.agentPrincipal,
    deviceServiceId: snapshot.deviceServiceId,
    archive: { sha256: snapshot.sha256, bytes: snapshot.bytes, files: snapshot.files },
    holdUntil: report.holdUntil,
    now
  }
}

function accepted(report: MigrationReport = twoMac, local = context(report)) {
  const value = inspectMigrationReport(report, local)
  expect(value.accepted).toBe(true)

  if (!value.accepted) {
    throw Error('expected report to be accepted')
  }

  return value.model
}

function rejected(value: ReturnType<typeof inspectMigrationReport>) {
  if ('reason' in value) {return value.reason}
  throw Error('expected report to be rejected')
}

function rejectedChoice(value: MigrationChoiceInspection) {
  if ('reason' in value) {return value.reason}
  throw Error('expected choice to be rejected')
}

describe('MigrationReport binding and choices', () => {
  it('binds the real canonical report hash and derives only the frozen allowed choices', () => {
    const model = accepted()
    expect(model.choices.defaultChoice).toEqual({ drop: [], takeOther: [] })
    expect(model.choices.drop).toEqual([
      'memories/projects/atum.md', 'kanban.db', 'skills/morning-brief', 'skills/receipts', 'skills/notes.mini'
    ])
    expect(model.choices.takeOther).toEqual(['SOUL.md', 'projects.db'])
    expect(migrationChoiceFields(model, model.choices.defaultChoice)).toEqual({
      reportSha256: twoMac.reportSha256, drop: [], takeOther: []
    })
  })

  it('refuses a report whose migration, archive, hash, or reconcile snapshot relation changes', () => {
    expect(rejected(inspectMigrationReport({ ...twoMac, migrationId: 'other' }, context()))).toBe('migration_mismatch')
    expect(rejected(inspectMigrationReport({ ...twoMac, snapshots: [{ ...twoMac.snapshots[0], bytes: 1 }, twoMac.snapshots[1]] }, context())))
      .toBe('initiator_snapshot_altered')
    expect(rejected(inspectMigrationReport({ ...twoMac, reportSha256: '0'.repeat(64) }, context()))).toBe('report_sha256_mismatch')
    expect(rejected(inspectMigrationReport({ ...twoMac, report: { ...twoMac.report, base: twoMac.snapshots[1].deviceServiceId } }, context())))
      .toBe('report_snapshots_mismatch')
  })

  it('refuses unsafe report timing and holds before the owner can see a choice', () => {
    expect(rejected(inspectMigrationReport(twoMac, context(twoMac, twoMac.expiresAt + 1)))).toBe('report_expired')
    expect(rejected(inspectMigrationReport({ ...twoMac, issuedAt: twoMac.issuedAt + 30_001 }, context()))).toBe('report_issued_in_future')
    expect(rejected(inspectMigrationReport({ ...twoMac, holdUntil: twoMac.holdUntil + 1 }, context()))).toBe('report_hold_later_than_local')
    expect(rejected(inspectMigrationReport({ ...twoMac, expiresAt: twoMac.holdUntil - 599_999 }, context()))).toBe('report_expiry_past_hold')
  })

  it('requires a unique, contract-allowed subset and supports the one-Mac empty choice', () => {
    const model = accepted()
    expect(rejectedChoice(inspectMigrationChoice(model.choices, { drop: ['kanban.db', 'kanban.db'], takeOther: [] }))).toBe('duplicate_drop')
    expect(rejectedChoice(inspectMigrationChoice(model.choices, { drop: ['SOUL.md'], takeOther: [] }))).toBe('invalid_drop')
    expect(rejectedChoice(inspectMigrationChoice(model.choices, { drop: [], takeOther: ['SOUL.md', 'SOUL.md'] }))).toBe('duplicate_take_other')
    expect(rejectedChoice(inspectMigrationChoice(model.choices, { drop: [], takeOther: ['memories/USER.md'] }))).toBe('invalid_take_other')
    expect(inspectMigrationChoice(model.choices, { drop: ['skills/notes.mini'], takeOther: ['SOUL.md'] })).toEqual({ accepted: true })
    expect(accepted(oneMac).choices).toEqual({ defaultChoice: { drop: [], takeOther: [] }, drop: [], takeOther: [] })
  })
})

describe('migration report confirmation text', () => {
  it('shows every replacement, missing snapshot, and omission in every native locale without snapshots', () => {
    const reconcile: MigrationReconcileReport = {
      ...twoMac.report, omitted: 7, replaced: [
        ...twoMac.report.replaced,
        { path: 'state.db', kept: 'base' as const }
      ]
    }

    const report: MigrationReport = {
      ...twoMac,
      missing: [{ deviceServiceId: 'offline-mac', reason: 'offline' }],
      report: reconcile,
      reportSha256: createHash('sha256').update(canonicalJson(reconcile), 'utf8').digest('hex')
    }

    const model = accepted(report, context(report))

    for (const locale of ['en', 'vi', 'zh', 'zh-hant', 'ja']) {
      const confirmation = migrationReportConfirmation(locale, model)
      expect(confirmation.detail).toContain('SOUL.md')
      expect(confirmation.detail).toContain('projects.db')
      expect(confirmation.detail).toContain('state.db')
      expect(confirmation.detail).toContain('offline-mac')
      expect(confirmation.detail).toContain('7')
      expect(confirmation.customize).not.toHaveLength(0)
      expect(migrationChoicePrompt(locale, 'drop', 'kanban.db').title).toContain('kanban.db')
      expect(migrationChoicePrompt(locale, 'takeOther', 'SOUL.md').detail).toContain('SOUL.md')
    }

    expect(migrationReportConfirmation('unknown', model).title).toBe(migrationReportConfirmation('vi', model).title)
    expect(migrationChoicePrompt('unknown', 'drop', 'kanban.db').title).toBe(migrationChoicePrompt('vi', 'drop', 'kanban.db').title)
    expect(migrationReportConfirmation('en', accepted(oneMac)).detail).toContain('Only this Mac supplied a snapshot')
  })
})
