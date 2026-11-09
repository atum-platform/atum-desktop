import { describe, expect, it } from 'vitest'

import {
  matrixPagesArchiveCopy,
  matrixPagesInstallCopy,
  matrixPagesScanCopy,
  matrixPagesUpdateCopy
} from './matrix-pages-copy'

describe('native Skills Hub confirmations', () => {
  it.each(['en', 'vi', 'ja', 'zh', 'zh-hant'])('names the agent and source in separate %s operation copy', locale => {
    const scan = matrixPagesScanCopy(locale)
    const install = matrixPagesInstallCopy(locale)
    expect(scan.title).not.toBe(install.title)
    expect(scan.scan).toBeTruthy()
    expect(scan.cancel).toBe(install.cancel)
    expect(scan.detail('Analyst', 'fixture/demo')).toContain('Analyst')
    expect(scan.detail('Analyst', 'fixture/demo')).toContain('fixture/demo')
  })

  it('explains the advisory isolated fetch and safely falls back for an unknown locale', () => {
    const copy = matrixPagesScanCopy('__proto__')
    expect(copy).toEqual(matrixPagesScanCopy('en'))
    expect(copy.detail('Analyst', 'fixture/demo')).toContain('does not install or run')
    expect(copy.detail('Analyst', 'fixture/demo')).toContain('not a guarantee of safety')
  })
})

describe('safe update confirmation copy', () => {
  it.each(['en', 'vi', 'ja', 'zh', 'zh-hant'])('names the selected agent and exact single skill in %s', locale => {
    const single = matrixPagesUpdateCopy(locale)
    const all = matrixPagesUpdateCopy(locale, true)
    expect(single.detail('Selected Agent', 'installed-demo')).toContain('Selected Agent')
    expect(single.detail('Selected Agent', 'installed-demo')).toContain('installed-demo')
    expect(all.detail('Selected Agent', 'all')).toContain('Selected Agent')
    expect(all.title).not.toBe(single.title)
    expect(single.cancel).toBe(matrixPagesInstallCopy(locale).cancel)
    expect(all.update).toBeTruthy()
  })

  it('explains rollback retention, new-conversation freshness, and honest partial batch results', () => {
    const fallback = matrixPagesUpdateCopy('__proto__')
    const english = matrixPagesUpdateCopy('en')
    expect(fallback.title).toBe(english.title)
    expect(fallback.detail('Agent', 'demo')).toBe(english.detail('Agent', 'demo'))
    expect(matrixPagesUpdateCopy('en').detail('Agent', 'demo')).toContain('kept for rollback')
    expect(matrixPagesUpdateCopy('en').detail('Agent', 'demo')).toContain('new conversation')
    expect(matrixPagesUpdateCopy('en', true).detail('Agent', 'all')).toContain('incomplete updates will be reported')
  })
})

describe('archive confirmation copy', () => {
  it.each(['en', 'vi', 'ja', 'zh', 'zh-hant'])(
    'identifies the selected agent and the installed skill in %s',
    locale => {
      const copy = matrixPagesArchiveCopy(locale)
      expect(copy.archive).toBeTruthy()
      expect(copy.cancel).toBe(matrixPagesInstallCopy(locale).cancel)
      expect(copy.detail('Selected Agent', 'installed-fixture')).toContain('Selected Agent')
      expect(copy.detail('Selected Agent', 'installed-fixture')).toContain('installed-fixture')
    }
  )
  it('explains retained files and session freshness, with safe fallback', () => {
    const copy = matrixPagesArchiveCopy('__proto__')
    expect(copy).toEqual(matrixPagesArchiveCopy('en'))
    expect(copy.detail('Agent', 'demo')).toContain('kept in the local archive')
    expect(copy.detail('Agent', 'demo')).toContain('until a new session')
  })
})
