import { expect, it } from 'vitest'

import { groupTypedMentions } from './group-assistants'
import { groupRecipientChoice } from './group-room-policy'

const recipients = [
  { userId: '@mochi:test', name: 'Mochi' },
  { userId: '@mochi-long:test', name: 'Mochi Long' },
  { userId: '@bailey:test', name: 'Bailey' },
  { userId: '@unicode:test', name: 'Trợ lý' },
  { userId: '@zh:test', name: '小白' }
]

it('names the longest literal own names in message order, once each', () => {
  expect(groupTypedMentions('@Mochi Long, @Bailey and @Mochi; @Bailey', recipients)).toEqual([
    '@mochi-long:test',
    '@bailey:test',
    '@mochi:test'
  ])
})

it('handles Unicode normalization and boundaries without treating email or partial names as intent', () => {
  expect(groupTypedMentions('hi@Mochi @Mochiness @小白猫 @小白！ @Trợ lý'.normalize('NFD'), recipients)).toEqual([
    '@zh:test',
    '@unicode:test'
  ])
})

it('does not infer a recipient for duplicate display names or unjoined/foreign assistants', () => {
  expect(groupTypedMentions('@Mochi @Foreign', [...recipients, { userId: '@duplicate:test', name: 'Mochi' }])).toEqual(
    []
  )
})

it('escapes punctuation in literal names', () => {
  expect(groupTypedMentions('@A+B (ask)', [{ userId: '@one:test', name: 'A+B' }])).toEqual(['@one:test'])
})

it('does not reinterpret an ambiguous long name as an unambiguous shorter name', () => {
  expect(
    groupTypedMentions('@Mochi Long and @Mochi', [...recipients, { userId: '@duplicate:test', name: 'Mochi Long' }])
  ).toEqual(['@mochi:test'])
})

it('remembers cosmetic recipient choices independently for each viewer and room', () => {
  localStorage.clear()
  groupRecipientChoice('@one:test', '!room:test').write('agent:mochi')
  expect(groupRecipientChoice('@one:test', '!room:test').read()).toBe('agent:mochi')
  expect(groupRecipientChoice('@two:test', '!room:test').read()).toBe('')
  expect(groupRecipientChoice('@one:test', '!other:test').read()).toBe('')
})
