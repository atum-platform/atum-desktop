import { describe, expect, it } from 'vitest'

import type { CloudTrialOffer } from './cloud-agent'
import { cloudTrialConfirmCopy } from './trial-copy'

const offer: CloudTrialOffer = {
  offerVersion: 1,
  status: 'eligible',
  startableNow: true,
  disclosureVersion: 1,
  durationMs: 604_800_000,
  computeSeconds: 14_400,
  concurrentTasks: 1,
  includedMicroProtons: 200_000_000_000,
  includedStorageBytes: 0
}

describe("main's trial confirmation", () => {
  it('names every grant the offer includes, and storage only when there is some', () => {
    const en = cloudTrialConfirmCopy('en', offer).detail

    expect(en).toContain('7 days')
    expect(en).toContain('4 cloud hours')
    expect(en).toContain('200,000 AI Protons')
    expect(en).toContain('1 concurrent task/assistant')
    expect(en).toContain('no card or renewal')
    expect(en).not.toContain('storage')
    expect(cloudTrialConfirmCopy('en', { ...offer, includedStorageBytes: 1_073_741_824 }).detail).toContain('1 GB storage')
  })

  it('falls back to Vietnamese and covers every locale', () => {
    expect(cloudTrialConfirmCopy(undefined, offer).title).toBe(cloudTrialConfirmCopy('vi', offer).title)

    const perAssistant = {
      en: '1 concurrent task/assistant',
      vi: '1 việc cùng lúc/trợ lý',
      ja: '同時 1 件/アシスタント',
      zh: '每位助手同时 1 个任务',
      'zh-hant': '每位助理同時 1 個工作'
    }
    for (const [locale, phrase] of Object.entries(perAssistant)) {
      const copy = cloudTrialConfirmCopy(locale, offer)
      expect(copy.detail).toMatch(/200[.,]000/)
      expect(copy.detail).toContain(phrase)
      expect(copy.start.length).toBeGreaterThan(0)
    }
  })
})
