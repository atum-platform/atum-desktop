import { expect, it } from 'vitest'

import { matrixDriveCopy } from './drive-copy'

const locales = ['en', 'vi', 'ja', 'zh', 'zh-hant'] as const
const issueCodes = ['drive_full', 'conflicts', 'errors', 'excluded', 'signed_out'] as const

it('keeps Drive facts complete and ready for renderer interpolation in every locale', () => {
  for (const locale of locales) {
    const facts = matrixDriveCopy[locale].facts

    expect(facts.storageLabel.trim()).not.toBe('')
    expect(facts.storage).toContain('{used}')
    expect(facts.storage).toContain('{total}')
    expect(facts.progress).toContain('{done}')
    expect(facts.progress).toContain('{total}')
    expect(facts.progressOne).toContain('{done}')
    expect(facts.progressOne).toContain('{total}')
    expect(facts.issueOne.trim()).not.toBe('')
    expect(facts.aboutMinutes).toContain('{count}')
    expect(facts.aboutHours).toContain('{count}')
    expect(facts.underMinute.trim()).not.toBe('')
    expect(facts.aboutMinute.trim()).not.toBe('')
    expect(facts.aboutHour.trim()).not.toBe('')
    expect(facts.staleStatus.trim()).not.toBe('')
    expect(facts.stale.trim()).not.toBe('')
    expect(facts.lowSpace.trim()).not.toBe('')
    expect(facts.issueCount).toContain('{count}')
    expect(facts.skipped.many).toContain('{count}')
    expect(facts.skipped.one.trim()).not.toBe('')

    for (const code of issueCodes) {
      expect(facts.issues[code].title.trim()).not.toBe('')
      expect(facts.issues[code].body.trim()).not.toBe('')
    }
  }
})

it('uses direct, honest English issue language without unsupported recovery promises', () => {
  const englishFacts = matrixDriveCopy.en.facts

  const words = Object.values(englishFacts.issues)
    .flatMap(issue => [issue.title, issue.body])
    .join(' ')
    .toLowerCase()

  expect(englishFacts.lowSpace).toMatch(/low on space/i)
  expect(words).toContain('open your drive folder')
  expect(words).toContain('drive needs to reconnect')
  expect(words).toContain('try again')
  expect(words).not.toContain('sign in again')

  for (const unsupported of ['7 days', 'trash', 'restore', 'keep both', 'retained', 'rejected', 'native', 'bridge']) {
    expect(words).not.toContain(unsupported)
  }
})
