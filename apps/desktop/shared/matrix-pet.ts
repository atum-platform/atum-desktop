import type { AtumPersonalPet } from './atum-account-pets'
import { type AtumPetBinding, parsePetBinding } from './atum-account-preferences'
import type { MatrixPetDiagnostic } from './matrix-pet-diagnostic'
import type { MatrixStoreOffer } from './matrix-store'
import type { PetInfo } from './pet'
import type {
  AtumPetChatHistoryResult,
  AtumPetChatLocale,
  AtumPetChatRef,
  AtumPetChatResult
} from './pet-chat/atum-pet-chat'

export const MATRIX_BUNDLED_PETS = ['gigi', 'cookie', 'bailey', 'mochi'] as const
/** The size a pet gets when none was saved: the platform seeds new accounts' Gigi at
 * this scale (atum-platform 0171 `matrix_seed_default_pet`), the unsaved stand-in is
 * drawn at it, and a first pick from the picker saves it, so choosing never resizes. */
export const MATRIX_PET_DEFAULT_SCALE = 1
export interface MatrixPetSnapshot {
  owner: string
  agent: string
  revision: number
  pet: AtumPetBinding | null
  provenance: 'default' | 'explicit' | null
  /** Platform-authoritative access for the selected pet.  A cached visit never
   * remains visible after its server time is no longer current. */
  access: MatrixPetAccess | null
  visitEndsAt: string | null
  serverTime: string
}
export type MatrixPetAccess = 'owned' | 'visiting' | 'available'
export type MatrixPetReference =
  | { kind: 'bundled'; slug: (typeof MATRIX_BUNDLED_PETS)[number] }
  | { kind: 'personal'; pet_id: string }
export interface MatrixPetCatalogItem {
  ref: MatrixPetReference
  slug: string
  name: string
  access: MatrixPetAccess
  offer: MatrixStoreOffer | null
  visitEndsAt?: string
}
export interface MatrixPetVisit {
  state: 'visiting' | 'expired' | 'owned' | 'none'
  startedAt: string | null
  endsAt: string | null
}
export interface MatrixPetCatalog {
  owner: string
  agent: string
  serverTime: string
  items: MatrixPetCatalogItem[]
  personal: AtumPersonalPet[]
  visit: MatrixPetVisit
  hatch: { offer: MatrixStoreOffer | null; creditEntitlementId: string | null; roundsLeft: number }
}
export interface MatrixPetTarget {
  scope: string
  agent: string
}
export interface MatrixPetView {
  selection: MatrixPetSnapshot
  freshness: 'current' | 'offline'
  sprite?: PetInfo
  assetUnavailable?: boolean
  /** A server-timed visit is intentionally not rendered from an offline cache. */
  visitUnavailable?: boolean
  /** Nothing is chosen yet for the creation-default agent, so `sprite` is Gigi, whom
   * the account owns or is visiting (platform catalog), shown without saving a choice.
   * Accounts older than the creation-time seed have no saved pet; this keeps their
   * default agent's companion visible until the person picks one or picks none. */
  standIn?: true
  /** When the stand-in is a server-timed visit, its end (the selection's own
   * `visitEndsAt` is null because nothing is saved). */
  visitEndsAt?: string
  /** The catalog this read already fetched, so the picker does not ask again. */
  catalog?: MatrixPetCatalog
  /** This read asked the platform for the catalog and got no answer: asking again at once
   * would fail the same way, so the picker waits for the next read. */
  catalogUnavailable?: true
  cacheUnavailable?: boolean
  /** Read-only projection of portable app.pet_roaming; absent keeps its default on. */
  roaming?: boolean
}
/** Bytes are selected by native main and returned only as a bounded data URL;
 * renderer code never learns the source path. */
export interface MatrixPetPhoto {
  dataUrl: string
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp'
}
export interface MatrixPetDraft {
  token: string
  index: number
  dataUri: string
  kind: 'voxel'
  draftId: string
  summary?: string
}
export interface MatrixPetHatchProgress {
  operationId: string
  phase: 'designing' | 'rendering_previews' | 'ready' | 'rendering' | 'validating' | 'publishing' | 'failed'
  index?: number
  count?: number
}
export interface MatrixPetGenerateInput {
  target: MatrixPetTarget
  operationId: string
  prompt: string
  count: number
  photo?: MatrixPetPhoto
}
/** The renderer confirms an exact price (or a no-charge credit) before main
 * does potentially expensive rendering. Main compares it with a fresh catalog
 * before it can create an artifact or begin a Store purchase. */
export type MatrixPetHatchQuote =
  | { kind: 'offer'; id: string; version: number; priceMicroProtons: number }
  | { kind: 'credit'; entitlementId: string }
export interface MatrixPetHatchInput {
  target: MatrixPetTarget
  operationId: string
  token: string
  index: number
  displayName: string
  description: string
  quote: MatrixPetHatchQuote
}
export interface MatrixPetRecovery {
  state: 'none' | 'pending' | 'parked' | 'adopt' | 'quarantined'
  canDiscard: boolean
}
export interface MatrixPetChatInput {
  ref: AtumPetChatRef
  message_id: string
  message: string
  locale: AtumPetChatLocale
}

export interface MatrixPetBridge {
  read(target: MatrixPetTarget): Promise<MatrixPetView>
  write(target: MatrixPetTarget, revision: number, pet: AtumPetBinding): Promise<MatrixPetView>
  catalog(target: MatrixPetTarget): Promise<MatrixPetCatalog>
  beginVisit(target: MatrixPetTarget): Promise<void>
  choosePhoto(): Promise<MatrixPetPhoto | null>
  generate(input: MatrixPetGenerateInput): Promise<{ token: string; drafts: MatrixPetDraft[] }>
  hatch(input: MatrixPetHatchInput): Promise<MatrixPetView>
  adoptPending(target: MatrixPetTarget): Promise<MatrixPetView>
  recovery(target: MatrixPetTarget): Promise<MatrixPetRecovery>
  retryPending(target: MatrixPetTarget): Promise<MatrixPetView>
  discardPending(target: MatrixPetTarget): Promise<void>
  cancel(operationId: string): Promise<void>
  /** Pet-scoped companion chat; never an agent room send. Optional for older
   * builds and fixtures that predate the companion route. */
  chat?(input: MatrixPetChatInput): Promise<AtumPetChatResult>
  chatHistory?(ref: AtumPetChatRef): Promise<AtumPetChatHistoryResult>
  onHatchProgress(listener: (progress: MatrixPetHatchProgress) => void): () => void
  /** One closed diagnostics line for main.log (`matrix-pet-diagnostic.ts`); fire and forget. */
  diagnostic?(line: MatrixPetDiagnostic): void
}

export function matrixPetHatchQuoteMatches(catalog: MatrixPetCatalog, quote: MatrixPetHatchQuote): boolean {
  if (quote.kind === 'credit') {
    return catalog.hatch.creditEntitlementId === quote.entitlementId
  }

  const offer = catalog.hatch.offer
  return (
    catalog.hatch.creditEntitlementId === null &&
    offer !== null &&
    offer.id === quote.id &&
    offer.version === quote.version &&
    offer.priceMicroProtons === quote.priceMicroProtons
  )
}

export function parseMatrixPetSnapshot(value: unknown, owner: string, agent: string): MatrixPetSnapshot {
  const row = value as MatrixPetSnapshot

  if (
    !row ||
    typeof row !== 'object' ||
    Array.isArray(row) ||
    row.owner !== owner ||
    row.agent !== agent ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 0 ||
    ![null, 'default', 'explicit'].includes(row.provenance) ||
    (row.pet === null) !== (row.provenance === null) ||
    ![null, 'owned', 'visiting', 'available'].includes(row.access) ||
    !(row.visitEndsAt === null || validTime(row.visitEndsAt)) ||
    !validTime(row.serverTime)
  ) {
    throw new Error('matrix_pet_invalid')
  }

  return {
    owner,
    agent,
    revision: row.revision,
    pet: row.pet === null ? null : parsePetBinding(row.pet),
    provenance: row.provenance,
    access: row.access,
    visitEndsAt: row.visitEndsAt,
    serverTime: row.serverTime
  }
}

/** Strict enough for a server clock while retaining normal ISO-8601 offsets. */
function validTime(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 40 &&
    /^\d{4}-\d{2}-\d{2}T/u.test(value) &&
    Number.isFinite(Date.parse(value))
  )
}

function validSlug(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,79}$/u.test(value)
}

function validUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  )
}

export function parseMatrixPetCatalog(value: unknown, owner: string, agent: string): MatrixPetCatalog {
  const row = value as Record<string, unknown>

  if (
    !row ||
    typeof row !== 'object' ||
    Array.isArray(row) ||
    row.owner !== owner ||
    row.agent !== agent ||
    !validTime(row.serverTime) ||
    !Array.isArray(row.items) ||
    row.items.length > 64 ||
    !Array.isArray(row.personal) ||
    row.personal.length > 500 ||
    !row.visit ||
    typeof row.visit !== 'object' ||
    Array.isArray(row.visit) ||
    !row.hatch ||
    typeof row.hatch !== 'object' ||
    Array.isArray(row.hatch)
  ) {
    throw new Error('matrix_pet_invalid')
  }

  const items = row.items.map(entry => {
    const item = entry as Record<string, unknown>
    const ref = item?.ref as Record<string, unknown>

    if (
      !item ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      !ref ||
      typeof ref !== 'object' ||
      Array.isArray(ref) ||
      !validSlug(item.slug) ||
      typeof item.name !== 'string' ||
      !item.name.trim() ||
      item.name.length > 100 ||
      !['owned', 'visiting', 'available'].includes(item.access as string) ||
      !(item.visitEndsAt === undefined || validTime(item.visitEndsAt))
    ) {
      throw new Error('matrix_pet_invalid')
    }

    let parsedRef: MatrixPetReference
    if (
      ref.kind === 'bundled' &&
      Object.keys(ref).length === 2 &&
      MATRIX_BUNDLED_PETS.includes(ref.slug as (typeof MATRIX_BUNDLED_PETS)[number])
    ) {
      parsedRef = { kind: 'bundled', slug: ref.slug as (typeof MATRIX_BUNDLED_PETS)[number] }
    } else if (ref.kind === 'personal' && Object.keys(ref).length === 2 && validUuid(ref.pet_id)) {
      parsedRef = { kind: 'personal', pet_id: ref.pet_id }
    } else {
      throw new Error('matrix_pet_invalid')
    }

    if ((item.access === 'visiting') !== Boolean(item.visitEndsAt)) {
      throw new Error('matrix_pet_invalid')
    }

    return {
      ref: parsedRef,
      slug: item.slug,
      name: item.name,
      access: item.access as MatrixPetAccess,
      offer: item.offer === null ? null : parseOffer(item.offer),
      ...(typeof item.visitEndsAt === 'string' ? { visitEndsAt: item.visitEndsAt } : {})
    }
  })
  const personal = row.personal.map(value => {
    const pet = value as AtumPersonalPet
    if (
      !validUuid(pet?.pet_id) ||
      !Number.isSafeInteger(pet.revision) ||
      pet.revision < 1 ||
      typeof pet.display_name !== 'string' ||
      !pet.display_name.trim() ||
      pet.display_name.length > 100 ||
      typeof pet.description !== 'string' ||
      pet.description.length > 2000 ||
      !/^[a-f0-9]{64}$/u.test(String(pet.content_sha256)) ||
      !Number.isSafeInteger(pet.byte_size) ||
      pet.byte_size < 1 ||
      pet.byte_size > 4_300_000 ||
      !validTime(pet.updated_at) ||
      !(pet.deleted_at === null || validTime(pet.deleted_at))
    ) {
      throw new Error('matrix_pet_invalid')
    }

    return structuredClone(pet)
  })
  const visit = row.visit as Record<string, unknown>
  if (
    !['visiting', 'expired', 'owned', 'none'].includes(visit.state as string) ||
    !(visit.startedAt === null || validTime(visit.startedAt)) ||
    !(visit.endsAt === null || validTime(visit.endsAt)) ||
    (visit.state === 'visiting') !== Boolean(visit.startedAt && visit.endsAt)
  ) {
    throw new Error('matrix_pet_invalid')
  }

  if (
    new Set(items.map(item => JSON.stringify(item.ref))).size !== items.length ||
    new Set(personal.map(pet => pet.pet_id)).size !== personal.length
  ) {
    throw new Error('matrix_pet_invalid')
  }

  const hatch = row.hatch as Record<string, unknown>
  if (
    !(hatch.offer === null || typeof hatch.offer === 'object') ||
    !(hatch.creditEntitlementId === null || validUuid(hatch.creditEntitlementId)) ||
    !Number.isSafeInteger(hatch.roundsLeft) ||
    Number(hatch.roundsLeft) < 0 ||
    Number(hatch.roundsLeft) > 3
  ) {
    throw new Error('matrix_pet_invalid')
  }
  return {
    owner,
    agent,
    serverTime: row.serverTime,
    items,
    personal,
    visit: {
      state: visit.state as MatrixPetVisit['state'],
      startedAt: visit.startedAt as string | null,
      endsAt: visit.endsAt as string | null
    },
    hatch: {
      offer: hatch.offer === null ? null : parseOffer(hatch.offer),
      creditEntitlementId: hatch.creditEntitlementId as string | null,
      roundsLeft: Number(hatch.roundsLeft)
    }
  }
}

function parseOffer(value: unknown): MatrixStoreOffer {
  const offer = value as Record<string, unknown>
  const count = (entry: unknown): entry is number =>
    typeof entry === 'number' && Number.isSafeInteger(entry) && entry >= 0
  const uuid = (entry: unknown): entry is string =>
    typeof entry === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(entry)

  if (
    !offer ||
    typeof offer !== 'object' ||
    Array.isArray(offer) ||
    Object.keys(offer).some(
      key =>
        ![
          'id',
          'version',
          'priceMicroProtons',
          'renewalPriceMicroProtons',
          'scope',
          'billingInterval',
          'delivery'
        ].includes(key)
    ) ||
    !uuid(offer.id) ||
    !count(offer.version) ||
    offer.version === 0 ||
    !count(offer.priceMicroProtons) ||
    !['account', 'agent'].includes(offer.scope as string) ||
    !['one_time', 'month'].includes(offer.billingInterval as string) ||
    !['cloud', 'bundled'].includes(offer.delivery as string) ||
    (offer.billingInterval === 'month' && !count(offer.renewalPriceMicroProtons)) ||
    (offer.billingInterval === 'one_time' && offer.renewalPriceMicroProtons !== undefined)
  ) {
    throw new Error('matrix_pet_invalid')
  }

  return {
    id: offer.id,
    version: offer.version,
    priceMicroProtons: offer.priceMicroProtons,
    scope: offer.scope as MatrixStoreOffer['scope'],
    billingInterval: offer.billingInterval as MatrixStoreOffer['billingInterval'],
    delivery: offer.delivery as MatrixStoreOffer['delivery'],
    ...(offer.billingInterval === 'month' ? { renewalPriceMicroProtons: offer.renewalPriceMicroProtons as number } : {})
  }
}

/** Unsupported sources retain their identity; never resolve one by its slug. */
export function bundledMatrixPet(pet: AtumPetBinding | null): string | undefined {
  return pet?.ref?.kind === 'bundled' &&
    MATRIX_BUNDLED_PETS.includes(pet.ref.slug as (typeof MATRIX_BUNDLED_PETS)[number])
    ? pet.ref.slug
    : undefined
}

/** The companion a visible pet talks as. A saved choice wins; the account's
 * creation-default stand-in talks as the bundled sprite it already draws. */
export function matrixPetChatRef(view: MatrixPetView | undefined): AtumPetChatRef | undefined {
  const ref = view?.selection.pet?.ref

  if (ref?.kind === 'personal') {
    return { kind: 'personal', pet_id: ref.pet_id }
  }

  if (ref?.kind === 'bundled' && MATRIX_BUNDLED_PETS.includes(ref.slug as (typeof MATRIX_BUNDLED_PETS)[number])) {
    return { kind: 'bundled', slug: ref.slug as (typeof MATRIX_BUNDLED_PETS)[number] }
  }

  const slug = view?.sprite?.slug

  return view?.standIn && slug && MATRIX_BUNDLED_PETS.includes(slug as (typeof MATRIX_BUNDLED_PETS)[number])
    ? { kind: 'bundled', slug: slug as (typeof MATRIX_BUNDLED_PETS)[number] }
    : undefined
}
