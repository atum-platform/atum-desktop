import { describe, expect, it } from 'vitest'

import { matrixManagementConfirmationCopy } from './matrix-management-copy'

describe('native selected-agent configuration confirmation', () => {
  it.each(['en', 'vi', 'ja', 'zh', 'zh-hant'])(
    'keeps %s copy useful without projecting upstream errors or credentials',
    locale => {
      const result = matrixManagementConfirmationCopy(locale, 'Named agent', {
        kind: 'expensive-model',
        provider: 'fixture',
        model: 'model-a',
        message: 'upstream error contains fake-secret'
      })

      expect(result.detail).toContain('Named agent')
      expect(result.detail).toContain('fixture')
      expect(result.detail).toContain('model-a')
      expect(JSON.stringify(result)).not.toContain('fake-secret')
      expect(result.title).toBeTruthy()
      expect(result.cancel).not.toBe(result.apply)
    }
  )

  it('uses a fixed safe fallback locale without interpolating endpoint credentials', () => {
    const result = matrixManagementConfirmationCopy('__proto__', 'Owner agent', {
      kind: 'provider-endpoint',
      name: 'local',
      model: 'fixture',
      baseUrl: 'https://user:fake-secret@example.invalid'
    })

    expect(result.title).toBe('Change this agent on this Mac?')
    expect(result.detail).toContain('local')
    expect(result.detail).not.toContain('fake-secret')
  })
})

it.each(['en', 'vi', 'ja', 'zh', 'zh-hant'])(
  'shows pending-plan risk and exact account acknowledgment date in %s',
  locale => {
    const result = matrixManagementConfirmationCopy(locale, 'Named agent', {
      kind: 'provider-oauth',
      provider: 'openai-codex',
      planRisk: { policyVersion: '2026-10-06', acknowledgedAt: '2026-10-07' }
    })

    expect(result.detail).toContain('OpenAI')
    expect(result.detail).toContain('2026-10-06')
    expect(result.detail).toContain('2026-10-07')
    expect(result.cancel).not.toBe(result.apply)
  }
)
