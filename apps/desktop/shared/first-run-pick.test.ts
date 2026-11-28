import { describe, expect, it } from 'vitest'

import { type FirstRunFacts, firstRunPick, firstRunTier, newestInFamily } from './first-run-pick'

const CLAUDE = [
  { id: 'claude-opus-5-5', displayName: 'Opus 5.5' },
  { id: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5' },
  { id: 'claude-sonnet-5', displayName: 'Sonnet 5' },
  { id: 'claude-haiku-5-5', displayName: 'Haiku 5.5' }
]

const CODEX = [
  { id: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol' },
  { id: 'gpt-6.2-sol', displayName: 'GPT-6.2 Sol' },
  { id: 'gpt-6.2-astra', displayName: 'GPT-6.2 Astra' },
  { id: 'gpt-6.2-mini', displayName: 'GPT-6.2 mini' }
]

const GEMINI = [
  { id: 'gemini-4-flash-lite', displayName: 'Gemini 4 Flash Lite' },
  { id: 'gemini-4-flash', displayName: 'Gemini 4 Flash' },
  { id: 'gemini-4.1-flash-preview', displayName: 'Gemini 4.1 Flash Preview' },
  { id: 'gemini-4-pro', displayName: 'Gemini 4 Pro' }
]

const GO = [
  { id: 'deepseek-v4.1-flash', displayName: 'DeepSeek V4.1 Flash' },
  { id: 'deepseek-v4.1-flash-free', displayName: 'DeepSeek V4.1 Flash Free' },
  { id: 'muse-spark-1.3', displayName: 'Muse Spark 1.3' }
]

function facts(overrides: Partial<FirstRunFacts> = {}): FirstRunFacts {
  return { published: true, plans: {}, opencodeGo: { connected: false, models: [] }, ...overrides }
}

describe('first-run pick table', () => {
  it('picks Claude Sonnet first, even when ChatGPT is paid too and Opus is advertised', () => {
    expect(
      firstRunPick(
        facts({
          plans: {
            claude: { connected: true, label: 'Claude Pro', models: CLAUDE },
            codex: { connected: true, label: 'ChatGPT Plus', models: CODEX }
          }
        })
      )
    ).toEqual({ kind: 'plan', plan: 'claude', model: 'claude-sonnet-5-5' })
  })

  it('then ChatGPT Sol, then Antigravity Gemini Flash, then OpenCode Go DeepSeek Flash, then Atum', () => {
    expect(firstRunPick(facts({ plans: { codex: { connected: true, label: 'ChatGPT Pro 200 Subscription', models: CODEX } } }))).toEqual({
      kind: 'plan',
      plan: 'codex',
      model: 'gpt-6.2-sol'
    })
    expect(firstRunPick(facts({ plans: { antigravity: { connected: true, label: 'Google AI Pro', models: GEMINI } } }))).toEqual({
      kind: 'plan',
      plan: 'antigravity',
      model: 'gemini-4-flash'
    })
    expect(firstRunPick(facts({ opencodeGo: { connected: true, models: GO } }))).toEqual({ kind: 'opencode_go', model: 'deepseek-v4.1-flash' })
    expect(firstRunPick(facts())).toEqual({ kind: 'atum' })
  })

  it('never lets a free or unknown plan win chats', () => {
    expect(firstRunPick(facts({ plans: { codex: { connected: true, label: 'ChatGPT Free', models: CODEX } } }))).toEqual({ kind: 'atum' })
    expect(firstRunPick(facts({ plans: { codex: { connected: true, models: CODEX } } }))).toEqual({ kind: 'atum' })
    expect(firstRunPick(facts({ plans: { claude: { connected: true, label: 'Claude Free', models: CLAUDE } } }))).toEqual({ kind: 'atum' })
  })

  it('treats a signed-in Claude plan login as paid (Claude Code needs a paid plan)', () => {
    expect(firstRunTier('claude', undefined)).toBe('paid')
    expect(firstRunTier('codex', undefined)).toBe('unknown')
    expect(firstRunTier('antigravity', 'Free')).toBe('free')
  })

  it('skips a plan the relay does not carry, a stopped plan, or a missing family, and tries the next route', () => {
    const both = { claude: { connected: true, label: 'Claude Max', models: CLAUDE }, codex: { connected: true, label: 'ChatGPT Plus', models: CODEX } }

    expect(firstRunPick(facts({ published: false, plans: both, opencodeGo: { connected: true, models: GO } }))).toEqual({
      kind: 'opencode_go',
      model: 'deepseek-v4.1-flash'
    })
    expect(firstRunPick(facts({ plans: both }), new Set(['claude']))).toEqual({ kind: 'plan', plan: 'codex', model: 'gpt-6.2-sol' })
    expect(
      firstRunPick(facts({ plans: { claude: { connected: true, models: [{ id: 'claude-opus-5-5', displayName: 'Opus' }] }, codex: both.codex } }))
    ).toEqual({ kind: 'plan', plan: 'codex', model: 'gpt-6.2-sol' })
  })

  it('resolves the newest stable model of the family', () => {
    expect(newestInFamily(GEMINI, /gemini.*flash/iu, /lite/iu)).toBe('gemini-4-flash')
    expect(newestInFamily(CLAUDE, /sonnet/iu)).toBe('claude-sonnet-5-5')
  })
})
