import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { MAIN_STRINGS, readDisplayLanguage, resolveMainLocale } from './main-i18n'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { force: true, recursive: true })))

function fixture(contents: string, profile?: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atum-main-i18n-'))
  roots.push(root)
  const dir = profile ? path.join(root, 'profiles', profile) : root
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'config.yaml'), contents)

  return root
}

describe('main-process localization', () => {
  it('reads display.language without mistaking another language key for it', () => {
    const root = fixture('stt:\n  language: en\ndisplay:\n  theme: dark\n  language: vi-VN\nagent:\n  model: x\n')
    expect(readDisplayLanguage(path.join(root, 'config.yaml'))).toBe('vi-VN')
    expect(resolveMainLocale(root)).toBe('vi')
  })

  it('uses the selected profile and defaults fresh Atum installs to Vietnamese', () => {
    const root = fixture('display:\n  language: en\n', 'work')
    expect(resolveMainLocale(root, 'work')).toBe('en')
    fs.writeFileSync(path.join(root, 'active_profile'), 'work\n')
    expect(resolveMainLocale(root)).toBe('en')
    expect(resolveMainLocale(path.join(root, 'missing'))).toBe('vi')
  })

  it('contains no user-facing Hermes noun in either locale', () => {
    expect(JSON.stringify(MAIN_STRINGS)).not.toMatch(/Hermes/i)
  })
})
