import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, test } from 'vitest'

import { MessagingHttpError } from './http-client'
import { AtumMessagingRuntime } from './runtime'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function runtimeWithArtifact(artifact: () => Promise<never>): AtumMessagingRuntime {
  const userDataPath = mkdtempSync(join(tmpdir(), 'atum-artifact-runtime-'))
  directories.push(userDataPath)

  const runtime = new AtumMessagingRuntime({
    userDataPath,
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: value => Buffer.from(value),
      decryptString: value => value.toString()
    }
  })

  ;(runtime as unknown as { http: { artifact: typeof artifact } }).http = { artifact }

  return runtime
}

test('runtime exposes only the stable denied state and strips authority details', async () => {
  const runtime = runtimeWithArtifact(async () => {
    throw new MessagingHttpError('forbidden', 403, false, 'request-1', null, {
      artifact_state: 'denied',
      provider_subject: 'must-not-cross-ipc',
      app_slug: 'must-not-cross-ipc'
    })
  })

  assert.deepEqual(await runtime.artifact('conversation-a', 'andy.receipt:9'), { state: 'denied', artifact: null })
})

test('runtime distinguishes local offline failures from invalid responses', async () => {
  const offline = runtimeWithArtifact(async () => {
    throw new MessagingHttpError('temporarily_unavailable', 0, true, null, null, { message: 'socket failed' })
  })

  const invalid = runtimeWithArtifact(async () => {
    throw new MessagingHttpError('invalid_response', 200, false, null, null, null)
  })

  assert.deepEqual(await offline.artifact('conversation-a', 'moon.laso:42'), { state: 'offline', artifact: null })
  assert.deepEqual(await invalid.artifact('conversation-a', 'moon.laso:42'), { state: 'error', artifact: null })
})

test('runtime preserves unsupported without exposing the provider envelope', async () => {
  const runtime = runtimeWithArtifact(async () => {
    throw new MessagingHttpError('feature_unavailable', 409, false, 'request-2', null, {
      artifact_state: 'unsupported',
      provider_url: 'https://private.test'
    })
  })

  assert.deepEqual(await runtime.artifact('conversation-a', 'future.artifact:1'), {
    state: 'unsupported',
    artifact: null
  })
})
