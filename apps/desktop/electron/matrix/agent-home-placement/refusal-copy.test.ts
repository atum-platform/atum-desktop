import { describe, expect, it } from 'vitest'

import { agentHomeCopy } from '../../../src/matrix/agent-home-copy'

import {
  AGENT_HOME_FEATURE_LOSS_CODES,
  AGENT_HOME_MODEL_REFUSAL_REASONS,
  AGENT_HOME_OWNER_REFUSAL_REASONS,
  AGENT_HOME_PREFLIGHT_BLOCK_REASONS
} from './contract-v25'

const LOCALES = ['en', 'vi', 'ja', 'zh', 'zh-hant'] as const

/** Every closed word the platform, or this app, can answer a move or a model change with. */
const REASONS = [
  ...new Set<string>([
    ...AGENT_HOME_OWNER_REFUSAL_REASONS,
    ...AGENT_HOME_PREFLIGHT_BLOCK_REASONS,
    ...AGENT_HOME_MODEL_REFUSAL_REASONS,
    // What the client itself says: a call that did not go through, and what the window may ask that cannot be done.
    'unsupported',
    'unauthorized',
    'forbidden',
    'conflict',
    'invalid',
    'unavailable',
    'already_there',
    'preflight_required',
    'checkpoint_loss_not_accepted',
    'destination_not_current',
    // Setting this Mac up (`target_not_prepared` is this client's own word for a refusal that survived its own enrollment,
    // the pack has none), and a home Mac that is not answering.
    'setup_busy',
    'not_ready',
    'target_not_prepared',
    'current_home_unreachable'
  ])
]

describe('the sheet says every refusal in plain words, in every language', () => {
  it.each(LOCALES)('%s names each closed reason', locale => {
    const copy = agentHomeCopy(locale)

    for (const reason of REASONS) {
      const text = copy.refusals[reason]
      expect(typeof text, `${locale}: ${reason}`).toBe('string')
      expect(text!.trim().length, `${locale}: ${reason}`).toBeGreaterThan(3)
      // Words, not codes: nothing a person would read as a system message.
      expect(text, `${locale}: ${reason}`).not.toMatch(/[a-z]+_[a-z]+/u)
    }
  })

  it('has the same words in every language', () => {
    const english = Object.keys(agentHomeCopy('en').refusals).sort()

    for (const locale of LOCALES) {
      expect(Object.keys(agentHomeCopy(locale).refusals).sort(), locale).toEqual(english)
      expect(Object.keys(agentHomeCopy(locale).losses).sort(), locale).toEqual(Object.keys(agentHomeCopy('en').losses).sort())
    }
  })

  it('names every actual loss the platform can disclose', () => {
    for (const locale of LOCALES) {
      const copy = agentHomeCopy(locale)

      for (const loss of AGENT_HOME_FEATURE_LOSS_CODES) {
        expect(copy.losses[loss], `${locale}: ${loss}`).toBeTruthy()
      }
    }
  })

  it('asks for the acceptance and shows the checkpoint in every language', () => {
    for (const locale of LOCALES) {
      const copy = agentHomeCopy(locale)
      const when = '25 Oct 2026, 20:14'

      expect(copy.acceptCheckpointLoss.length, locale).toBeGreaterThan(10)
      expect(copy.lastCheckpoint(when), locale).toContain(when)
    }
  })

  it('says setting this Mac up, and waiting for a Mac that is not answering, in every language', () => {
    for (const locale of LOCALES) {
      const copy = agentHomeCopy(locale)

      expect(copy.preparing('Mac mini'), locale).toMatch(/Mac mini/u)
      expect(copy.waitingForCurrentMac('Mac mini'), locale).toContain('Mac mini')
      for (const word of [copy.thisMac, copy.preparing('')]) {
        expect(word.trim().length, locale).toBeGreaterThan(2)
      }
    }
  })

  it('says why a set-up could not finish, in every language', () => {
    for (const locale of LOCALES) {
      const copy = agentHomeCopy(locale)

      for (const reason of [
        'connect_model',
        'target_not_prepared',
        'setup_busy',
        'not_ready',
        'unavailable',
        'another_move_in_progress'
      ] as const) {
        expect(copy.refusals[reason], `${locale}: ${reason}`).toBeTruthy()
      }
    }
  })

  it('does not carry a generic list of what stays behind', () => {
    for (const locale of LOCALES) {
      expect(agentHomeCopy(locale), locale).not.toHaveProperty('help')
    }
  })
})
