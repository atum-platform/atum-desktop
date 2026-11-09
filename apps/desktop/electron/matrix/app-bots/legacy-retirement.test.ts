import { expect, it } from 'vitest'

import { canRetireLegacyAppCopy, legacyAppCopyDisposition } from './legacy-retirement'

const ready = {
  botState: 'active' as const,
  officialDmExists: true,
  botJoinedOfficialDm: true,
  consentAccepted: true,
  linkReady: true,
  firstBotAnswerReceived: true
}

it('retires a legacy app copy only after the first successful official-DM answer', () => {
  expect(canRetireLegacyAppCopy(ready)).toBe(true)
  for (const key of Object.keys(ready) as Array<keyof typeof ready>) {
    expect(canRetireLegacyAppCopy({ ...ready, [key]: key === 'botState' ? 'paused' : false } as typeof ready)).toBe(false)
  }
  expect(legacyAppCopyDisposition(['@owner:test', '@app-moon:test'], '@app-moon:test')).toBe('ignored')
  expect(legacyAppCopyDisposition(['@owner:test'], '@app-moon:test')).toBe('eligible')
})
