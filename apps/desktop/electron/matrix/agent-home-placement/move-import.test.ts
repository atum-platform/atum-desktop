import { describe, expect, it, vi } from 'vitest'

import type { PlacementConnectionAuth } from './connection-auth'
import type { PlacementConnectionPlatform } from './connection-platform'
import type { HomeMove, HomePlacement } from './contract'
import type { AgentHomePortableArchiveImportV25 } from './contract-v25'
import { acknowledgeImport } from './move-target'
import { readPackV25Json } from './pack-v25.fixture'
import { readPackJson } from './pack.fixture'
import { RetryLedger } from './retry-ledger'
import type { HomeContext } from './runtime-ops'

const AGENT = '00000000-0000-4000-8000-bd7662a5eeb4'
const MINI = '00000000-0000-4000-8000-b454f82c5857'
const MOVE = '00000000-0000-4000-8000-303617b97302'

const placement = (): HomePlacement => readPackJson<HomePlacement>('fixtures/placement.record.cloud.json')
const move = (): HomeMove => ({
  moveId: MOVE,
  idempotencyKey: '00000000-0000-4000-8000-c8f367a876b2',
  intent: 'manual',
  status: 'ready_to_commit',
  source: { kind: 'cloud' },
  target: { kind: 'mac', deviceServiceId: MINI },
  expectedHomeEpoch: 4,
  expectedPlacementRevision: 10,
  requestedAtPlatform: 1_800_000_000_000
})
const fetched = {
  dir: '/tmp/none',
  plain: '/tmp/none/plain',
  archiveSha256: 'f'.repeat(64),
  header: { manifest: { manifestSha256: 'd'.repeat(64) } }
} as never

function harness(options: {
  read?: () => unknown
  report?: (call: number) => unknown
  me?: string | null
  noConnection?: boolean
} = {}) {
  const instruction = readPackV25Json<AgentHomePortableArchiveImportV25>('fixtures/portable.archive.import.mac.json')
  const receipts: Array<{ requestId: string; body: Record<string, unknown> }> = []
  let reports = 0
  const platform = {
    readImport: vi.fn(async () => options.read?.() ?? { ok: true, value: instruction }),
    reportImport: vi.fn(async (_agent: string, body: { meta: { requestId: string } } & Record<string, unknown>) => {
      reports += 1
      receipts.push({ requestId: body.meta.requestId, body })

      return options.report?.(reports) ?? { ok: true, value: { ...body, outcome: 'imported', reason: null } }
    })
  }
  let sequence = 0
  const auth = {
    signMac: vi.fn(
      async (_message: string, build: (meta: Record<string, unknown>) => Record<string, unknown>, sign?: { requestId?: string }) => {
        sequence += 1

        return build({
          requestId: sign?.requestId ?? `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
          commandId: `10000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
          signer: 'mac_executor',
          signerKeyId: 'A'.repeat(43),
          deviceServiceId: MINI,
          sequence: 100 + sequence,
          issuedAt: 1_800_000_000_000,
          expiresAt: 1_800_000_300_000,
          nonce: 'C'.repeat(43),
          signature: 'B'.repeat(86)
        })
      }
    )
  }
  let next = 0
  const ctx = {
    me: () => (options.me === undefined ? MINI : options.me),
    connection: options.noConnection
      ? undefined
      : { platform: platform as unknown as PlacementConnectionPlatform, auth: auth as unknown as PlacementConnectionAuth },
    retry: new RetryLedger({ uuid: () => `66666666-6666-4666-8666-${String((next += 1)).padStart(12, '0')}` })
  } as unknown as HomeContext

  return { ctx, platform, auth, receipts, run: () => acknowledgeImport(ctx, AGENT, placement(), move(), fetched, AbortSignal.timeout(1_000)) }
}

describe('authenticating the portable import before a cloud home moves to this Mac', () => {
  it('reads the controller\'s instruction, checks it against what was fetched, and sends this Mac\'s signed receipt', async () => {
    const h = harness()

    await expect(h.run()).resolves.toBeNull()

    expect(h.platform.readImport).toHaveBeenCalledWith(AGENT, MOVE, expect.any(AbortSignal))
    expect(h.receipts).toHaveLength(1)
    expect(h.receipts[0]!.body).toMatchObject({
      moveId: MOVE,
      target: { kind: 'mac', deviceServiceId: MINI },
      portableArchiveSha256: 'f'.repeat(64),
      portableManifestSha256: 'd'.repeat(64),
      outcome: 'imported',
      reason: null
    })
  })

  it('sends a receipt whose answer never came again as the same operation', async () => {
    const h = harness({ report: call => (call === 1 ? { ok: false, kind: 'unavailable', status: 0 } : undefined) })

    await expect(h.run()).resolves.toBe('archive_import_unavailable')
    await expect(h.run()).resolves.toBeNull()

    expect(h.receipts).toHaveLength(2)
    expect(h.receipts[1]!.requestId).toBe(h.receipts[0]!.requestId)
    expect(h.auth.signMac.mock.calls[1]![2]).toEqual({ requestId: h.receipts[0]!.requestId })
  })

  it('starts a new operation once the platform has answered', async () => {
    const h = harness()

    await h.run()
    await h.run()

    expect(h.receipts[1]!.requestId).not.toBe(h.receipts[0]!.requestId)
  })

  it('names the platform\'s closed reason when the receipt is refused', async () => {
    const h = harness({ report: () => ({ ok: false, kind: 'conflict', status: 409, reason: 'stale_home' }) })

    await expect(h.run()).resolves.toBe('stale_home')
  })

  it('says a platform without the route has none, and one that cannot be reached is unavailable', async () => {
    await expect(harness({ read: () => ({ ok: false, kind: 'unsupported', status: 404 }) }).run()).resolves.toBe('portable_import_unsupported')
    await expect(harness({ read: () => ({ ok: false, kind: 'unavailable', status: 503 }) }).run()).resolves.toBe('portable_import_unavailable')
  })

  it.each([
    ['another archive', { portableArchiveSha256: 'e'.repeat(64) }],
    ['another manifest', { portableManifestSha256: 'c'.repeat(64) }],
    ['another Mac', { target: { kind: 'mac', deviceServiceId: '00000000-0000-4000-8000-f6222a1106ee' } }]
  ])('refuses an instruction for %s, and signs nothing', async (_name, change) => {
    const instruction = { ...readPackV25Json<AgentHomePortableArchiveImportV25>('fixtures/portable.archive.import.mac.json'), ...change }
    const h = harness({ read: () => ({ ok: true, value: instruction }) })

    await expect(h.run()).resolves.toBe('archive_mismatch')
    expect(h.auth.signMac).not.toHaveBeenCalled()
  })

  it('needs no import for a Mac that gave the home up to another Mac', async () => {
    const h = harness()
    const other = { ...move(), source: { kind: 'mac' as const, deviceServiceId: '00000000-0000-4000-8000-f6222a1106ee' } }

    await expect(acknowledgeImport(h.ctx, AGENT, placement(), other, fetched, AbortSignal.timeout(1_000))).resolves.toBeNull()
    expect(h.platform.readImport).not.toHaveBeenCalled()
  })

  it('is unavailable without a connection or a device identity', async () => {
    await expect(harness({ noConnection: true }).run()).resolves.toBe('portable_import_unavailable')
    await expect(harness({ me: null }).run()).resolves.toBe('portable_import_unavailable')
  })
})
