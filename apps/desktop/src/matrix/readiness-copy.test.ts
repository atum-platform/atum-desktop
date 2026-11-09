import { expect, it } from 'vitest'

import { en } from '@/i18n/en'
import { ja } from '@/i18n/ja'
import { vi } from '@/i18n/vi'
import { zh } from '@/i18n/zh'
import { zhHant } from '@/i18n/zh-hant'

import type { MatrixReadiness } from '../../shared/matrix'

import { matrixLaunchCopy } from './launch-copy'
import { matrixReadinessCopy, matrixSetupCooldown } from './readiness-copy'

it('explains the native setup deadline in every locale without an ineffective retry action', () => {
  const retryAt = Date.UTC(2026, 9, 3)
  const readiness: MatrixReadiness = { phase: 'starting', step: 'assistant', code: 'rate_limited', since: 1, retryAt }

  for (const [locale, catalog] of Object.entries({ en, vi, ja, zh, 'zh-hant': zhHant })) {
    const result = matrixReadinessCopy(readiness, undefined, catalog.matrixShell, 'Opening', locale)
    expect(result.title).toBe(catalog.matrixShell.readinessSetupWaiting)
    expect(result.help).toContain(
      new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(retryAt)
    )
    expect(result.help).toContain(catalog.matrixShell.readinessSetupWaitingHelp)
    expect(result.action).toBeUndefined()
    expect(result.title).not.toContain('rate_limited')
  }
})

it('requires the specific setup step and a valid native deadline before projecting a cooldown', () => {
  const readiness: MatrixReadiness = {
    phase: 'starting',
    step: 'assistant',
    code: 'rate_limited',
    since: 1,
    retryAt: 60_000
  }

  expect(matrixSetupCooldown(readiness)).toBe(60_000)
  expect(matrixSetupCooldown(undefined)).toBeUndefined()

  for (const retryAt of [undefined, NaN, Infinity, -1, 0, 0.5, 8_640_000_000_000_001]) {
    expect(matrixSetupCooldown({ ...readiness, retryAt })).toBeUndefined()
  }

  for (const other of [{ step: 'hermes' }, { code: 'offline' }, { phase: 'ready' }, { phase: 'blocked' }]) {
    expect(matrixSetupCooldown({ ...readiness, ...other } as MatrixReadiness)).toBeUndefined()
  }
})

const blocked = (code: string): MatrixReadiness => ({ phase: 'blocked', step: 'hermes', code, since: 1 })
const copy = (code: string, shell = en.matrixShell) => matrixReadinessCopy(blocked(code), undefined, shell, 'Opening')

it('explains withdrawn execution permission in every locale without pretending reconnect can restore it', () => {
  for (const catalog of [en, vi, ja, zh, zhHant]) {
    const result = copy('authority_withdrawn', catalog.matrixShell)
    expect(result).toEqual({
      title: catalog.matrixShell.readinessAuthorityWithdrawn,
      help: catalog.matrixShell.readinessAuthorityWithdrawnHelp
    })
    expect(result.action).toBeUndefined()
    expect(result.title).not.toContain('authority_withdrawn')
  }
})

it('asks for a fresh install, not a retry that cannot help, when the bundled runtime is missing or damaged', () => {
  for (const code of ['runtime_invalid', 'runtime_unavailable']) {
    expect(copy(code).title).toBe(en.matrixShell.readinessRuntime)
    expect(copy(code, vi.matrixShell).title).toBe(vi.matrixShell.readinessRuntime)
    expect(copy(code).action).toBe('download')
  }

  expect(en.matrixShell.readinessRuntime).not.toBe(en.matrixShell.readinessAssistant)
})

it('uses the launch’s plainer words, with their help line, wherever a caller has them', () => {
  for (const [locale, catalog] of Object.entries({ en, vi, ja, zh, 'zh-hant': zhHant })) {
    const words = matrixLaunchCopy(locale as 'en')
    const shell = { ...catalog.matrixShell, ...words }
    const ai = matrixReadinessCopy(blocked('ai_unavailable'), undefined, shell, 'Opening')
    expect(ai).toEqual({ title: words.aiDownTitle, help: words.aiDownHelp, action: 'retry' })
    const runtime = matrixReadinessCopy(blocked('runtime_invalid'), undefined, shell, 'Opening')
    expect(runtime).toEqual({ title: words.runtimeTitle, help: words.runtimeHelp, action: 'download' })
    const trust = matrixReadinessCopy(blocked('agent_trust_failed'), undefined, shell, 'Opening')
    expect(trust).toEqual({ title: words.trustTitle, help: words.trustHelp, action: 'retry' })

    // Signed out: a short title, and the catalog's sentence becomes its help line.
    for (const code of ['sign_in_required', 'signed_out']) {
      const signedOut = matrixReadinessCopy(blocked(code), undefined, shell, 'Opening')
      expect(signedOut).toEqual({
        title: words.signedOutTitle,
        help: catalog.matrixShell.readinessSignIn,
        action: 'sign_in'
      })
    }
  }
})

it('asks to sign in again, with a sign-in action rather than a retry, when the account is gone', () => {
  for (const code of ['sign_in_required', 'signed_out']) {
    expect(copy(code)).toEqual({ title: en.matrixShell.readinessSignIn, action: 'sign_in' })
  }
})

it("blames Atum's servers, not this Mac, when the assistant list cannot load", () => {
  expect(copy('agent_roster_unavailable').title).toBe(en.matrixShell.readinessPlatform)
})

it('tells a person whose setup stopped that trying again resumes it', () => {
  const result = matrixReadinessCopy(
    blocked('setup_failed'),
    { step: 'assistant', state: 'failed' },
    en.matrixShell,
    'Opening'
  )

  expect(result.action).toBe('retry')
  expect(result.help).toBe(en.matrixShell.startupFailedHelp)
  expect(result.help).toMatch(/where it stopped/)
})

it('never shows a raw code, even for one it has no words for', () => {
  const result = copy('something_new')

  expect(result.title).toBe(en.matrixShell.readinessAssistant)
  expect(result.title).not.toContain('something_new')
})

it('explains running out of Protons and points at the purchase information', () => {
  const result = copy('out_of_protons')

  expect(result.title).toBe(en.matrixShell.readinessOutOfProtons)
  expect(result.help).toBe(en.matrixShell.readinessOutOfProtonsHelp)
  expect(result.action).toBe('top_up')
})

it('replaces a damaged agent device or a withdrawn executor with one Reconnect, in every locale', () => {
  for (const [locale, catalog] of Object.entries({ en, vi, ja, zh, 'zh-hant': zhHant })) {
    const shell = { ...catalog.matrixShell, ...matrixLaunchCopy(locale as 'en') }

    // Being replaced: progress, nothing to press.
    expect(copy('agent_reconnecting', shell)).toEqual({ title: shell.reconnectingTitle, help: shell.reconnectingHelp })
    expect(copy('agent_reconnect_required', shell)).toEqual({
      title: shell.reconnectTitle,
      help: shell.reconnectHelp,
      action: 'reconnect'
    })
    // Withdrawn by the platform is no longer a dead end: the platform still decides.
    expect(copy('authority_withdrawn', shell)).toEqual({
      title: catalog.matrixShell.readinessAuthorityWithdrawn,
      help: shell.withdrawnHelp,
      action: 'reconnect'
    })
    // This Mac's own device lost its keys: a new sign-in, the kept key unlocks it.
    expect(copy('device_replaced', shell)).toEqual({
      title: shell.deviceDamagedTitle,
      help: shell.deviceDamagedHelp,
      action: 'sign_in_again'
    })

    for (const code of ['agent_reconnecting', 'agent_reconnect_required', 'device_replaced']) {
      expect(JSON.stringify(copy(code, shell))).not.toContain(code)
    }
  }

  expect(copy('agent_reconnect_required', { ...vi.matrixShell, ...matrixLaunchCopy('vi') }).title).toBe(
    'Trợ lý cần kết nối lại trên Mac này'
  )
})

it('asks for a usable ChatGPT connection in every locale without inventing an expiry reason', () => {
  for (const locale of ['en', 'vi', 'ja', 'zh', 'zh-hant'] as const) {
    const catalog = { en, vi, ja, zh, 'zh-hant': zhHant }[locale]
    const words = matrixLaunchCopy(locale)
    const result = copy('plan_sign_in', { ...catalog.matrixShell, ...words })

    expect(result).toEqual({ title: words.planSignInTitle, help: words.planSignInHelp, action: 'plan_sign_in' })
    expect(result.title).toContain('ChatGPT')
    expect(result.title).not.toBe(copy('setup_failed', { ...catalog.matrixShell, ...words }).title)
  }

  // Without the launch words (an older caller): still a sign-in, never Try again.
  expect(copy('plan_sign_in').action).toBe('plan_sign_in')
})

// 0.19.4: a hire whose identity was never made (its purchase failed) showed "couldn't finish a
// security check". It is still being set up, and the words say only that.
it('says an agent still being set up in plain words, in every locale, never the security wording', () => {
  const jargon: Record<string, RegExp> = {
    en: /security|verif|device|key/i,
    vi: /bảo mật|xác minh|thiết bị|khóa/i,
    ja: /セキュリティ|確認|デバイス|キー|鍵/,
    zh: /安全|验证|设备|密钥/,
    'zh-hant': /安全|驗證|裝置|金鑰/
  }

  for (const locale of ['en', 'vi', 'ja', 'zh', 'zh-hant'] as const) {
    const catalog = { en, vi, ja, zh, 'zh-hant': zhHant }[locale]
    const words = matrixLaunchCopy(locale)
    const shell = { ...catalog.matrixShell, ...words }
    const result = copy('agent_initializing', shell)

    expect(result).toEqual({ title: words.initializingTitle, help: words.initializingHelp, action: 'retry' })
    expect(result.title).not.toBe(copy('agent_trust_failed', shell).title)
    expect(`${result.title} ${result.help}`).not.toMatch(jargon[locale]!)
  }

  expect(copy('agent_initializing', { ...vi.matrixShell, ...matrixLaunchCopy('vi') }).title).toBe(
    'Trợ lý vẫn đang được thiết lập'
  )
  // Without the launch words (an older caller): the step's own "waking your assistant".
  expect(copy('agent_initializing').title).toBe(en.matrixShell.startupAssistant)
})
