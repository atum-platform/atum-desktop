import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { makeSession, updateSession } from '@sentry/core'
import { expect, test } from 'vitest'

import { ReportingSessionJournal } from './reporting-session-journal'

test.each(['atum-desktop', 'atum-matrix-desktop'])('%s quit and crash state survive process lifetime and settle the original session exactly once', composition => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atum-session-journal-'))

  try {
    for (const status of ['exited', 'crashed', 'ok'] as const) {
      const file = path.join(dir, 'session.json')
      const journal = new ReportingSessionJournal(file, 'a'.repeat(32), 'test')
      const session = makeSession({ release: `${composition}@0.17.0+${'b'.repeat(40)}`, environment: 'test' })
      updateSession(session, { status, errors: status === 'crashed' ? 1 : 0 })
      journal.write(session, status === 'crashed' ? { operation: 'main', kind: 'TypeError', frames: [{ filename: 'app:///electron-main.mjs', lineno: 42, colno: 1, in_app: true }] } : undefined)
      const recovered = new ReportingSessionJournal(file, 'a'.repeat(32), 'test').take()!
      expect(recovered.session.sid).toBe(session.sid)
      expect(recovered.session.release).toBe(session.release)
      expect(recovered.session.init).toBe(false)
      expect(recovered.session.status).toBe(status === 'ok' ? 'abnormal' : status)

      if (status === 'crashed') {expect(recovered.crash?.frames[0].filename).toBe('app:///electron-main.mjs')}
      expect(journal.take()).toBeNull()
    }
  } finally {fs.rmSync(dir, { recursive: true, force: true })}
})

test('opt-out removes the lifecycle marker; malformed or cross-project records are discarded', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atum-session-journal-'))

  try {
    const file = path.join(dir, 'session.json')
    const journal = new ReportingSessionJournal(file, 'a'.repeat(32), 'test')
    journal.write(makeSession({ release: `atum-desktop@0.17.0+${'b'.repeat(40)}` }))
    journal.clear()
    expect(journal.take()).toBeNull()
    fs.writeFileSync(file, '{torn')
    expect(journal.take()).toBeNull()
    expect(fs.existsSync(file)).toBe(false)
    journal.write(makeSession({ release: `atum-desktop@0.17.0+${'b'.repeat(40)}` }))
    expect(new ReportingSessionJournal(file, 'a'.repeat(32), 'production').take()).toBeNull()
  } finally {fs.rmSync(dir, { recursive: true, force: true })}
})
