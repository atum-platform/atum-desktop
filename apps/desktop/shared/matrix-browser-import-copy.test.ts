import { describe, expect, it } from 'vitest'

import { DESKTOP_LOCALES } from './desktop-locale'
import { matrixBrowserImportCopy } from './matrix-browser-import-copy'

const locales = [...DESKTOP_LOCALES]

describe('the browser import copy', () => {
  it('speaks every desktop language, with the same words missing in none', () => {
    expect(Object.keys(matrixBrowserImportCopy).sort()).toEqual([...locales].sort())

    const shape = (value: unknown): unknown =>
      typeof value === 'function'
        ? 'formatter'
        : typeof value === 'string'
          ? 'text'
          : Object.fromEntries(Object.entries(value as object).map(([key, entry]) => [key, shape(entry)]))

    for (const locale of locales) {
      expect(shape(matrixBrowserImportCopy[locale]), locale).toEqual(shape(matrixBrowserImportCopy.en))
    }
  })

  it('has real text for every reason and every sentence', () => {
    for (const locale of locales) {
      const words = matrixBrowserImportCopy[locale]

      for (const text of [
        words.title,
        words.rowTitle,
        words.button,
        words.working,
        words.leftOut,
        words.declined,
        ...Object.values(words.reasons)
      ]) {
        expect(text.trim().length, `${locale}: ${text}`).toBeGreaterThan(2)
      }
    }
  })

  it('keeps account wording independent of the selected agent and retains site counts', () => {
    for (const locale of locales) {
      const words = matrixBrowserImportCopy[locale]

      expect(words.imported('Nova', 7), locale).not.toContain('Nova')
      expect(words.imported('Nova', 7), locale).toContain('7')
      expect(words.approvalReason('Nova', 7), locale).not.toContain('Nova')
      expect(words.approvalReason('Nova', 7), locale).toContain('7')
      expect(words.rowHelp('Nova'), locale).not.toContain('Nova')
    }
  })

  it('says one site in the singular in English', () => {
    const { imported, approvalReason } = matrixBrowserImportCopy.en

    expect(imported('Nova', 1)).toBe('Imported 1 site.')
    expect(imported('Nova', 2)).toBe('Imported 2 sites.')
    expect(approvalReason('Nova', 1)).toContain('1 Chrome site')
  })

  it('keeps the Touch ID sheet inside what the Secure Enclave helper accepts, even for the longest name', () => {
    for (const locale of locales) {
      const reason = matrixBrowserImportCopy[locale].approvalReason('N'.repeat(40), 1_000)

      expect(Array.from(reason).length, locale).toBeLessThanOrEqual(600)
    }
  })

  it('tells the person what stays out and that passwords are not sent, wherever it explains the import', () => {
    for (const locale of locales) {
      const words = matrixBrowserImportCopy[locale]

      // Every locale keeps the safety boundary in one line; check the English wording.
      if (locale === 'en') {
        expect(words.approvalReason('Nova', 3)).toMatch(/no passwords or financial sites/u)
        expect(words.tip('Nova')).toMatch(/passwords and financial sites stay out/u)
      }

      expect(words.approvalReason('Nova', 3).length).toBeGreaterThan(20)
    }
  })

  it('never names the internal codenames', () => {
    const serialized = JSON.stringify(
      locales.map(locale => {
        const words = matrixBrowserImportCopy[locale]

        return [
          words.title,
          words.tip('Nova'),
          words.rowHelp('Nova'),
          words.imported('Nova', 2),
          words.approvalReason('Nova', 2),
          words.reasons
        ]
      })
    )

    expect(serialized).not.toMatch(/\b(?:Hermes|Matrix)\b/u)
  })
})
