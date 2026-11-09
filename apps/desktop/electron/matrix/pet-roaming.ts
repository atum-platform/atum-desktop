import type { NativeGrant } from './authorization'
import { readDomainJson } from './domain'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

/** One owner-derived cosmetic read. Native chooses the resource and grant;
 * neither a target URL nor an owner from the renderer is accepted here. */
export async function readMatrixPetRoaming(resource: string, grant: NativeGrant, owner: string, signal: AbortSignal) {
  if (!UUID.test(owner)) { throw new Error('matrix_pet_invalid') }

  const response = await fetch(`${resource}/preferences/pet-roaming`, {
    headers: { Authorization: `Bearer ${grant.accessToken}` }, redirect: 'error', signal
  })

  if (!response.ok || !response.headers.get('content-type')?.startsWith('application/json')) {
    await response.body?.cancel()
    throw new Error('matrix_pet_preferences_unavailable')
  }

  const value = await readDomainJson(response, 4096) as { owner?: unknown; revision?: unknown; petRoaming?: unknown }

  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3 ||
    !Object.keys(value).every(key => ['owner','revision','petRoaming'].includes(key)) || value.owner !== owner ||
    !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 || typeof value.petRoaming !== 'boolean') {
    throw new Error('matrix_pet_invalid')
  }

  return value.petRoaming
}
