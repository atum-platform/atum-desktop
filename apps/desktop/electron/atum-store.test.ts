import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, type Mock, test, vi } from 'vitest'

import { AccountRootAuthority } from './atum-messaging/account-roots'
import {
  AtumMessagingHttpClient,
  MessagingHttpError,
  parseStoreEntitlementEnvelope
} from './atum-messaging/http-client'
import type {
  MessagingAccountSession,
  MessagingClientBoundary,
  StoreCatalog,
  StoreEntitlementProof,
  StorePurchaseResult,
  StorePurchaseStatus
} from './atum-messaging/types'
import {
  ATUM_STORE_CATALOG_FILE,
  ATUM_STORE_DIR,
  ATUM_STORE_ENTITLEMENT_FILE,
  AtumStoreService,
  type AtumStoreServiceOptions
} from './atum-store'

const ACCOUNT_A = '00000000-0000-4000-8000-303617b97302'
const ACCOUNT_B = '00000000-0000-4000-8000-00f765af1c54'
const ASSISTANT = '00000000-0000-4000-8000-7cac378a5787'
const IDENTITY = '00000000-0000-4000-8000-d3b5d0600970'
const OFFER_ID = '00000000-0000-4000-8000-50d86b120e98'
const PURCHASE_ID = '00000000-0000-4000-8000-0bb5de138389'
const IDEMPOTENCY_KEY = '00000000-0000-4000-8000-6cc9b1298c8f'
const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const GRANTED_AT = '2026-09-10T00:00:00.000Z'
const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

const session: MessagingAccountSession = {
  baseUrl: 'https://atum.test',
  user: { id: ACCOUNT_A, displayName: null, handle: null },
  tokens: { accessToken: 'secret-token', refreshToken: null, expiresAt: null }
}

/** The server wire shape: snake_case, exactly what the routes emit. */
function catalogResponse() {
  return {
    items: [
      {
        kind: 'skill',
        id: 'official/scribe',
        title: { vi: 'Biên ký', en: 'Scribe' },
        summary: { vi: 'Ghi chép cuộc họp' },
        detail: {
          description: { vi: 'Tóm tắt và ghi chép.' },
          try_prompt: { vi: 'Ghi lại cuộc họp này' },
          needs: ['internet']
        },
        glyph: '✒',
        accent: '#4f46e5',
        source: { type: 'hermes_optional', identifier: 'official/scribe' },
        featured: true,
        sort_order: 1,
        offer: { id: OFFER_ID, version: 3, price_protons: 5000 },
        hashes: [{ sha256: HASH_A, hermes_release: '2026.09' }]
      },
      {
        kind: 'pet',
        id: 'pet.mochi',
        title: { vi: 'Mochi' },
        summary: { vi: 'Thú cưng nhỏ' },
        detail: { description: { vi: 'Một con mochi.' }, try_prompt: { vi: 'Chơi nào' }, needs: [] },
        glyph: '◉',
        accent: '#0f766e',
        source: { type: 'bundled', slug: 'mochi' },
        featured: false,
        sort_order: 2,
        offer: null,
        hashes: [{ sha256: HASH_B, hermes_release: null }]
      }
    ],
    entitlements: [{ kind: 'skill', id: 'official/scribe', state: 'active', assistant_id: ASSISTANT, assistant_identity_id: IDENTITY, granted_at: GRANTED_AT }],
    available_protons: 12_345
  }
}

/** The parsed client shape the service's client boundary returns. */
function catalogFixture(): StoreCatalog {
  return {
    items: [
      {
        kind: 'skill',
        id: 'official/scribe',
        title: { vi: 'Biên ký', en: 'Scribe' },
        summary: { vi: 'Ghi chép cuộc họp' },
        detail: { description: { vi: 'Tóm tắt và ghi chép.' }, tryPrompt: { vi: 'Ghi lại cuộc họp này' }, needs: ['internet'] },
        glyph: '✒',
        accent: '#4f46e5',
        source: { type: 'hermes_optional', identifier: 'official/scribe' },
        featured: true,
        sortOrder: 1,
        offer: { id: OFFER_ID, version: 3, priceProtons: 5000 },
        hashes: [{ sha256: HASH_A, hermesRelease: '2026.09' }]
      },
      {
        kind: 'pet',
        id: 'pet.mochi',
        title: { vi: 'Mochi' },
        summary: { vi: 'Thú cưng nhỏ' },
        detail: { description: { vi: 'Một con mochi.' }, tryPrompt: { vi: 'Chơi nào' }, needs: [] },
        glyph: '◉',
        accent: '#0f766e',
        source: { type: 'bundled', slug: 'mochi' },
        featured: false,
        sortOrder: 2,
        offer: null,
        hashes: [{ sha256: HASH_B, hermesRelease: null }]
      }
    ],
    entitlements: [{ kind: 'skill', id: 'official/scribe', state: 'active', assistantId: ASSISTANT, assistantIdentityId: IDENTITY, grantedAt: GRANTED_AT }],
    availableProtons: 12_345,
    skippedUnknownItems: 0
  }
}

/**
 * Envelope v3, deliberately non-canonical key order and inner-field order: the
 * persisted proof must be these exact bytes, never a re-serialisation.
 * `catalog_owned` carries the paid set — including the pet, whose catalog id
 * differs from the slug the gateway installs (`identifier`).
 */
function proofRaw(account: string, expiresAt: number): string {
  return (
    `{"signature":"c2lnbmVkLXByb29m","expires_at":${expiresAt},"key_id":"store-v1","v":3,` +
    `"issued_at":${expiresAt - 604_800},` +
    `"catalog_owned":[` +
    `{"hashes":["${HASH_A}"],"delivery":"local","identifier":"official/scribe","id":"official/scribe","kind":"skill"},` +
    `{"hashes":["${HASH_B}"],"delivery":"local","identifier":"mochi","id":"pet.mochi","kind":"pet"}` +
    `],` +
    `"entitlements":[{"state":"active","id":"official/scribe","kind":"skill","assistant_id":"${ASSISTANT}","assistant_identity_id":"${IDENTITY}"}],` +
    `"account_id":"${account}"}`
  )
}

function proof(account: string, expiresAt: number): StoreEntitlementProof {
  const raw = proofRaw(account, expiresAt)

  return { envelope: parseStoreEntitlementEnvelope(JSON.parse(raw)), raw }
}

function purchaseCompleted(): StorePurchaseResult {
  return {
    outcome: 'completed',
    purchase: {
      id: PURCHASE_ID,
      offerId: OFFER_ID,
      offerVersion: 3,
      kind: 'skill',
      itemId: 'official/scribe',
      assistantId: ASSISTANT,
      amountProtons: 5000,
      status: 'completed',
      createdAt: GRANTED_AT,
      refundedAt: null
    },
    entitlement: { kind: 'skill', id: 'official/scribe', state: 'active', assistantId: ASSISTANT, assistantIdentityId: IDENTITY, grantedAt: GRANTED_AT },
    wallet: { availableProtons: 7345 }
  }
}

function purchaseStatusFixture(): StorePurchaseStatus {
  const completed = purchaseCompleted()

  return { purchase: completed.outcome === 'completed' ? completed.purchase : assert.fail('fixture'), entitlement: null }
}

// The mock is checked against the boundary's own signatures, so a drift in
// the client contract fails here at compile time, not as a runtime surprise.
interface StoreClientMock {
  catalog: Mock<MessagingClientBoundary['catalog']>
  purchase: Mock<MessagingClientBoundary['purchase']>
  purchaseStatus: Mock<MessagingClientBoundary['purchaseStatus']>
  entitlements: Mock<MessagingClientBoundary['entitlements']>
  startTrainingTask: Mock<MessagingClientBoundary['startTrainingTask']>
}

function roots(): AccountRootAuthority {
  const root = mkdtempSync(join(tmpdir(), 'atum-store-'))
  directories.push(root)
  const authority = new AccountRootAuthority(root)
  authority.commit(ACCOUNT_A, 1)

  return authority
}

function storeDir(authority: AccountRootAuthority, account: string): string {
  // Contract C1: the proof lives under the account-scoped Hermes home — the
  // directory main passes as HERMES_HOME — never under the account root itself.
  return join(authority.pathsForAccount(account).hermesStateRoot, ATUM_STORE_DIR)
}

/** Where builds before the B1 fix wrote the store files; Hermes never read there. */
function legacyStoreDir(authority: AccountRootAuthority, account: string): string {
  return join(authority.pathsForAccount(account).root, ATUM_STORE_DIR)
}

function harness(overrides: Partial<StoreClientMock> = {}, options: Partial<AtumStoreServiceOptions> = {}) {
  const authority = roots()
  let account = ACCOUNT_A

  const client: StoreClientMock = {
    catalog: vi.fn<MessagingClientBoundary['catalog']>(async () => catalogFixture()),
    purchase: vi.fn<MessagingClientBoundary['purchase']>(async () => purchaseCompleted()),
    purchaseStatus: vi.fn<MessagingClientBoundary['purchaseStatus']>(async () => purchaseStatusFixture()),
    entitlements: vi.fn<MessagingClientBoundary['entitlements']>(async () => proof(ACCOUNT_A, 4_000_000_000)),
    startTrainingTask: vi.fn<MessagingClientBoundary['startTrainingTask']>(async (assistantId, conversationId, skillId) => ({
      task_id: PURCHASE_ID, assistant_id: assistantId, assistant_identity_id: IDENTITY,
      conversation_id: conversationId, skill_id: skillId
    })),
    ...overrides
  }

  const service = new AtumStoreService({
    accountRoots: authority,
    session: () => ({ user: { id: account } }),
    client,
    ...options
  })

  return {
    authority,
    client,
    service,
    switchAccount(next: string, generation: number) {
      account = next
      authority.commit(next, generation)
    }
  }
}

test('training HTTP sends the selected employee and keeps only the public task descriptor', async () => {
  const descriptor = { task_id: PURCHASE_ID, assistant_id: ASSISTANT, assistant_identity_id: IDENTITY,
    conversation_id: 'conversation-1', skill_id: 'scribe' }

  const client = new AtumMessagingHttpClient(
    { current: () => session, refresh: async () => null },
    async (url, init) => {
      assert.ok(String(url).endsWith('/skills/tasks'))
      assert.equal(init?.method, 'POST')
      assert.deepEqual(JSON.parse(String(init?.body)), { assistant_id: ASSISTANT, conversation_id: 'conversation-1', skill_id: 'scribe' })

      return Response.json({ ...descriptor, private_body: 'must not reach renderer', unknown: 1 })
    }
  )

  assert.deepEqual(await client.startTrainingTask(ASSISTANT, 'conversation-1', 'scribe'), descriptor)
})

test('training HTTP rejects malformed identity and wrong target echoes', async () => {
  const descriptor = { task_id: PURCHASE_ID, assistant_id: ASSISTANT, assistant_identity_id: IDENTITY,
    conversation_id: 'conversation-1', skill_id: 'scribe' }

  for (const replacement of [
    { task_id: 'not-a-uuid' }, { assistant_identity_id: 'not-a-uuid' },
    { assistant_id: ACCOUNT_B }, { conversation_id: 'different' }, { skill_id: 'different' }
  ]) {
    const client = new AtumMessagingHttpClient(
      { current: () => session, refresh: async () => null },
      async () => Response.json({ ...descriptor, ...replacement })
    )

    await assert.rejects(client.startTrainingTask(ASSISTANT, 'conversation-1', 'scribe'), /invalid_response/)
  }
})

test('training service fences both the confirmed account and a switch during the request', async () => {
  let finish!: (value: Awaited<ReturnType<MessagingClientBoundary['startTrainingTask']>>) => void
  const pending = new Promise<Awaited<ReturnType<MessagingClientBoundary['startTrainingTask']>>>(resolve => { finish = resolve })
  const { service, client, switchAccount } = harness({ startTrainingTask: vi.fn(async () => pending) })
  await assert.rejects(service.startTrainingTask(ASSISTANT, 'conversation-1', 'scribe', ACCOUNT_B), /account_context_changed/)
  assert.equal(client.startTrainingTask.mock.calls.length, 0)
  const task = service.startTrainingTask(ASSISTANT, 'conversation-1', 'scribe', ACCOUNT_A)
  switchAccount(ACCOUNT_B, 2)
  finish({ task_id: PURCHASE_ID, assistant_id: ASSISTANT, assistant_identity_id: IDENTITY,
    conversation_id: 'conversation-1', skill_id: 'scribe' })
  await assert.rejects(task, /account_context_changed/)
})

test('v3 ownership requires delivery metadata and per-employee skill identity', () => {
  const envelope = JSON.parse(proofRaw(ACCOUNT_A, 4_000_000_000))
  delete envelope.catalog_owned[0].delivery
  assert.throws(() => parseStoreEntitlementEnvelope(envelope), /delivery/)
  envelope.catalog_owned[0].delivery = 'cloud'
  delete envelope.entitlements[0].assistant_identity_id
  assert.throws(() => parseStoreEntitlementEnvelope(envelope), /assistant_identity_id/)
})

test('catalog parser validates every projected field and rejects malformed items', async () => {
  const ok = new AtumMessagingHttpClient(
    { current: () => session, refresh: async () => null },
    async () => new Response(JSON.stringify(catalogResponse()), { status: 200 })
  )

  assert.deepEqual(await ok.catalog(), catalogFixture())

  const badPrice = catalogResponse()
  const firstOffer = badPrice.items[0]!.offer as { price_protons: number } | null
  firstOffer!.price_protons = -5

  const wrongPrice = new AtumMessagingHttpClient(
    { current: () => session, refresh: async () => null },
    async () => new Response(JSON.stringify(badPrice), { status: 200 })
  )

  await assert.rejects(wrongPrice.catalog(), (error: unknown) => {
    return error instanceof MessagingHttpError && error.code === 'invalid_response:store.catalog.items.0.offer.price_protons'
  })
})

test('an item of an unknown kind or source type is hidden and counted, never fatal (decision 11)', async () => {
  const response = catalogResponse() as {
    items: Array<{ kind: string; source: { type: string } | null }>
  }

  // One unknown kind, one known kind with an unknown source type: both hidden.
  response.items[0]!.kind = 'car'
  response.items[1]!.source = { type: 'hologram' }

  // A third, known item proves the rest of the catalog survives.
  response.items.push(catalogResponse().items[0]!)

  const client = new AtumMessagingHttpClient(
    { current: () => session, refresh: async () => null },
    async () => new Response(JSON.stringify(response), { status: 200 })
  )

  const catalog = await client.catalog()

  assert.equal(catalog.items.length, 1)
  assert.equal(catalog.skippedUnknownItems, 2)

  // The proof refresh rides the same response shape: a refresh over an unknown
  // item persists the catalog half instead of failing cold.
  const { authority, service } = harness({
    catalog: vi.fn(async () => catalog)
  })

  await service.refresh()
  assert.equal((await service.catalog()).skipped_unknown_items, 2)
  assert.equal(
    readFileSync(join(storeDir(authority, ACCOUNT_A), ATUM_STORE_ENTITLEMENT_FILE), 'utf8'),
    proofRaw(ACCOUNT_A, 4_000_000_000)
  )
})

test('an ENTITLEMENT of an unknown kind is hidden too, in the catalog and in the envelope', async () => {
  // Decision 11 was only applied to items. One entitlement of a kind a build
  // cannot fulfil took down the whole catalog read AND the proof refresh with
  // it, so an older client lost everything instead of hiding one row
  // Preserve the recovery and user-visible behavior covered by this path.
  // `catalog_owned` entry carries the same unknown kind, so the gate never
  // matches it either.
  const response = catalogResponse() as { entitlements: Array<Record<string, unknown>> }

  response.entitlements.push({
    kind: 'widget',
    id: 'future/thing',
    state: 'active',
    granted_at: GRANTED_AT
  })

  const client = new AtumMessagingHttpClient(
    { current: () => session, refresh: async () => null },
    async () => new Response(JSON.stringify(response), { status: 200 })
  )

  const catalog = await client.catalog()

  assert.deepEqual(
    catalog.entitlements.map(entry => entry.id),
    ['official/scribe']
  )
  assert.equal(catalog.skippedUnknownItems, 1)

  // And inside the signed envelope, where losing the parse loses every
  // enforcement decision at once.
  const envelope = JSON.parse(proofRaw(ACCOUNT_A, 4_000_000_000)) as Record<string, unknown>

  ;(envelope.entitlements as unknown[]).push({ kind: 'widget', id: 'future/thing', state: 'active' })

  const proofClient = new AtumMessagingHttpClient(
    { current: () => session, refresh: async () => null },
    async () => new Response(JSON.stringify(envelope), { status: 200 })
  )

  const result = await proofClient.entitlements()

  assert.deepEqual(
    result.envelope.entitlements.map(entry => entry.id),
    ['official/scribe']
  )
})

test('purchase sends the idempotency key in body and header, and parses offer_changed', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []

  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init })

    return new Response(
      JSON.stringify({ outcome: 'offer_changed', offer: { id: OFFER_ID, version: 4, price_protons: 6000 } }),
      { status: 200 }
    )
  }

  const client = new AtumMessagingHttpClient({ current: () => session, refresh: async () => null }, fetchImpl)
  const result = await client.purchase(OFFER_ID, 3, IDEMPOTENCY_KEY)

  assert.deepEqual(result, { outcome: 'offer_changed', offer: { id: OFFER_ID, version: 4, priceProtons: 6000 } })
  assert.equal(requests.length, 1)
  assert.equal(requests[0]!.url, 'https://atum.test/api/desktop/v1/protons/purchases')

  const headers = new Headers(requests[0]!.init?.headers)

  assert.equal(headers.get('idempotency-key'), IDEMPOTENCY_KEY)
  assert.deepEqual(JSON.parse(String(requests[0]!.init?.body)), {
    offer_id: OFFER_ID,
    offer_version: 3,
    idempotency_key: IDEMPOTENCY_KEY,
    assistant_id: null
  })
})

test('a confirmation minted for another account is refused before anything is charged', async () => {
  // The renderer's view of the account arrives asynchronously, so its own
  // scope check cannot see a hand-off main has already committed. Main is the
  // authority, and is now told what the person was looking at
  // Preserve the recovery and user-visible behavior covered by this path.
  const offerChanged = {
    outcome: 'offer_changed' as const,
    offer: { id: OFFER_ID, version: 4, priceProtons: 6000 }
  }

  // Typed from the success shape so `mockImplementation` below is assignable;
  // the first call must still never reach the client at all.
  const purchase = vi.fn(async (): Promise<typeof offerChanged> => {
    throw new Error('the request must never leave')
  })

  const { service } = harness({ purchase })

  await assert.rejects(
    service.purchase(OFFER_ID, 3, IDEMPOTENCY_KEY, ACCOUNT_B),
    (error: unknown) => error instanceof Error && error.message === 'account_context_changed'
  )
  assert.equal(purchase.mock.calls.length, 0)

  // The account in front still goes through, and so does an older renderer
  // that sends none: main's own fence remains the backstop it always was.
  purchase.mockImplementation(async () => offerChanged)

  await service.purchase(OFFER_ID, 3, IDEMPOTENCY_KEY, ACCOUNT_A)
  await service.purchase(OFFER_ID, 3, IDEMPOTENCY_KEY)
  assert.equal(purchase.mock.calls.length, 2)
})

test('entitlements returns the validated v3 envelope beside its exact received bytes', async () => {
  const text =
    `{ "signature": "c2lnbmVkLXByb29m", "v": 3, "expires_at": 4000000000, "key_id": "store-v1", ` +
    `"issued_at": 3999395200, ` +
    `"catalog_owned": [ { "kind": "skill", "id": "official/scribe", "delivery": "local", "identifier": "official/scribe", "hashes": ["${HASH_A}"] }, ` +
    `{ "kind": "widget", "id": "future/thing", "delivery": "local", "identifier": "future/thing", "hashes": [] } ], ` +
    `"entitlements": [ { "state": "active", "id": "official/scribe", "kind": "skill", "assistant_id": "${ASSISTANT}", "assistant_identity_id": "${IDENTITY}" } ], ` +
    `"account_id": "${ACCOUNT_A}" }`

  const client = new AtumMessagingHttpClient(
    { current: () => session, refresh: async () => null },
    async () => new Response(text, { status: 200 })
  )

  const result = await client.entitlements()

  assert.equal(result.raw, text)
  assert.deepEqual(result.envelope, {
    v: 3,
    accountId: ACCOUNT_A,
    issuedAt: 3_999_395_200,
    expiresAt: 4_000_000_000,
    keyId: 'store-v1',
    entitlements: [{ kind: 'skill', id: 'official/scribe', state: 'active', assistantId: ASSISTANT, assistantIdentityId: IDENTITY }],
    // An unknown kind survives the parse: the gateway still has to gate it.
    catalogOwned: [
      { kind: 'skill', id: 'official/scribe', identifier: 'official/scribe', delivery: 'local', hashes: [HASH_A] },
      { kind: 'widget', id: 'future/thing', identifier: 'future/thing', delivery: 'local', hashes: [] }
    ],
    signature: 'c2lnbmVkLXByb29m'
  })

  const malformed = new AtumMessagingHttpClient(
    { current: () => session, refresh: async () => null },
    async () =>
      new Response(
        JSON.stringify({
          v: 3,
          account_id: ACCOUNT_A,
          issued_at: 3_999_395_200,
          expires_at: 4_000_000_000,
          key_id: 'store-v1',
          entitlements: [],
          catalog_owned: [],
          signature: 'not+base64url/'
        }),
        { status: 200 }
      )
  )

  await assert.rejects(malformed.entitlements(), (error: unknown) => {
    return error instanceof MessagingHttpError && error.code === 'invalid_response:store.entitlements.signature'
  })
})

test('an envelope with v other than 2 is rejected before anything is persisted', async () => {
  const v1 = JSON.stringify({
    v: 1,
    account_id: ACCOUNT_A,
    issued_at: 3_999_395_200,
    expires_at: 4_000_000_000,
    key_id: 'store-v1',
    entitlements: [],
    catalog_owned: [],
    signature: 'c2lnbmVkLXByb29m'
  })

  const client = new AtumMessagingHttpClient(
    { current: () => session, refresh: async () => null },
    async () => new Response(v1, { status: 200 })
  )

  await assert.rejects(client.entitlements(), (error: unknown) => {
    return error instanceof MessagingHttpError && error.code === 'invalid_response:store.entitlements.v'
  })

  // The service half: a v1 envelope must not reach the proof file.
  const { authority, service } = harness({
    entitlements: vi.fn(async () => {
      throw new MessagingHttpError('invalid_response:store.entitlements.v', 200, false, null, null, null)
    })
  })

  await service.refresh()
  assert.equal(service.entitlementState(), 'missing')
  assert.equal(existsSync(join(storeDir(authority, ACCOUNT_A), ATUM_STORE_ENTITLEMENT_FILE)), false)
})

test('refresh persists the catalog snapshot and the verbatim envelope at the Hermes-facing path, mode 0600', async () => {
  const { authority, service } = harness()
  const catalog = await service.refresh()

  assert.deepEqual(catalog, {
    items: [
      {
        kind: 'skill',
        id: 'official/scribe',
        title: { vi: 'Biên ký', en: 'Scribe' },
        summary: { vi: 'Ghi chép cuộc họp' },
        detail: {
          description: { vi: 'Tóm tắt và ghi chép.' },
          try_prompt: { vi: 'Ghi lại cuộc họp này' },
          needs: ['internet']
        },
        glyph: '✒',
        accent: '#4f46e5',
        source: { type: 'hermes_optional', identifier: 'official/scribe' },
        featured: true,
        sort_order: 1,
        offer: { id: OFFER_ID, version: 3, price_protons: 5000 },
        hashes: [{ sha256: HASH_A, hermes_release: '2026.09' }]
      },
      {
        kind: 'pet',
        id: 'pet.mochi',
        title: { vi: 'Mochi' },
        summary: { vi: 'Thú cưng nhỏ' },
        detail: { description: { vi: 'Một con mochi.' }, try_prompt: { vi: 'Chơi nào' }, needs: [] },
        glyph: '◉',
        accent: '#0f766e',
        source: { type: 'bundled', slug: 'mochi' },
        featured: false,
        sort_order: 2,
        offer: null,
        hashes: [{ sha256: HASH_B, hermes_release: null }]
      }
    ],
    entitlements: [{ kind: 'skill', id: 'official/scribe', state: 'active', assistant_id: ASSISTANT, assistant_identity_id: IDENTITY, granted_at: GRANTED_AT }],
    available_protons: 12_345,
    skipped_unknown_items: 0,
    // The signed catalog-owned set, identifiers only. The renderer needs it to
    // tell a free bundled pet from a DELISTED paid one: the listed catalog
    // carries only listed items, the signed set carries every state
    // Preserve the recovery and user-visible behavior covered by this path.
    catalog_owned: [
      { kind: 'skill', identifier: 'official/scribe', delivery: 'local' },
      { kind: 'pet', identifier: 'mochi', delivery: 'local' }
    ]
  })

  const dir = storeDir(authority, ACCOUNT_A)
  const catalogPath = join(dir, ATUM_STORE_CATALOG_FILE)
  const envelopePath = join(dir, ATUM_STORE_ENTITLEMENT_FILE)

  // The one store file: the envelope, verbatim — byte-for-byte as received,
  // under the account-scoped Hermes home where the gateway reads it.
  assert.equal(readFileSync(envelopePath, 'utf8'), proofRaw(ACCOUNT_A, 4_000_000_000))
  // `catalog-owned.json` is gone: the paid set travels inside the signed
  // envelope now, never in an unsigned, listing-dependent file (review B5).
  assert.equal(existsSync(join(dir, 'catalog-owned.json')), false)
  // The catalog snapshot is the wire shape, so the loader revalidates it with
  // the same parser as a live response — WITHOUT `catalog_owned`, which is the
  // signed envelope's, persisted beside it and reloaded on its own. Writing it
  // here would make an unsigned copy of the one thing that must stay signed.
  const { catalog_owned: signedSet, ...snapshotShape } = catalog

  assert.deepEqual(JSON.parse(readFileSync(catalogPath, 'utf8')), JSON.parse(JSON.stringify(snapshotShape)))
  assert.equal(signedSet.length, 2)

  for (const path of [catalogPath, envelopePath]) {
    assert.equal(statSync(path).mode & 0o777, 0o600, path)
  }
})

test('the next write removes the pre-fix store directory at the account root', async () => {
  const { authority, service } = harness()
  const legacy = legacyStoreDir(authority, ACCOUNT_A)

  // What an older build left behind: the unsigned owned list and a proof Hermes
  // never read. They must not survive the first write at the fixed location.
  mkdirSync(legacy, { recursive: true })
  writeFileSync(join(legacy, 'catalog-owned.json'), '{"hashes":[],"items":[]}')
  writeFileSync(join(legacy, 'entitlement-proof.json'), '{}')

  await service.refresh()

  assert.equal(existsSync(legacy), false)
  assert.equal(
    readFileSync(join(storeDir(authority, ACCOUNT_A), ATUM_STORE_ENTITLEMENT_FILE), 'utf8'),
    proofRaw(ACCOUNT_A, 4_000_000_000)
  )
})

test('a malformed catalog half fails a cold refresh and caches nothing of it', async () => {
  const { authority, service } = harness({
    catalog: vi.fn(async () => {
      throw new MessagingHttpError('invalid_response:store.catalog.items.0.kind', 200, false, null, null, null)
    })
  })

  await assert.rejects(service.refresh(), /invalid_response:store\.catalog\.items\.0\.kind/)

  const dir = storeDir(authority, ACCOUNT_A)

  assert.equal(existsSync(join(dir, ATUM_STORE_CATALOG_FILE)), false)
  // The halves persist independently: the sound envelope still lands.
  assert.equal(readFileSync(join(dir, ATUM_STORE_ENTITLEMENT_FILE), 'utf8'), proofRaw(ACCOUNT_A, 4_000_000_000))
})

test('the envelope round-trips byte-identically through a restart, and the catalog cache serves offline', async () => {
  const first = harness()
  await first.service.refresh()

  const dir = storeDir(first.authority, ACCOUNT_A)
  const before = readFileSync(join(dir, ATUM_STORE_ENTITLEMENT_FILE), 'utf8')

  // A new main-process instance over the same account root: no network, cache only.
  const restarted = new AtumStoreService({
    accountRoots: first.authority,
    session: () => ({ user: { id: ACCOUNT_A } }),
    client: {
      catalog: vi.fn(async () => {
        throw new MessagingHttpError('temporarily_unavailable', 0, true, null, null, null)
      }),
      purchase: vi.fn(),
      purchaseStatus: vi.fn(),
      entitlements: vi.fn()
    }
  })

  assert.equal((await restarted.catalog()).items.length, 2)
  assert.equal(restarted.entitlementState(), 'valid')
  assert.deepEqual([...restarted.catalogOwnedHashes()].sort(), [HASH_A, HASH_B])
  assert.equal(readFileSync(join(dir, ATUM_STORE_ENTITLEMENT_FILE), 'utf8'), before)

  // A failed refresh over a warm cache returns the stale catalog, never an error.
  assert.equal((await restarted.refresh()).items.length, 2)
})

test('an expired envelope is reported expired — unavailable, never absent, never free', async () => {
  const { service } = harness(
    { entitlements: vi.fn(async () => proof(ACCOUNT_A, 1_700_000_000)) },
    { now: () => 1_800_000_000_000 }
  )

  assert.equal(service.entitlementState(), 'missing')
  await service.refresh()
  assert.equal(service.entitlementState(), 'expired')
})

test('account change discards the cache, the envelope and the ticket', async () => {
  const { authority, service, switchAccount } = harness()
  await service.refresh()

  const dirA = storeDir(authority, ACCOUNT_A)
  const legacyA = legacyStoreDir(authority, ACCOUNT_A)

  mkdirSync(legacyA, { recursive: true })
  writeFileSync(join(legacyA, 'catalog-owned.json'), '{"hashes":[],"items":[]}')

  assert.equal(existsSync(join(dirA, ATUM_STORE_ENTITLEMENT_FILE)), true)

  switchAccount(ACCOUNT_B, 2)

  // Nothing from account A is visible under account B's fence.
  assert.equal(service.catalogOwnedHashes().size, 0)
  assert.equal(service.entitlementState(), 'missing')

  // The sign-out/hand-off path removes the outgoing account's files outright —
  // the current location and the pre-fix one alike.
  service.revokeAccount(ACCOUNT_A)
  assert.equal(existsSync(dirA), false)
  assert.equal(existsSync(legacyA), false)

  switchAccount(ACCOUNT_A, 3)
  assert.equal(service.catalogOwnedHashes().size, 0)
  assert.equal(service.entitlementState(), 'missing')
})

test('a cold cache owns nothing and writes no store files', async () => {
  const { authority, service } = harness({
    catalog: vi.fn(async () => {
      throw new MessagingHttpError('temporarily_unavailable', 0, true, null, null, null)
    }),
    entitlements: vi.fn(async () => {
      throw new MessagingHttpError('temporarily_unavailable', 0, true, null, null, null)
    })
  })

  assert.equal(service.catalogOwnedHashes().size, 0)
  await assert.rejects(service.refresh(), /temporarily_unavailable/)
  assert.equal(existsSync(storeDir(authority, ACCOUNT_A)), false)
})

test('the uploader skip list comes from the signed envelope, so a delisted item stays skipped', async () => {
  const { service } = harness({
    // The listed catalog no longer returns the pet (delisted); its hash must
    // still be skipped, because the SIGNED catalog_owned keeps naming it.
    catalog: vi.fn(async () => ({ ...catalogFixture(), items: catalogFixture().items.slice(0, 1) }))
  })

  await service.refresh()
  assert.deepEqual([...service.catalogOwnedHashes()].sort(), [HASH_A, HASH_B])
})

test('with no stored envelope the skip list is empty and the refresh still completes', async () => {
  const { service } = harness({
    entitlements: vi.fn(async () => {
      throw new MessagingHttpError('temporarily_unavailable', 0, true, null, null, null)
    })
  })

  // Cold start: nothing is known catalog-owned, nothing is skipped — the
  // platform's 409 `catalog_owned` refusal is the backstop (covered in
  // atum-agent-sync.test.ts), and neither half stalls the other.
  assert.equal(service.catalogOwnedHashes().size, 0)
  await service.refresh()
  assert.equal(service.catalogOwnedHashes().size, 0)
  assert.equal(service.entitlementState(), 'missing')
})

test('a completed purchase refreshes the proof immediately; other outcomes do not', async () => {
  const { client, service } = harness()

  const completed = await service.purchase(OFFER_ID, 3, IDEMPOTENCY_KEY)

  assert.equal(completed.outcome, 'completed')
  assert.deepEqual(client.purchase.mock.calls, [[OFFER_ID, 3, IDEMPOTENCY_KEY, null]])
  assert.equal(client.catalog.mock.calls.length, 1)
  assert.equal(client.entitlements.mock.calls.length, 1)

  client.purchase.mockImplementation(async () => ({
    outcome: 'offer_changed',
    offer: { id: OFFER_ID, version: 4, priceProtons: 6000 }
  }))

  const changed = await service.purchase(OFFER_ID, 3, IDEMPOTENCY_KEY)

  assert.deepEqual(changed, { outcome: 'offer_changed', offer: { id: OFFER_ID, version: 4, price_protons: 6000 } })
  assert.equal(client.catalog.mock.calls.length, 1)
  assert.equal(client.entitlements.mock.calls.length, 1)
})

test('purchaseStatus returns the owner-bound record through the wire projection', async () => {
  const { client, service } = harness()
  const status = await service.purchaseStatus(PURCHASE_ID)

  assert.deepEqual(client.purchaseStatus.mock.calls, [[PURCHASE_ID]])
  assert.deepEqual(status, {
    purchase: {
      id: PURCHASE_ID,
      offer_id: OFFER_ID,
      offer_version: 3,
      kind: 'skill',
      item_id: 'official/scribe',
      assistant_id: ASSISTANT,
      amount_protons: 5000,
      status: 'completed',
      created_at: GRANTED_AT,
      refunded_at: null
    },
    entitlement: null
  })
})

test('an envelope signed for another account is never persisted or served', async () => {
  const { authority, service } = harness({
    entitlements: vi.fn(async () => proof(ACCOUNT_B, 4_000_000_000))
  })

  await service.refresh()
  assert.equal(service.entitlementState(), 'missing')
  assert.equal(existsSync(join(storeDir(authority, ACCOUNT_A), ATUM_STORE_ENTITLEMENT_FILE)), false)
})

const monthlyHire = { id: PURCHASE_ID, assistant_id: ASSISTANT, item_id: 'cloud/employee',
  offer_id: OFFER_ID, offer_version: 1, price_protons: 1000, billing_interval: 'month',
  renewal_enabled: true, period_start: '2026-09-01T00:00:00Z', period_end: '2026-10-01T00:00:00Z',
  state: 'active', renewal_error: null, cancelled_at: null }

test('monthly checkout sends explicit consent and its complete retry identity, projecting public fields only', async () => {
  const client = new AtumMessagingHttpClient(
    { current: () => session, refresh: async () => null }, async (url, init) => {
      assert.ok(String(url).endsWith('/agents/hiring'))
      assert.equal(new Headers(init?.headers).get('idempotency-key'), PURCHASE_ID)
      assert.deepEqual(JSON.parse(String(init?.body)), { assistant_id: ASSISTANT, offer_id: OFFER_ID,
        offer_version: 1, idempotency_key: PURCHASE_ID, accept_automatic_renewal: true })
      return Response.json({ outcome: 'completed', subscription: { ...monthlyHire, private_body: 'PRIVATE' } })
    }
  )
  assert.deepEqual(await client.hireAgent(ASSISTANT, OFFER_ID, 1, PURCHASE_ID, true), { outcome: 'completed', subscription: monthlyHire })
})

test('monthly checkout cannot apply a response naming a different employee or offer', async () => {
  for (const replacement of [{ assistant_id: ACCOUNT_B }, { offer_id: ACCOUNT_B }]) {
    const client = new AtumMessagingHttpClient({ current: () => session, refresh: async () => null },
      async () => Response.json({ outcome: 'completed', subscription: { ...monthlyHire, ...replacement } }))
    await assert.rejects(client.hireAgent(ASSISTANT, OFFER_ID, 1, PURCHASE_ID, true), /hiring_binding/)
  }
})

test('ordinary hired employee tasks carry a public pin without a selected skill or private body', async () => {
  const task = { task_id: PURCHASE_ID, assistant_id: ASSISTANT, assistant_identity_id: IDENTITY,
    conversation_id: 'employee-task', skill_id: null }
  const client = new AtumMessagingHttpClient({ current: () => session, refresh: async () => null },
    async (url, init) => {
      assert.ok(String(url).endsWith('/agents/tasks'))
      assert.deepEqual(JSON.parse(String(init?.body)), { assistant_id: ASSISTANT, conversation_id: 'employee-task', skill_id: null })
      return Response.json({ task: { ...task, private_body: 'PRIVATE' } })
    })
  assert.deepEqual(await client.startAgentTask(ASSISTANT, 'employee-task', null), task)
})


test('content beats share the account-scoped 15-minute Store safety gate', async () => {
  vi.useFakeTimers()
  try {
    const { service, client, switchAccount } = harness({}, { now: () => Date.now() })
    await service.refresh()
    for (let minute = 0; minute < 14; minute++) {
      await vi.advanceTimersByTimeAsync(60_000)
      await service.refresh(true)
    }
    assert.equal(client.catalog.mock.calls.length, 1)
    await vi.advanceTimersByTimeAsync(60_000)
    await service.refresh(true)
    assert.equal(client.catalog.mock.calls.length, 2)
    await service.refresh() // focus/purchase/manual invalidation
    assert.equal(client.catalog.mock.calls.length, 3)
    switchAccount(ACCOUNT_B, 2)
    await service.refresh(true)
    assert.equal(client.catalog.mock.calls.length, 4)
  } finally { vi.useRealTimers() }
})
