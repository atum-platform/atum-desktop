import { expect, it } from 'vitest'

import { createBrandCopyScanner } from '../../shared/brand-copy-scan.test-support'
import type { DesktopLocale } from '../../shared/desktop-locale'

import { matrixLaunchConfigurationErrorCopy } from './launch-config'

/**
 * The native main-process half of the Atum branding promise (U13-BRAND), a behavioural sibling of
 * `src/i18n/brand-copy.test.ts`: the words the macOS menu, the free-trial confirmation, the Google
 * write dialog, and the startup refusal show must name Atum, never the internal codenames. Values
 * are produced by calling the modules, not by reading their source. Technical identifiers (the
 * stable `Atum Matrix Candidate` custody folder, wire/IPC ids) stay compatible and are not copy.
 */

const LOCALES: readonly DesktopLocale[] = ['en', 'vi', 'ja', 'zh', 'zh-hant']
const PRODUCT_NAME = /\b(?:Hermes|Matrix)\b/u

const COPY_MODULES: ReadonlyArray<readonly [string, () => Promise<Record<string, unknown>>]> = [
  ['electron/matrix/app-menu-copy', () => import('./app-menu-copy')],
  ['electron/matrix/device/trial-copy', () => import('./device/trial-copy')],
  ['electron/matrix/google-write-copy', () => import('./google-write-copy')]
]

const TRIAL_OFFER = {
  offerVersion: 1,
  status: 'eligible',
  startableNow: true,
  disclosureVersion: 1,
  durationMs: 7 * 86_400_000,
  computeSeconds: 7_200,
  concurrentTasks: 2,
  includedMicroProtons: 5_000_000,
  includedStorageBytes: 10 * 1_073_741_824
}

const scanner = createBrandCopyScanner({
  locales: LOCALES,
  productName: PRODUCT_NAME,
  exceptions: new Map(),
  explicitPlans: {
    'electron/matrix/device/trial-copy::cloudTrialConfirmCopy': LOCALES.flatMap(locale => [[locale, TRIAL_OFFER]])
  }
})

it('keeps Hermes and Matrix out of every native user-visible copy value', async () => {
  const modules = await Promise.all(COPY_MODULES.map(async ([file, load]) => [file, await load()] as const))

  for (const [file, exports] of modules) {
    scanner.scan(file, exports)
  }

  expect(scanner.violations()).toEqual([])
})

it('keeps the native startup refusal Atum-only while the custody folder name stays internal', () => {
  const copy = matrixLaunchConfigurationErrorCopy()
  const words = `${copy.title}\n${copy.message}`

  expect(copy.title).toMatch(/^Atum/u)
  expect(words).not.toMatch(PRODUCT_NAME)
  expect(words).not.toMatch(/candidate/u)
  expect(words).toContain('public-config.json')
})
