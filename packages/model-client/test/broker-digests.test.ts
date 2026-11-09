import { expect, it } from 'vitest'

import { promptDigests } from '../src/model-broker'

const tools = [{ type: 'function', function: { name: 'terminal', parameters: { type: 'object', properties: { timeout: { type: 'number', minimum: 0.5 } } } } }]
const body = (system: unknown, list: unknown[] = tools) => ({ model: 'default', messages: [{ role: 'system', content: system }, { role: 'user', content: 'hi' }], tools: list })

it('records the same digests for the same tool list and system prompt, whatever the key order or the turn', () => {
  const a = promptDigests(body('You are T.'))
  const reordered = [{ function: { parameters: { properties: { timeout: { minimum: 0.5, type: 'number' } }, type: 'object' }, name: 'terminal' }, type: 'function' }]
  const b = promptDigests({ ...body('You are T.', reordered), messages: [{ role: 'system', content: 'You are T.' }, { role: 'user', content: 'a different question' }] })
  expect(b).toEqual(a)
  expect(a.toolsDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
})

it('changes when the tools or the system prompt change, and treats a missing system message as empty', () => {
  const a = promptDigests(body('You are T.'))
  expect(promptDigests(body('You are T. Today is Monday.')).systemDigest).not.toBe(a.systemDigest)
  expect(promptDigests(body('You are T.', [])).toolsDigest).not.toBe(a.toolsDigest)
  expect(promptDigests({ messages: [{ role: 'user', content: 'hi' }] }).systemDigest).toBe(promptDigests(body('')).systemDigest)
})
