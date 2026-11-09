import { type AtumPetBinding, parsePetBinding } from './atum-account-preferences'
import { type AtumSkillBundle, parseSkillBundle } from './atum-agent-content'

export interface AtumPersonalPet {
  pet_id: string
  revision: number
  display_name: string
  description: string
  content_sha256: string
  byte_size: number
  deleted_at: string | null
  updated_at: string
}
export interface AtumLocalPet {
  slug: string
  display_name: string
  description: string
  ref: NonNullable<AtumPetBinding['ref']>
  content_sha256: string
  byte_size: number
  published_revision: number
}
export interface AtumPetInspection {
  pets: AtumLocalPet[]
  active: AtumPetBinding
  explicit: boolean
}
export type AtumPetWrite = Pick<AtumPersonalPet, 'display_name' | 'description' | 'content_sha256'> & {
  expected_revision: number
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid_pet_content')
  }

  return value as Record<string, unknown>
}
const digest = /^[a-f0-9]{64}$/u
export function parsePersonalPet(value: unknown): AtumPersonalPet {
  const row = object(value)
  parsePetBinding({ ref: { kind: 'personal', pet_id: row.pet_id }, enabled: true, scale: 1 })
  if (
    !Number.isSafeInteger(row.revision) ||
    Number(row.revision) < 1 ||
    typeof row.display_name !== 'string' ||
    !row.display_name.trim() ||
    row.display_name.length > 100 ||
    typeof row.description !== 'string' ||
    row.description.length > 2000 ||
    !digest.test(String(row.content_sha256)) ||
    !Number.isSafeInteger(row.byte_size) ||
    Number(row.byte_size) < 1 ||
    Number(row.byte_size) > 4_300_000 ||
    typeof row.updated_at !== 'string' ||
    (row.deleted_at !== null && typeof row.deleted_at !== 'string')
  ) {
    throw new Error('invalid_pet_content')
  }

  return structuredClone(row) as unknown as AtumPersonalPet
}
export function parsePetList(value: unknown): AtumPersonalPet[] {
  const row = object(value)
  if (!Array.isArray(row.pets) || row.pets.length > 500) {
    throw new Error('invalid_pet_content')
  }
  const result = row.pets.map(parsePersonalPet)
  if (new Set(result.map(pet => pet.pet_id)).size !== result.length) {
    throw new Error('invalid_pet_content')
  }

  return result
}
export function parsePetInspection(value: unknown): AtumPetInspection {
  const row = object(value)
  if (row.ok !== true || !Array.isArray(row.pets) || row.pets.length > 500 || typeof row.explicit !== 'boolean') {
    throw new Error('invalid_pet_content')
  }
  const pets = row.pets.map(value => {
    const pet = object(value)
    const ref = parsePetBinding({ ref: pet.ref, enabled: true, scale: 1 }).ref
    if (
      !ref ||
      typeof pet.slug !== 'string' ||
      !/^[a-z0-9][a-z0-9._-]{0,79}$/u.test(pet.slug) ||
      typeof pet.display_name !== 'string' ||
      typeof pet.description !== 'string' ||
      !digest.test(String(pet.content_sha256)) ||
      !Number.isSafeInteger(pet.byte_size) ||
      Number(pet.byte_size) < 1 ||
      !Number.isSafeInteger(pet.published_revision) ||
      Number(pet.published_revision) < 0
    ) {
      throw new Error('invalid_pet_content')
    }

    return { ...pet, ref } as unknown as AtumLocalPet
  })

  return { pets, active: parsePetBinding(row.active), explicit: row.explicit }
}
/** Hermes verifies canonical bytes, image decoding and hashes again before installation. */
export function parsePetBundle(value: unknown): AtumSkillBundle {
  const bundle = parseSkillBundle(value)
  const paths = bundle.files.map(file => file.path)
  if (
    bundle.files.length < 2 ||
    bundle.files.length > 3 ||
    new Set(paths).size !== paths.length ||
    !paths.includes('pet.json') ||
    paths.filter(path => ['spritesheet.webp', 'spritesheet.png'].includes(path)).length !== 1 ||
    paths.some(path => !['pet.json', 'spec.json', 'spritesheet.webp', 'spritesheet.png'].includes(path)) ||
    new TextEncoder().encode(JSON.stringify(bundle)).byteLength > 4_300_000
  ) {
    throw new Error('invalid_pet_content')
  }

  return bundle
}
