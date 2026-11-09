import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  agentHomeSignedBytes,
  classifyPortablePath,
  parsePlacement,
  parsePortableManifest,
  parsePublicationReceipt,
  parseReadinessObservation,
  type PortableCategory,
  portableManifestDigest,
  publicationPayloadBytes,
  validCheckpointCapture,
  validPublicationEnqueue,
  validPublicationEnvelope,
  validReadinessReport
} from './contract'
import { pack, PACK_PIN, packDigest, pinnedDigest, readPackJson } from './pack.fixture'

// The pack is the Mac's conformance suite: every fixture of a message this Mac consumes (the
// placement, the readiness observation, the portable manifest, the publication receipt) or produces
// (the readiness report, the capture record, the publication enqueue) must be accepted or refused here
// exactly as the platform's own tools do.
const consumers: Record<string, (value: unknown) => unknown> = {
  'home.placement.record': parsePlacement,
  'home.readiness.observation': parseReadinessObservation,
  'home.readiness.report': value => (validReadinessReport(value) ? value : null),
  'home.checkpoint.manifest': parsePortableManifest,
  'home.checkpoint.capture': value => (validCheckpointCapture(value) ? value : null),
  'matrix.publication.enqueue': value => (validPublicationEnqueue(value) ? value : null),
  'matrix.publication.receipt': parsePublicationReceipt
}

describe('the vendored atum.agent-home/2.1 pack', () => {
  it('is the frozen pack: its framed digest is the published pin', () => {
    expect(pinnedDigest()).toBe(PACK_PIN)
    expect(packDigest()).toBe(PACK_PIN)
  })

  const fixtures = pack().fixtures.filter(fixture => fixture.message && consumers[fixture.message])

  it('has fixtures for every message this Mac consumes or produces', () => {
    for (const message of Object.keys(consumers)) {
      expect(fixtures.some(fixture => fixture.message === message && fixture.expect === 'accept')).toBe(true)
      expect(fixtures.some(fixture => fixture.message === message && fixture.expect === 'reject')).toBe(true)
    }
  })

  it.each(fixtures.map(fixture => [fixture.message!, fixture.file.replace('fixtures/', ''), fixture] as const))(
    '%s %s',
    (_message, _name, fixture) => {
      const result = consumers[fixture.message!]!(readPackJson(fixture.file))

      if (fixture.expect === 'accept') {
        expect(result).not.toBeNull()
      } else {
        expect(result).toBeNull()
      }
    }
  )
})

describe('the portable path grammar', () => {
  const included = (category: PortableCategory, path: string) => classifyPortablePath(category, path).outcome === 'included'

  const skipped = (category: PortableCategory, path: string) => {
    const result = classifyPortablePath(category, path)

    return result.outcome === 'skipped' ? result.reasonCode : 'included'
  }

  it('admits NFC names, spaces and ordinary words that merely sound sensitive', () => {
    expect(included('memory', 'memory/ghi-chú hôm nay.md')).toBe(true)
    expect(included('memory', 'memory/secret-santa.md')).toBe(true)
    expect(included('skills', 'skills/token-counter/SKILL.md')).toBe(true)
    expect(included('skills', 'skills/calendar/package.json')).toBe(true)
    expect(included('skills', 'skills/calendar/pnpm-lock.yaml')).toBe(true)
    expect(included('non_secret_config', 'config/profiles/personal.json')).toBe(true)
    expect(included('routine_definitions', 'routines/jobs.json')).toBe(true)
    expect(included('portable_app_data', 'apps/portable/index.json')).toBe(true)
  })

  it('refuses a path that is not NFC, absolute, parent-relative, backslashed or controlled', () => {
    expect(skipped('memory', 'memory/' + 'e'.normalize('NFC') + String.fromCharCode(0x301) + '.md')).toBe('invalid_relative_path')
    expect(skipped('memory', '/memory/a.md')).toBe('invalid_relative_path')
    expect(skipped('memory', 'memory/../auth.json')).toBe('invalid_relative_path')
    expect(skipped('memory', 'memory\\a.md')).toBe('invalid_relative_path')
    expect(skipped('memory', `memory/a${String.fromCharCode(7)}.md`)).toBe('invalid_relative_path')
    expect(skipped('memory', 'memory//a.md')).toBe('invalid_relative_path')
    expect(skipped('memory', 'memory/./a.md')).toBe('invalid_relative_path')
  })

  it('keeps every category to its own root', () => {
    expect(skipped('memory', 'skills/a.md')).toBe('outside_category')
    expect(skipped('memory', 'memory')).toBe('outside_category')
    expect(skipped('portable_app_data', 'apps/other/a.json')).toBe('outside_category')
  })

  it('skips databases, their sidecars and the session history file', () => {
    for (const name of ['state.db', 'index.sqlite', 'index.sqlite3', 'a.db-wal', 'a.db-shm', 'a.db-journal', 'x.sqlite-wal']) {
      expect(skipped('memory', `memory/${name}`)).toBe('database_or_sidecar')
    }
  })

  it('skips credentials and key material by exact name and extension, case-insensitively', () => {
    for (const name of ['auth.json', 'AUTH.JSON', '.env', '.env.local', '.netrc', '.npmrc', 'id_rsa', 'id_ed25519.pub', 'key.PEM', 'a.p12', 'credentials.json', 'login.keychain-db']) {
      expect(skipped('non_secret_config', `config/${name}`)).toBe('credential_or_key_material')
    }

    expect(skipped('non_secret_config', 'config/.ssh/config')).toBe('credential_or_key_material')
    expect(skipped('non_secret_config', 'config/.config/gcloud/x.json')).toBe('credential_or_key_material')
  })

  it('skips browser stores, package trees and the machine workspace', () => {
    expect(skipped('portable_app_data', 'apps/portable/Chrome/Default/Cookies')).toBe('browser_profile')
    expect(skipped('portable_app_data', 'apps/portable/cookies.sqlite')).toBe('browser_profile')
    expect(skipped('skills', 'skills/x/node_modules/y/index.js')).toBe('package_tree')
    expect(skipped('skills', 'skills/x/.venv/bin/python')).toBe('package_tree')
    expect(skipped('portable_app_data', 'apps/portable/workspace/a.txt')).toBe('machine_workspace')
  })
})

describe('the portable manifest', () => {
  it('commits a digest that leaves its own field out and ignores key order', () => {
    const manifest = readPackJson<Record<string, unknown>>('fixtures/checkpoint.manifest.json')
    const digest = portableManifestDigest(manifest as never)

    expect(digest).toMatch(/^[0-9a-f]{64}$/u)
    // The same value hermes_cli/atum_home_portable.py computes for this fixture
    // (tests/hermes_cli/test_atum_home_portable.py): both sides canonicalize alike.
    expect(digest).toBe('1c28b6b21f025c1f0b22319b388f92d3affd6c969ef90b0a106a1531bc3a3c7e')
    expect(portableManifestDigest({ ...manifest, manifestSha256: '0'.repeat(64) } as never)).toBe(digest)
    expect(portableManifestDigest(Object.fromEntries(Object.entries(manifest).reverse()) as never)).toBe(digest)
    expect(portableManifestDigest({ ...manifest, generation: 99 } as never)).not.toBe(digest)
  })
})

describe('the signed bytes', () => {
  const unsigned = () => {
    const body = readPackJson<{ meta: Record<string, unknown> } & Record<string, unknown>>('fixtures/readiness.report.mac.json')

    return body
  }

  it('are the domain, the action and the canonical body without the signature', () => {
    const body = unsigned()
    const bytes = agentHomeSignedBytes('ReadinessReport', body as never).toString('utf8')
    const nul = String.fromCharCode(0)

    expect(bytes.startsWith(`atum.agent-home/2.1${nul}ReadinessReport${nul}{`)).toBe(true)
    expect(bytes).not.toContain('"signature"')
    expect(bytes).toContain('"deviceServiceId":"00000000-0000-4000-8000-0bb5de138389"')
    // Keys are sorted, so the same body in any key order signs identically.
    const reordered = { ...body, meta: Object.fromEntries(Object.entries(body.meta).reverse()) }

    expect(agentHomeSignedBytes('ReadinessReport', reordered as never).equals(agentHomeSignedBytes('ReadinessReport', body as never))).toBe(true)
  })

  it('cannot be replayed under another action', () => {
    const body = unsigned()

    expect(agentHomeSignedBytes('ReadinessReport', body as never).equals(agentHomeSignedBytes('DrainAck', body as never))).toBe(false)
  })

  it('verify the way the Shell verifies them (ES256, IEEE P1363, SPKI)', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const body = unsigned()
    const bytes = agentHomeSignedBytes('ReadinessReport', body as never)
    const signature = sign('sha256', bytes, { key: privateKey, dsaEncoding: 'ieee-p1363' })
    const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64url')
    const key = createPublicKey({ key: Buffer.from(spki, 'base64url'), format: 'der', type: 'spki' })

    expect(signature.length).toBe(64)
    expect(spki).toHaveLength(122)
    expect(verify('sha256', bytes, { key, dsaEncoding: 'ieee-p1363' }, signature)).toBe(true)
    expect(verify('sha256', agentHomeSignedBytes('DrainAck', body as never), { key, dsaEncoding: 'ieee-p1363' }, signature)).toBe(false)
  })
})

describe('publishing through the platform (matrix.publication.enqueue)', () => {
  const frame = () => readPackJson<Record<string, unknown>>('fixtures/matrix.publication.enqueue.json')
  const payload = (content: object) => Buffer.from(JSON.stringify(content))

  /** The envelope the Mac POSTs: the frame, the exact bytes it hashes, the event type. */
  const envelope = (content: object = { msgtype: 'm.text', body: 'hello' }, overrides: Record<string, unknown> = {}) => {
    const bytes = payload(content)

    return {
      publication: { ...frame(), payloadSha256: createHash('sha256').update(bytes).digest('hex') },
      eventType: 'm.room.message',
      payloadBase64: bytes.toString('base64'),
      ...overrides
    }
  }

  it('signs under its own action, over the canonical frame, so it cannot be replayed as anything else', () => {
    const body = frame() as unknown as Parameters<typeof agentHomeSignedBytes>[1]
    const nul = String.fromCharCode(0)
    const bytes = agentHomeSignedBytes('MatrixPublicationEnqueue', body).toString('utf8')

    expect(bytes.startsWith(`atum.agent-home/2.1${nul}MatrixPublicationEnqueue${nul}{`)).toBe(true)
    expect(bytes).not.toContain('"signature"')
    expect(bytes).toContain('"payloadSha256":"dddd')
    expect(agentHomeSignedBytes('MatrixPublicationEnqueue', body).equals(agentHomeSignedBytes('DrainAck', body))).toBe(false)
  })

  it('accepts the envelope of a message and of one part of a split answer, and ties the bytes to the signed hash', () => {
    expect(validPublicationEnvelope(envelope())).toBe(true)
    expect(validPublicationEnvelope(envelope(undefined, { part: { index: 2, count: 3 } }))).toBe(true)
    expect(validPublicationEnvelope(envelope(undefined, { eventType: 'm.room.encrypted' }))).toBe(true)

    // The same bytes under another hash, or other bytes under this hash, are not what was signed.
    const base = envelope()
    expect(validPublicationEnvelope({ ...base, payloadBase64: payload({ body: 'other' }).toString('base64') })).toBe(false)
    expect(validPublicationEnvelope({ ...base, publication: { ...base.publication, payloadSha256: 'e'.repeat(64) } })).toBe(false)
  })

  it('refuses what the platform refuses: an unknown type, a stray field, a bad part, or a payload that is not one JSON object', () => {
    expect(validPublicationEnvelope(envelope(undefined, { eventType: 'm.room.redaction' }))).toBe(false)
    expect(validPublicationEnvelope(envelope(undefined, { extra: true }))).toBe(false)
    expect(validPublicationEnvelope(envelope(undefined, { part: { index: 3, count: 3 } }))).toBe(false)
    expect(validPublicationEnvelope(envelope(undefined, { part: { index: 0, count: 1025 } }))).toBe(false)
    expect(validPublicationEnvelope(envelope(undefined, { part: { index: 0, count: 1, extra: 1 } }))).toBe(false)

    for (const text of ['[]', '"text"', '12', 'null', '{not json']) {
      const bytes = Buffer.from(text)

      expect(
        validPublicationEnvelope({
          ...envelope(),
          publication: { ...frame(), payloadSha256: createHash('sha256').update(bytes).digest('hex') },
          payloadBase64: bytes.toString('base64')
        })
      ).toBe(false)
    }
  })

  it('takes only canonical base64 of 2 to 131072 bytes', () => {
    expect(publicationPayloadBytes(Buffer.from('{}').toString('base64'))?.toString()).toBe('{}')
    expect(publicationPayloadBytes('')).toBeNull()
    expect(publicationPayloadBytes('e30')).toBeNull() // unpadded: not what base64 produces
    expect(publicationPayloadBytes('e30=\n')).toBeNull()
    expect(publicationPayloadBytes(Buffer.alloc(131_073, 0x61).toString('base64'))).toBeNull()
    expect(publicationPayloadBytes(Buffer.alloc(131_072, 0x61).toString('base64'))).not.toBeNull()
    expect(publicationPayloadBytes(7)).toBeNull()
  })

  it('reads every state of a receipt, with the event only where it belongs', () => {
    const receipt = readPackJson<Record<string, unknown>>('fixtures/matrix.publication.receipt.json')

    expect(parsePublicationReceipt(receipt)).toMatchObject({ state: 'published', eventId: '$event:atum.example', reason: null })

    for (const state of ['queued', 'admitted', 'sending'] as const) {
      expect(parsePublicationReceipt({ ...receipt, state, eventId: null, reason: null })).toMatchObject({ state, eventId: null })
    }

    expect(parsePublicationReceipt({ ...receipt, state: 'refused', eventId: null, reason: 'move_in_progress' })).toMatchObject({
      state: 'refused',
      reason: 'move_in_progress'
    })
    expect(parsePublicationReceipt({ ...receipt, state: 'uncertain', eventId: null, reason: 'effect_unknown' })).toMatchObject({
      state: 'uncertain'
    })

    // A refusal with an event, a refusal without a reason, a publication without its event, and a reason out of the list.
    expect(parsePublicationReceipt({ ...receipt, state: 'refused', reason: 'stale_authority' })).toBeNull()
    expect(parsePublicationReceipt({ ...receipt, state: 'refused', eventId: null, reason: null })).toBeNull()
    expect(parsePublicationReceipt({ ...receipt, eventId: null })).toBeNull()
    expect(parsePublicationReceipt({ ...receipt, state: 'sending', eventId: null, reason: 'move_in_progress' })).toBeNull()
    expect(parsePublicationReceipt({ ...receipt, state: 'refused', eventId: null, reason: 'because' })).toBeNull()
    expect(parsePublicationReceipt({ ...receipt, state: 'sent' })).toBeNull()
  })
})
