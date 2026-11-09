import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  AGENT_HOME_V25_PREVIOUS_PROFILE,
  AGENT_HOME_V25_PROFILE,
  AgentHomeOwnerPlacementSnapshotV25Schema,
  AgentHomeOwnerWriteMetaV25Schema,
  macConnectionCatalogContentSha256,
  OwnerClientSignedMetaV25Schema,
  placementConnectionSignedBytes,
  S3_V25_MESSAGE_SCHEMAS
} from './contract-v25'
import {
  PACK_V24_ROOT,
  PACK_V25_PIN,
  PACK_V25_ROOT,
  packV25,
  packV25Digest,
  pinnedV25Digest,
  readPackV25Json
} from './pack-v25.fixture'

describe('the vendored atum.agent-home/2.5 pack', () => {
  it('is byte-for-byte the frozen pack', () => {
    expect(pinnedV25Digest()).toBe(PACK_V25_PIN)
    expect(packV25Digest()).toBe(PACK_V25_PIN)
  })

  it('stacks on 2.4 without changing any inherited fixture bytes', () => {
    const previous = JSON.parse(fs.readFileSync(path.join(PACK_V24_ROOT, 'contract.json'), 'utf8')) as {
      fixtures: Array<{ file: string }>
    }

    for (const { file } of previous.fixtures) {
      expect(fs.readFileSync(path.join(PACK_V25_ROOT, file)).equals(fs.readFileSync(path.join(PACK_V24_ROOT, file))), file)
        .toBe(true)
    }
  })

  const fixtures = packV25().fixtures.filter(
    fixture => fixture.message && Object.hasOwn(S3_V25_MESSAGE_SCHEMAS, fixture.message)
  )

  it('has an accepted fixture for every S3-owned wire message', () => {
    for (const message of Object.keys(S3_V25_MESSAGE_SCHEMAS)) {
      expect(fixtures.some(fixture => fixture.message === message && fixture.expect === 'accept'), message).toBe(true)
    }
  })

  it.each(fixtures.map(fixture => [fixture.message!, fixture.file.replace('fixtures/', ''), fixture] as const))(
    '%s %s',
    (message, _name, fixture) => {
      const schema = S3_V25_MESSAGE_SCHEMAS[message as keyof typeof S3_V25_MESSAGE_SCHEMAS]
      expect(schema.safeParse(readPackV25Json(fixture.file)).success).toBe(fixture.expect === 'accept')
    }
  )

  it('accepts the inherited and current profiles while identifying 2.5 as current', () => {
    const previous = AgentHomeOwnerPlacementSnapshotV25Schema.parse(
      readPackV25Json('fixtures/owner.placement.snapshot.json')
    )
    const current = AgentHomeOwnerPlacementSnapshotV25Schema.parse(
      readPackV25Json('fixtures/owner.placement.snapshot.v25.json')
    )

    expect(previous.profile).toBe(AGENT_HOME_V25_PREVIOUS_PROFILE)
    expect(current.profile).toBe(AGENT_HOME_V25_PROFILE)
    expect(current.moveCapability).toEqual({ state: 'available', profile: AGENT_HOME_V25_PROFILE })
  })

  it('accepts bearer-only phone metadata but requires the complete signed desktop branch', () => {
    const phone = readPackV25Json<{ meta: Record<string, unknown> }>(
      'fixtures/owner.move.preflight-request.unsigned-phone.json'
    )
    const desktop = readPackV25Json<{ meta: Record<string, unknown> }>('fixtures/owner.write-auth.signed-desktop.json')

    expect(AgentHomeOwnerWriteMetaV25Schema.parse(phone.meta)).toEqual({
      requestId: '00000000-0000-4000-8000-f1d11edf5c5c',
      surface: 'phone',
      authenticatedChannel: 'phone'
    })
    expect(OwnerClientSignedMetaV25Schema.safeParse(desktop.meta).success).toBe(true)
    expect(AgentHomeOwnerWriteMetaV25Schema.safeParse({ ...phone.meta, signature: 'B'.repeat(86) }).success).toBe(false)
  })
})

describe('the inherited 2.4 signed bytes', () => {
  it('uses device-service/3 framing, omits the signature and binds the exact message', () => {
    const body = readPackV25Json<Record<string, unknown> & { meta: { signature: string } }>(
      'fixtures/mac.connection-catalog.ingest.json'
    )
    const bytes = Buffer.from(placementConnectionSignedBytes('home.connection-catalog.ingest', body))

    expect(bytes.toString('utf8')).toMatch(/^atum\.device-service\.v3\0home\.connection-catalog\.ingest\0\{/u)
    expect(bytes.toString('utf8')).not.toContain('"signature"')
    expect(
      bytes.equals(Buffer.from(placementConnectionSignedBytes('home.model-choice.application', body)))
    ).toBe(false)
  })

  it('verifies as ES256 P1363 bytes', () => {
    const body = readPackV25Json<Record<string, unknown> & { meta: { signature: string } }>(
      'fixtures/model-choice.application.report.json'
    )
    const bytes = placementConnectionSignedBytes('home.model-choice.application', body)
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const signature = sign('sha256', bytes, { key: privateKey, dsaEncoding: 'ieee-p1363' })

    expect(verify('sha256', bytes, { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature)).toBe(true)
  })
})

describe('catalog content revisions', () => {
  it('hashes only sanitized connection/model content, not home or move binding', () => {
    const settled = readPackV25Json<{ connections: Parameters<typeof macConnectionCatalogContentSha256>[0] }>(
      'fixtures/mac.connection-catalog.ingest.json'
    )
    const rebound = readPackV25Json<{ connections: Parameters<typeof macConnectionCatalogContentSha256>[0] }>(
      'fixtures/mac.connection-catalog.ingest.move-republish.json'
    )

    expect(macConnectionCatalogContentSha256(settled.connections)).toBe(
      macConnectionCatalogContentSha256(rebound.connections)
    )
    expect(createHash('sha256').update(JSON.stringify(settled.connections)).digest('hex')).toMatch(/^[0-9a-f]{64}$/u)
  })
})
