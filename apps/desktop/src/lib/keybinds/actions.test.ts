import { describe, expect, it } from 'vitest'

import { en } from '@/i18n/en'
import { ja } from '@/i18n/ja'
import { vi } from '@/i18n/vi'
import { zh } from '@/i18n/zh'
import { zhHant } from '@/i18n/zh-hant'
import { COMPANY_SHORTCUT_SLOTS } from '@/matrix/team-space/company-switcher'

import { COMPANY_SLOT_COUNT, KEYBIND_ACTIONS, keybindAction } from './actions'

const companyActionIds = [
  'nav.companyPrev',
  'nav.companyNext',
  ...Array.from({ length: COMPANY_SLOT_COUNT }, (_, index) => `nav.company.${index + 1}`)
]

describe('the Team Space company shortcuts', () => {
  it('give one action to each company the rail numbers, and to none beyond it', () => {
    expect(COMPANY_SLOT_COUNT).toBe(COMPANY_SHORTCUT_SLOTS)

    for (let slot = 1; slot <= COMPANY_SHORTCUT_SLOTS; slot += 1) {
      expect(keybindAction(`nav.company.${slot}`)?.defaults, `slot ${slot}`).toEqual([`mod+alt+${slot}`])
    }

    expect(keybindAction(`nav.company.${COMPANY_SHORTCUT_SLOTS + 1}`)).toBeUndefined()
    expect(keybindAction('nav.companyPrev')?.defaults).toEqual(['mod+alt+up'])
    expect(keybindAction('nav.companyNext')?.defaults).toEqual(['mod+alt+down'])
  })

  it('collide with no other shortcut: no default combo of theirs is any other action’s default', () => {
    const owners = new Map<string, string[]>()

    for (const action of KEYBIND_ACTIONS) {
      for (const combo of action.defaults) {
        owners.set(combo, [...(owners.get(combo) ?? []), action.id])
      }
    }

    for (const id of companyActionIds) {
      for (const combo of keybindAction(id)!.defaults) {
        expect(owners.get(combo), `${id} ${combo}`).toEqual([id])
      }
    }
  })

  it('are named in every language the window speaks', () => {
    for (const [name, locale] of Object.entries({ en, vi, ja, zh, zhHant })) {
      const labels = locale.keybinds.actions

      for (const id of companyActionIds) {
        expect(labels[id]?.trim().length, `${name} ${id}`).toBeGreaterThan(0)
      }

      expect(new Set(companyActionIds.map(id => labels[id])).size, `${name} labels are distinct`).toBe(companyActionIds.length)
    }
  })
})
