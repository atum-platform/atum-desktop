import { type AtumPetBinding, parsePetBinding } from '../../shared/atum-account-preferences'
import {
  bundledMatrixPet,
  MATRIX_PET_DEFAULT_SCALE,
  type MatrixPetCatalog,
  type MatrixPetSnapshot,
  type MatrixPetTarget,
  type MatrixPetView,
  parseMatrixPetSnapshot
} from '../../shared/matrix-pet'
import type { PetInfo } from '../../shared/pet'

import { MatrixAgentDefinitionError } from './agent-definition'

export interface MatrixPetScope {
  key: string
  generation: number
  owner: string
  agent: string
  assistantId: string
  isDefault: boolean
}

/** The pet a default agent with no saved pet shows, at the size the platform seeds for
 * new accounts and the picker saves on a first choice. */
const STAND_IN = { slug: 'gigi', scale: MATRIX_PET_DEFAULT_SCALE } as const
const ROAMING_CACHE_PREFIX = 'matrix-pet-roaming:'
const ROAMING_MEMORY_LIMIT = 32

/** Preference cache only; the platform owns choice and CAS. No executor or home
 * is involved. Serial per-agent operations prevent late reads resurrecting an
 * explicitly hidden pet. Different agents still share the provider's strict CAS. */
export class MatrixPets {
  private pending = new Map<string, Promise<unknown>>()
  private roamingAbort = new Map<string, AbortController>()
  private roamingMemory = new Map<string, boolean>()
  constructor(
    private readonly deps: {
      scope(target: MatrixPetTarget): MatrixPetScope | null
      cache: { getItem(key: string): string | null; setItem(key: string, value: string): void }
      request(scope: MatrixPetScope, write?: { revision: number; pet: AtumPetBinding }): Promise<MatrixPetSnapshot>
      catalog(scope: MatrixPetScope): Promise<MatrixPetCatalog>
      visit(scope: MatrixPetScope): Promise<void>
      sprite(scope: MatrixPetScope, pet: AtumPetBinding, catalog?: MatrixPetCatalog): Promise<PetInfo>
      /** Portable app.pet_roaming, read by native account under the same scope fence. */
      roaming?(scope: MatrixPetScope, signal: AbortSignal): Promise<boolean>
    }
  ) {}

  private rememberRoaming(key: string, value: boolean): void {
    this.roamingMemory.delete(key)
    this.roamingMemory.set(key, value)

    while (this.roamingMemory.size > ROAMING_MEMORY_LIMIT) {
      const oldest = this.roamingMemory.keys().next().value

      if (oldest === undefined) {
        break
      }

      this.roamingMemory.delete(oldest)
    }
  }

  /** The cloud flag is authoritative when reachable. A verified value is kept
   * owner-scoped so a transient read failure can preserve an explicit off;
   * before the first successful read, use the preference's documented default. */
  private async roaming(scope: MatrixPetScope, signal: AbortSignal): Promise<boolean> {
    if (!this.deps.roaming) {
      return true
    }

    const key = `${ROAMING_CACHE_PREFIX}${JSON.stringify([scope.key, scope.owner])}`

    try {
      const value = await this.deps.roaming(scope, signal)

      if (typeof value !== 'boolean') {
        throw new Error('matrix_pet_invalid')
      }

      this.rememberRoaming(key, value)

      try {
        this.deps.cache.setItem(key, String(value))
      } catch {
        // A local continuity failure must not change the verified cloud value.
      }

      return value
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === 'matrix_pet_invalid' || error.message === 'matrix_pet_cancelled')
      ) {
        throw error
      }

      const remembered = this.roamingMemory.get(key)

      if (remembered !== undefined) {
        return remembered
      }

      try {
        const saved = this.deps.cache.getItem(key)

        if (saved === 'true' || saved === 'false') {
          const value = saved === 'true'
          this.rememberRoaming(key, value)

          return value
        }
      } catch {
        // The account preference defaults on even when local continuity is gone.
      }

      return true
    }
  }

  read(target: MatrixPetTarget): Promise<MatrixPetView> {
    return this.run(target)
  }
  async write(target: MatrixPetTarget, revision: number, pet: AtumPetBinding): Promise<MatrixPetView> {
    if (!Number.isSafeInteger(revision) || revision < 0) {
      return Promise.reject(new Error('matrix_pet_invalid'))
    }

    return this.run(target, { revision, pet: parsePetBinding(pet) })
  }

  async catalog(target: MatrixPetTarget): Promise<MatrixPetCatalog> {
    const scope = this.deps.scope(target)

    if (!scope) {
      throw new Error('matrix_pet_cancelled')
    }

    const catalog = await this.deps.catalog(scope)

    if (JSON.stringify(this.deps.scope(target)) !== JSON.stringify(scope)) {
      throw new Error('matrix_pet_cancelled')
    }

    return catalog
  }

  async beginVisit(target: MatrixPetTarget): Promise<void> {
    const scope = this.deps.scope(target)

    if (!scope) {
      throw new Error('matrix_pet_cancelled')
    }

    if (!scope.isDefault) {
      return
    }

    await this.deps.visit(scope)

    if (JSON.stringify(this.deps.scope(target)) !== JSON.stringify(scope)) {
      throw new Error('matrix_pet_cancelled')
    }
  }

  /** Gigi for a default agent with no saved pet, only while the platform's own
   * catalog grants her. Any failure shows no pet rather than an unconfirmed one. */
  private async standIn(
    scope: MatrixPetScope,
    catalog: MatrixPetCatalog | undefined
  ): Promise<{ sprite: PetInfo; visitEndsAt?: string } | undefined> {
    const gigi = catalog?.items.find(
      item =>
        item.ref.kind === 'bundled' &&
        item.ref.slug === STAND_IN.slug &&
        (item.access === 'owned' || item.access === 'visiting')
    )

    if (!gigi) {
      return undefined
    }

    try {
      const sprite = await this.deps.sprite(scope, { ref: gigi.ref, enabled: true, scale: STAND_IN.scale })
      // A visit ends on the server's clock; the renderer re-reads then so she leaves.
      const visitEndsAt = gigi.access === 'visiting' ? (gigi.visitEndsAt ?? catalog?.visit.endsAt ?? undefined) : undefined

      return { sprite, ...(visitEndsAt ? { visitEndsAt } : {}) }
    } catch {
      return undefined
    }
  }

  private run(target: MatrixPetTarget, write?: { revision: number; pet: AtumPetBinding }): Promise<MatrixPetView> {
    const scope = this.deps.scope(target)

    if (!scope) {
      return Promise.reject(new Error('matrix_pet_cancelled'))
    }

    const key = `matrix-pet:${scope.key}:${scope.agent}`
    const roamingAbort = new AbortController()

    this.roamingAbort.get(key)?.abort(new Error('matrix_pet_cancelled'))
    this.roamingAbort.set(key, roamingAbort)

    const live = () => {
      if (JSON.stringify(this.deps.scope(target)) !== JSON.stringify(scope)) {
        roamingAbort.abort(new Error('matrix_pet_cancelled'))
        throw new Error('matrix_pet_cancelled')
      }
    }

    // One catalog request per read, shared by the stand-in, a personal pet's check
    // and the picker (returned with the view), so a focus asks the platform once.
    let catalogRequest: Promise<MatrixPetCatalog> | undefined
    const catalog = () => (catalogRequest ??= this.deps.catalog(scope))
    const catalogIfAvailable = () => catalog().catch(() => undefined)

    const next = (this.pending.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        live()

        // Read in parallel with the selection. A transient failure uses the
        // last verified owner value, or the schema's default-on value when this
        // installation has never completed the read.
        const roaming = this.roaming(scope, roamingAbort.signal)

        // The endpoint is an idempotent server-side activation. Its response is
        // intentionally ignored: a read remains the only authority for timing
        // and access, and transient activation failure must not hide an owned pet.
        if (!write && scope.isDefault) {
          await this.deps.visit(scope).catch(() => {})
          live()
        }

        let selection: MatrixPetSnapshot
        let freshness: MatrixPetView['freshness'] = 'current'

        try {
          selection = parseMatrixPetSnapshot(await this.deps.request(scope, write), scope.owner, scope.agent)
          live()
        } catch (error) {
          live()

          // Only a temporary read outage may use this principal's last verified
          // choice. Denial/malformed data/missing provider and failed writes do not.
          if (write || !(error instanceof MatrixAgentDefinitionError) || error.code !== 'unavailable') {
            throw error
          }

          const saved = this.deps.cache.getItem(key)

          if (!saved) {
            throw error
          }

          selection = parseMatrixPetSnapshot(JSON.parse(saved), scope.owner, scope.agent)
          freshness = 'offline'
        }

        // A current read asks for its catalog now, alongside the sprite, rather than
        // after it, so the read (and this agent's queue) waits one round trip, not two.
        // An offline read never asks; it shows only what was last verified.
        if (!write && freshness === 'current') {
          void catalogIfAvailable()
        }

        let cacheUnavailable = false

        if (freshness === 'current') {
          // A failed local cache save must not make an accepted cloud mutation
          // appear rejected. Report that local continuity is unavailable instead.
          try {
            this.deps.cache.setItem(key, JSON.stringify(selection))
          } catch {
            cacheUnavailable = true
          }
        }

        const roam = await roaming
        live()
        const result: MatrixPetView = { selection, freshness, roaming: roam, ...(cacheUnavailable ? { cacheUnavailable } : {}) }

        // A current read carries the catalog for the picker; a failed catalog leaves
        // it out and the picker asks on its own. Writes keep their old shape.
        const withCatalog = async (view: MatrixPetView): Promise<MatrixPetView> => {
          if (write || freshness !== 'current') {
            return view
          }

          const fresh = await catalogIfAvailable()
          live()

          return fresh ? { ...view, catalog: fresh } : { ...view, catalogUnavailable: true as const }
        }

        // Nothing saved: never chosen, or the saved pet is no longer accessible (the
        // platform then returns null too). An explicit "none" is a saved binding, not
        // null. The default agent shows Gigi when the platform says the account owns or
        // is visiting her. Display only. Nothing is written, so a later choice on any
        // device wins.
        if (selection.pet === null && freshness === 'current' && scope.isDefault) {
          const standIn = await this.standIn(scope, await catalogIfAvailable())
          live()

          if (standIn) {
            return withCatalog({ ...result, ...standIn, standIn: true as const })
          }
        }

        if (selection.pet?.enabled && selection.pet.ref) {
          const slug = bundledMatrixPet(selection.pet)

          // A visit is server-timed.  Rendering a cache would let a disconnected
          // clock keep Gigi past expiry, so it is visibly unavailable until a
          // current authority response arrives.
          if (freshness === 'offline' && selection.access === 'visiting') {
            result.visitUnavailable = true
          } else if (slug) {
            try {
              result.sprite = await this.deps.sprite(scope, selection.pet)
            } catch {
              result.assetUnavailable = true
            }
          } else if (selection.pet.ref.kind === 'personal') {
            try {
              if (freshness === 'offline') {
                // The encrypted selection was previously verified by the
                // platform. The native reader may use only its separately
                // receipt-verified, account-local cache in this branch; it
                // never asks a stale catalog to extend access.
                result.sprite = await this.deps.sprite(scope, selection.pet)
              } else {
                const fresh = await catalog()
                const id = selection.pet.ref.pet_id

                // Personal pets are an account library. The four catalog
                // items intentionally contain bundled houses only, so the
                // fresh library record itself is the authorization.
                if (!fresh.personal.some(pet => pet.pet_id === id)) {
                  throw new Error('matrix_pet_asset_unavailable')
                }

                result.sprite = await this.deps.sprite(scope, selection.pet, fresh)
              }
            } catch {
              result.assetUnavailable = true
            }
          } else {
            return withCatalog({ ...result, assetUnavailable: true })
          }
        }

        live()

        return withCatalog(result)
      })

    this.pending.set(key, next)
    void next
      .finally(() => {
        if (this.pending.get(key) === next) {
          this.pending.delete(key)
        }

        if (this.roamingAbort.get(key) === roamingAbort) {
          this.roamingAbort.delete(key)
        }
      })
      .catch(() => {})

    return next
  }
}
