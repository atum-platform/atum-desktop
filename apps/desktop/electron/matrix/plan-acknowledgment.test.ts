import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, expect, it } from 'vitest'

import { forgetMatrixAccountCodex, matrixAccountCodexScope } from './hermes-runtime'
import { readMatrixPlanAcknowledgment, saveMatrixPlanAcknowledgment } from './plan-acknowledgment'

const roots: string[] = []
const acknowledgment = { provider: 'openai-codex', policyVersion: '2026-10-06', acknowledgedAt: '2026-10-07' }
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))

function fixture() {
  const profiles = mkdtempSync(path.join(os.tmpdir(), 'atum-plan-consent-'))
  roots.push(profiles)

  return { profiles }
}

it('persists exact dates atomically in a private native account folder, never a global store', () => {
  const config = fixture()
  expect(readMatrixPlanAcknowledgment(config, 'owner-a', acknowledgment.provider)).toBeUndefined()
  saveMatrixPlanAcknowledgment(config, 'owner-a', acknowledgment)
  expect(readMatrixPlanAcknowledgment(config, 'owner-a', acknowledgment.provider)).toEqual(acknowledgment)
  expect(readMatrixPlanAcknowledgment(config, 'owner-b', acknowledgment.provider)).toBeUndefined()
  const directory = path.dirname(matrixAccountCodexScope(config, 'owner-a').authDir)
  expect(statSync(directory).mode & 0o777).toBe(0o700)
  expect(readdirSync(directory)).toEqual(['plan-acknowledgment.json'])
  expect(statSync(path.join(directory, 'plan-acknowledgment.json')).mode & 0o777).toBe(0o600)
  saveMatrixPlanAcknowledgment(config, 'owner-a', { ...acknowledgment, acknowledgedAt: '2026-10-08' })
  expect(readMatrixPlanAcknowledgment(config, 'owner-a', acknowledgment.provider)?.acknowledgedAt).toBe('2026-10-08')
  expect(readdirSync(directory)).toEqual(['plan-acknowledgment.json'])
  forgetMatrixAccountCodex(config, 'owner-a')
  expect(readMatrixPlanAcknowledgment(config, 'owner-a', acknowledgment.provider)).toBeUndefined()
})

it('cannot reuse a copied acknowledgment from another account and refuses malformed storage', () => {
  const config = fixture()
  saveMatrixPlanAcknowledgment(config, 'owner-a', acknowledgment)
  const from = path.join(path.dirname(matrixAccountCodexScope(config, 'owner-a').authDir), 'plan-acknowledgment.json')
  const other = path.dirname(matrixAccountCodexScope(config, 'owner-b').authDir)
  mkdirSync(other, { recursive: true })
  const to = path.join(other, 'plan-acknowledgment.json')
  writeFileSync(to, readFileSync(from))
  expect(readMatrixPlanAcknowledgment(config, 'owner-b', acknowledgment.provider)).toBeUndefined()
  writeFileSync(to, '{broken')
  expect(() => readMatrixPlanAcknowledgment(config, 'owner-b', acknowledgment.provider)).toThrow(
    'provider_terms_blocked'
  )
})

it('makes a pre-existing permissive account folder private before saving consent', () => {
  const config = fixture()
  const directory = path.dirname(matrixAccountCodexScope(config, 'owner-a').authDir)
  mkdirSync(directory, { recursive: true, mode: 0o755 })
  chmodSync(directory, 0o755)
  saveMatrixPlanAcknowledgment(config, 'owner-a', acknowledgment)
  expect(statSync(directory).mode & 0o777).toBe(0o700)
  expect(readMatrixPlanAcknowledgment(config, 'owner-a', acknowledgment.provider)).toEqual(acknowledgment)
})

it('refuses a storage collision without replacing the prior account record or leaving staging files', () => {
  const config = fixture()
  const directory = path.dirname(matrixAccountCodexScope(config, 'owner-a').authDir)
  mkdirSync(path.join(directory, 'plan-acknowledgment.json'), { recursive: true })
  expect(() => saveMatrixPlanAcknowledgment(config, 'owner-a', acknowledgment)).toThrow('provider_terms_blocked')
  expect(readdirSync(directory)).toEqual(['plan-acknowledgment.json'])
  chmodSync(directory, 0o700)
})
