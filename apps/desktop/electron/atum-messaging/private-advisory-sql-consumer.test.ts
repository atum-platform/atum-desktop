import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { test, vi } from 'vitest'

import { AtumMessagingHttpClient } from './http-client'

const here = dirname(fileURLToPath(import.meta.url))
const platformRoot = process.env.ATUM_PLATFORM_ROOT ?? resolve(here, '../../../../../atum-platform-advisory')
const protocolEntry = resolve(platformRoot, 'packages/protocol/dist/esm/index.js')

type RawPreflight = Record<string, unknown> & {
  context: Record<string, unknown>
  target: Record<string, unknown>
  request: { message_id: string }
}

const fixture = JSON.parse(
  readFileSync(resolve(here, 'fixtures/private-advisory-sql-0096/captured.json'), 'utf8')
) as {
  fixture_version: number
  provenance: { migration_sha256: string; source_test_sha256: string }
  preflight: RawPreflight
  specialist_preflight: RawPreflight
  specialist_context: Record<string, unknown>
  owner_context: Record<string, unknown> & { watermark: { message_id: string } }
}

const integration = existsSync(protocolEntry) ? test : test.skip

integration('the captured specialist SQL projection passes the real platform protocol parser', async () => {
  const protocol = (await import(pathToFileURL(protocolEntry).href)) as {
    parseTurnAdvisoryRequest(value: unknown): unknown
  }

  const preflight = fixture.specialist_preflight
  const context = fixture.specialist_context

  assert.equal(fixture.fixture_version, 1)
  assert.equal(fixture.provenance.migration_sha256.length, 64)
  assert.equal(fixture.provenance.source_test_sha256.length, 64)

  const protocolRequest = protocol.parseTurnAdvisoryRequest({
    // These fields are supplied by dispatch around the raw SQL projection.
    profile: 'atum.turn-advisory/1',
    turn_id: preflight.turn_id,
    conversation_id: preflight.conversation_id,
    subject: preflight.subject,
    request: preflight.request,
    round: preflight.round,
    context: {
      channel: 'atum',
      client: 'desktop',
      mode: 'private_advisory',
      audience_revision: preflight.audience_revision,
      advisor: context.advisor,
      context_revision: context.context_revision,
      invalidations: context.invalidations,
      messages: context.messages,
      watermark: context.watermark,
      capabilities: { version: 1, enabled: [] }
    }
  }) as { context: { advisor: { id: string }; messages: Array<{ speaker: { kind: string }; text: string }> } }

  const boundedReply = protocolRequest.context.messages.find(message => message.speaker.kind === 'specialist')
  assert.equal(protocolRequest.context.advisor.id, preflight.target.id)
  assert.equal(protocolRequest.context.messages.length, 2)
  assert.equal(Array.from(boundedReply?.text ?? '').length, 20_000)
  assert.equal(boundedReply?.text.endsWith('\n[truncated]'), true)
})

test('captured SQL preflight passes the actual desktop transport in every checkout', async () => {
  const preflight = fixture.preflight

  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const url = String(input)
    const body = url.endsWith('/preflight') ? { request: preflight } : { context: fixture.owner_context }

    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
  })

  const client = new AtumMessagingHttpClient(
    {
      current: () => ({
        baseUrl: 'https://atum.test',
        user: { id: '00000000-0000-4000-8000-361b0805d8f7', displayName: null, handle: null },
        tokens: { accessToken: 'fixture-token', refreshToken: null, expiresAt: null }
      }),
      refresh: async () => null
    },
    fetchImpl
  )

  const desktopPreflight = await client.advisoryPreflight(
    String(preflight.conversation_id),
    String(preflight.job_id),
    'fixture-lease'
  )

  const { request: rawRequest, ...rawJob } = preflight
  assert.deepEqual(desktopPreflight, rawJob)
  assert.equal(desktopPreflight.source_message_id, rawRequest?.message_id)
  assert.equal(desktopPreflight.context.watermark.message_id, fixture.owner_context.watermark.message_id)
  assert.equal(fetchImpl.mock.calls.length, 1)
})
