import { expect, it } from 'vitest'

import { questionAnswers } from './question'

it('matches comma-bearing labels intact and takes numbered or line-separated choices', () => {
  const question = { id: 'colors', question: 'Which colors?', multiSelect: true, allowCustomAnswer: false,
    options: [{ label: ' Blue, light ', value: 'blue' }, { label: 'Green' }] }

  expect(questionAnswers(question, ' blue, LIGHT ')).toEqual({ colors: ['blue'] })
  expect(questionAnswers(question, ' Blue, light\n green ')).toEqual({ colors: ['blue', 'Green'] })
  expect(questionAnswers(question, '1, 2')).toEqual({ colors: ['blue', 'Green'] })
  expect(questionAnswers(question, 'Orange')).toBeUndefined()
})
