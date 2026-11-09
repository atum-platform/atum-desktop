import { isDeepStrictEqual } from 'node:util'

import {
  type AtumLocalPet,
  type AtumPersonalPet,
  type AtumPetInspection,
  type AtumPetWrite,
  parsePetBundle,
  parsePetInspection
} from '../shared/atum-account-pets'
import type { AtumSkillBundle } from '../shared/atum-agent-content'

import type { RegisteredAssistant } from './atum-messaging/types'

export interface AtumPetLibraryClient {
  list: () => Promise<AtumPersonalPet[]>
  put: (id: string, input: AtumPetWrite) => Promise<AtumPersonalPet>
  getContent: (sha256: string) => Promise<AtumSkillBundle>
  putContent: (bundle: AtumSkillBundle) => Promise<void>
}
export interface PetReplicaState {
  records: Record<string, AtumPersonalPet>
  restored: string[]
}
export interface PetSyncContext {
  assistant: RegisteredAssistant
  state: PetReplicaState
  cloud: Map<string, AtumPersonalPet>
  client: AtumPetLibraryClient
  run: (operation: string, payload?: Record<string, unknown>) => Promise<unknown>
  checked: <T>(operation: Promise<T>) => Promise<T>
  save: () => void
  assert: () => void
}
const equal = isDeepStrictEqual

function cosmetics(pet: Pick<AtumPersonalPet, 'display_name' | 'description' | 'content_sha256'>) {
  return { display_name: pet.display_name, description: pet.description, content_sha256: pet.content_sha256 }
}

function requireOk(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || (value as { ok?: boolean }).ok !== true) {
    throw new Error('pet_sync_conflict')
  }

  return value as Record<string, unknown>
}

function slugFor(pet: AtumPersonalPet) {
  return (
    pet.display_name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/gu, '-')
      .replace(/^-|-$/gu, '')
      .slice(0, 60) || `pet-${pet.pet_id.slice(0, 8)}`
  )
}

export async function restorePersonalPet(
  ctx: PetSyncContext,
  pet: AtumPersonalPet,
  local?: AtumLocalPet
): Promise<void> {
  if (pet.deleted_at) {
    return
  }

  // Reuse existing local bytes for a metadata-only rename.
  const bundle =
    local && local.content_sha256 === pet.content_sha256
      ? parsePetBundle(
          requireOk(await ctx.run('export_pet', { pet: { slug: local.slug, content_sha256: local.content_sha256 } }))
            .bundle
        )
      : await ctx.checked(ctx.client.getContent(pet.content_sha256))

  requireOk(
    await ctx.run('install_pet_bundle', {
      pet: {
        slug: local?.slug ?? slugFor(pet),
        ...cosmetics(pet),
        ref: { kind: 'personal', pet_id: pet.pet_id },
        byte_size: pet.byte_size,
        published_revision: pet.revision
      },
      bundle,
      ...(local ? { expected_metadata: cosmetics(local) } : {})
    })
  )
}

/** One pass inside AtumAgentSync's existing account-fenced queue, without a new timer. */
export async function syncPersonalPets(
  ctx: PetSyncContext
): Promise<{ inspection: AtumPetInspection; partial: boolean; conflict: boolean }> {
  const inspected = await ctx.run('read_pets')
  let inspection = parsePetInspection(inspected)
  let partial = Number((inspected as { skipped?: { count?: number } }).skipped?.count ?? 0) > 0
  let conflict = false

  for (const local of inspection.pets) {
    if (local.ref.kind !== 'personal') {
      continue
    }

    const id = local.ref.pet_id
    let cloud = ctx.cloud.get(id)
    const base = ctx.state.records[id]

    if (cloud?.deleted_at) {
      continue
    }

    try {
      if (!cloud) {
        // Tombstones are retained by the server. A previously claimed missing
        // record is an error, not permission to create a new identity.
        if (local.published_revision > 0) {
          throw new Error('pet_record_missing')
        }

        const bundle = parsePetBundle(
          requireOk(await ctx.run('export_pet', { pet: { slug: local.slug, content_sha256: local.content_sha256 } }))
            .bundle
        )

        await ctx.checked(ctx.client.putContent(bundle))
        cloud = await ctx.checked(ctx.client.put(id, { expected_revision: 0, ...cosmetics(local) }))
        ctx.cloud.set(cloud.pet_id, cloud)
      } else if (!equal(cosmetics(local), cosmetics(cloud))) {
        const localChanged = base
          ? !equal(cosmetics(local), cosmetics(base))
          : local.published_revision === cloud.revision

        if (local.content_sha256 !== cloud.content_sha256) {
          throw new Error('pet_content_conflict')
        }

        if (localChanged) {
          cloud = await ctx.checked(ctx.client.put(id, { expected_revision: cloud.revision, ...cosmetics(local) }))
          ctx.cloud.set(cloud.pet_id, cloud)
        } else {
          await restorePersonalPet(ctx, cloud, local)
        }
      }

      requireOk(
        await ctx.run('claim_pet', {
          pet: {
            slug: local.slug,
            ref: { kind: 'personal', pet_id: cloud.pet_id },
            content_sha256: cloud.content_sha256,
            published_revision: cloud.revision
          }
        })
      )

      // A deduplicated create adopts the existing account record's cosmetics.
      if (cloud.pet_id !== id && !equal(cosmetics(local), cosmetics(cloud))) {
        await restorePersonalPet(ctx, cloud, { ...local, ref: { kind: 'personal', pet_id: cloud.pet_id } })
      }

      ctx.state.records[cloud.pet_id] = cloud

      if (!ctx.state.restored.includes(cloud.pet_id)) {
        ctx.state.restored.push(cloud.pet_id)
      }

      ctx.save()
    } catch (error) {
      ctx.assert()

      if (error instanceof Error && error.message === 'pet_content_conflict') { conflict = true }
      partial = true
    }
  }

  if (ctx.assistant.isDefault) {
    // Restore the account library once per local installation. Removing local
    // bytes later does not revoke ownership or repeatedly reinstall the pet.
    for (const cloud of ctx.cloud.values()) {
      if (cloud.deleted_at || ctx.state.restored.includes(cloud.pet_id)) {
        continue
      }

      try {
        await restorePersonalPet(ctx, cloud)
        ctx.state.records[cloud.pet_id] = cloud
        ctx.state.restored.push(cloud.pet_id)
        ctx.save()
      } catch {
        ctx.assert()
        partial = true
      }
    }
  }

  inspection = parsePetInspection(await ctx.run('read_pets'))

  return { inspection, partial, conflict }
}
