import { describe, expect, it } from 'vitest'

import { DESKTOP_LOCALES } from './desktop-locale'
import { matrixAgentStatusText } from './matrix-agent-status-copy'
import type { MatrixTopUpPack } from './matrix-checkout'
import { matrixFundsKind, matrixSuggestedTopUpPack } from './matrix-funds'
import { matrixFundsCopy } from './matrix-funds-copy'

const MICRO = 1_000_000

const pack = (id: string, total: number): MatrixTopUpPack => ({
  id,
  amountVnd: total,
  paidMicroProtons: total * MICRO,
  bonusMicroProtons: 0,
  totalMicroProtons: total * MICRO
})

// The cloud controller's scheduled post today: Vietnamese, no code, the "go to Protons" remedy.
const CONTROLLER_VI =
  'Mình chưa trả lời được vì ví Proton đã hết. Các việc định kỳ cũng tạm dừng. Mở Protons để nạp thêm nhé.'

describe('which agent notices are funds notices', () => {
  it.each([
    ['unfunded', 'out_of_protons'],
    ['trial_expired', 'out_of_protons'],
    ['daily_cap', 'daily_cap']
  ] as const)('reads %s by its code, whatever the body says', (code, kind) => {
    expect(matrixFundsKind({ body: 'anything', notice: true, cloudStatus: { code } })).toBe(kind)
    expect(matrixFundsKind({ body: 'anything', statusLine: { code } })).toBe(kind)
  })

  it('leaves every other code to its own words, even with a funds sentence as body', () => {
    expect(matrixFundsKind({ body: CONTROLLER_VI, notice: true, cloudStatus: { code: 'stopped' } })).toBeUndefined()
    expect(matrixFundsKind({ body: CONTROLLER_VI, notice: true, cloudStatus: { code: 'access_final' } })).toBeUndefined()
  })

  it('recognises the controller’s uncoded scheduled post as a notice or a notifying plain post', () => {
    expect(matrixFundsKind({ body: CONTROLLER_VI, notice: true })).toBe('out_of_protons')
    expect(matrixFundsKind({ body: `  ${CONTROLLER_VI}\n`, scheduled: true })).toBe('out_of_protons')
    expect(
      matrixFundsKind({
        body: 'I can’t answer because your Proton wallet is empty. Scheduled tasks are paused too. Open Protons to top up.',
        notice: true
      })
    ).toBe('out_of_protons')
  })

  it.each(DESKTOP_LOCALES)('recognises Atum’s own older sentences in %s', locale => {
    expect(matrixFundsKind({ body: matrixAgentStatusText('unfunded', locale), notice: true })).toBe('out_of_protons')
    expect(matrixFundsKind({ body: matrixAgentStatusText('daily_cap', locale), scheduled: true })).toBe('daily_cap')
  })

  it('never turns an ordinary message, or a near miss, into a funds line', () => {
    // An answer the agent wrote in its own words, quoting the sentence, is an answer.
    expect(matrixFundsKind({ body: CONTROLLER_VI })).toBeUndefined()
    expect(matrixFundsKind({ body: `${CONTROLLER_VI} Hi`, notice: true })).toBeUndefined()
    expect(matrixFundsKind({ body: 'Out of Protons', notice: true })).toBeUndefined()
  })
})

describe('the pack offered first', () => {
  const packs = [pack('large', 500_000), pack('small', 50_000), pack('mid', 100_000)]

  it('is the smallest pack that covers a known need', () => {
    expect(matrixSuggestedTopUpPack(packs, 60_000)).toBe('mid')
    expect(matrixSuggestedTopUpPack(packs, 50_000)).toBe('small')
    // A fraction of a Proton still needs the next whole Proton.
    expect(matrixSuggestedTopUpPack(packs, 100_000.2)).toBe('large')
  })

  it('is the largest when nothing covers the need, the smallest when there is no need', () => {
    expect(matrixSuggestedTopUpPack(packs, 9_000_000)).toBe('large')
    expect(matrixSuggestedTopUpPack(packs)).toBe('small')
    expect(matrixSuggestedTopUpPack(packs, 0)).toBe('small')
    expect(matrixSuggestedTopUpPack(packs, Number.NaN)).toBe('small')
    expect(matrixSuggestedTopUpPack([], 60_000)).toBeUndefined()
  })
})

describe('the funds words', () => {
  it.each(DESKTOP_LOCALES)('are one short line with no number and one action in %s', locale => {
    const copy = matrixFundsCopy(locale)

    for (const line of [copy.outOfProtons, copy.outOfProtonsPaused, copy.dailyCap, copy.hireShort, copy.renewShort, copy.fundShort]) {
      expect(line).not.toMatch(/\d/)
      expect(line).not.toMatch(/Protons? (page|tab)|Mở Protons|Message the Atum team/i)
      expect([...line].length).toBeLessThanOrEqual(70)
    }

    expect(copy.hirePrice('60,000')).toContain('60,000')
    expect(copy.addProtons).not.toBe('')
  })

  it('differs by locale, so an English reader never gets the Vietnamese line', () => {
    expect(matrixFundsCopy('en').outOfProtons).not.toBe(matrixFundsCopy('vi').outOfProtons)
    expect(matrixFundsCopy('en').hirePrice('60,000')).toBe('60,000 Protons / 30 days')
    expect(matrixFundsCopy('vi').hirePrice('60.000')).toBe('60.000 Proton / 30 ngày')
  })
})
