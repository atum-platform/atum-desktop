import { describe, expect, it } from 'vitest'

import { matrixActionCopy } from './matrix-action-copy'

// The assistant's status and consent words are product copy, so the contract is about what a
// person reads, not the exact sentences: they are free to be reworded.
const STATUS_AND_CONSENT = [
  'listenHermes',
  'keepListeningHermes',
  'listening',
  'listeningStopped',
  'continuousListening',
  'continuousListeningPaused',
  'listeningPausedStorage'
] as const

const PROMPT_CARD = [
  'approvalTitle',
  'approvalAsk',
  'approvalAllow',
  'approvalDecline',
  'promptDeadlineSoon',
  'secretTitle',
  'secretAsk',
  'sudoAsk'
] as const

describe('the assistant status words', () => {
  it('never call an assistant "listening" in English or Vietnamese (to a person that is the microphone)', () => {
    for (const locale of ['en', 'vi'] as const) {
      for (const key of STATUS_AND_CONSENT) {
        expect(matrixActionCopy[locale][key], `${locale}.${key}`).not.toMatch(/listen|lắng nghe/iu)
      }
    }
  })

  it('stays a sentence in every locale: no empty word and no leftover placeholder', () => {
    for (const [locale, copy] of Object.entries(matrixActionCopy)) {
      for (const key of [...STATUS_AND_CONSENT, ...PROMPT_CARD, 'promptDetails'] as const) {
        const words = (copy as Record<string, string>)[key]

        expect(words?.trim(), `${locale}.${key}`).toBeTruthy()
        expect(words, `${locale}.${key}`).not.toMatch(/[{}]/u)
      }
    }
  })

  it('keeps every locale on the same keys', () => {
    const keys = Object.keys(matrixActionCopy.en).sort()

    for (const [locale, copy] of Object.entries(matrixActionCopy)) {
      expect(Object.keys(copy).sort(), locale).toEqual(keys)
    }
  })
})

describe('the prompt card words', () => {
  it('ask in plain words, with no command, variable or privilege jargon, in English and Vietnamese', () => {
    for (const locale of ['en', 'vi'] as const) {
      for (const key of PROMPT_CARD) {
        expect(matrixActionCopy[locale][key], `${locale}.${key}`).not.toMatch(
          /sudo|privilege|credential|env(ironment)?\b|command|terminal|lệnh|biến môi trường/iu
        )
      }
    }
  })
})
