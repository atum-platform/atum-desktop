import { describe, expect, it } from 'vitest'

import { en } from '@/i18n/en'
import { ja } from '@/i18n/ja'
import { vi } from '@/i18n/vi'
import { zh } from '@/i18n/zh'
import { zhHant } from '@/i18n/zh-hant'

import type {
  AwarenessCitation,
  AwarenessCoverageReason,
  AwarenessCoverageState,
  AwarenessEpistemic,
  AwarenessSourceKind
} from './types'

const sourceKinds: Record<AwarenessSourceKind, true> = {
  assistant_chat: true,
  human_dm: true,
  human_group: true,
  app_exchange: true,
  drive_file: true,
  native_memory: true,
  owner_statement: true
}

const states: Record<AwarenessCoverageState, true> = {
  ready: true,
  catching_up: true,
  partial: true,
  offline: true,
  excluded: true,
  needs_keys: true,
  paused: true,
  error: true
}

const reasons: Record<AwarenessCoverageReason, true> = {
  google_fence: true,
  cloud_access_ended: true,
  owner_paused: true,
  keys_missing: true,
  backfill_pending: true,
  unsupported_media: true,
  service_unavailable: true,
  device_offline: true,
  excluded_by_owner: true,
  temporary_conversation: true
}

const epistemic: Record<AwarenessEpistemic, true> = {
  statement: true,
  question: true,
  quotation: true,
  proposal: true,
  decision: true,
  commitment: true,
  correction: true,
  unknown: true
}

const citationKinds: Record<AwarenessCitation['kind'], true> = {
  matrix_event: true,
  drive_file: true,
  memory: true
}

const catalogs = { en, vi, ja, zh, 'zh-hant': zhHant }

function keys(value: object): string[] {
  return Object.keys(value).sort()
}

function render(value: unknown): string {
  return typeof value === 'function' ? String(value('Sample descriptor')) : String(value)
}

function englishFallbacks(english: unknown, vietnamese: unknown, path = ''): string[] {
  if (english && typeof english === 'object' && !Array.isArray(english)) {
    return Object.keys(english as Record<string, unknown>).flatMap(key =>
      englishFallbacks(
        (english as Record<string, unknown>)[key],
        (vietnamese as Record<string, unknown>)[key],
        path ? `${path}.${key}` : key
      )
    )
  }

  return render(english) === render(vietnamese) ? [path] : []
}

describe('awareness locale contract', () => {
  it.each(Object.entries(catalogs))('%s supplies every awareness key and enum label', (_locale, catalog) => {
    expect(keys(catalog.atum.awareness)).toEqual(keys(en.atum.awareness))
    expect(keys(catalog.atum.awareness.sourceKinds)).toEqual(keys(sourceKinds))
    expect(keys(catalog.atum.awareness.states)).toEqual(keys(states))
    expect(keys(catalog.atum.awareness.reasons)).toEqual(keys(reasons))
    expect(keys(catalog.atum.awareness.epistemic)).toEqual(keys(epistemic))
    expect(keys(catalog.atum.awareness.citationKinds)).toEqual(keys(citationKinds))
  })

  it.each(Object.entries(catalogs))(
    '%s preserves formatter values and distinct empty/unavailable states',
    (_locale, catalog) => {
      const awareness = catalog.atum.awareness

      expect(awareness.noEvidence).not.toBe(awareness.unavailable)
      expect(awareness.noSources).not.toBe(awareness.unavailable)
      expect(awareness.fileVersion('version-7')).toContain('version-7')
      expect(awareness.memoryRevision('42')).toContain('42')
      expect(awareness.previewCitation('sample-source')).toContain('sample-source')
    }
  )

  it.each(['vi', 'ja', 'zh', 'zh-hant'] as const)('does not let %s awareness copy fall back to English', locale => {
    expect(englishFallbacks(en.atum.awareness, catalogs[locale].atum.awareness, 'atum.awareness')).toEqual([])
  })
})
