import type { MatrixMember } from '../../shared/matrix'

/**
 * How a person is named on screen (ledger AC8). A Matrix ID is identity, never a name: new
 * people's IDs are opaque (`@user-<32 hex>`, agents `@agent-<20 hex>`), so nothing here ever
 * prints one. A person shows as the name they set; their @handle shows only when the alias
 * directory said it is theirs (their own `current`, or a lookup that returned this exact
 * Matrix ID). Someone from another server keeps their full address in view, so a familiar
 * name never passes them off as someone here.
 */

/** The ID families the platform allocates for people, agents and app proxies, and the
 * reserved ones (signup policy bans `agent-`, `app-`, `service-` and `system-`). */
const OPAQUE_LOCALPART = /^(?:user|agent|app|service|system)-[0-9a-f]{16,}$/u
/** An Atum-shaped Matrix ID anywhere in a string (the SDK's room and member names). */
const OPAQUE_ID_IN_TEXT = /@(?:user|agent|app|service|system)-[0-9a-f]{16,}:[^\s,()]+/gu
/** The platform's handle shape (`matrix-alias-directory.ts`): 3–32, a letter first. */
const HANDLE = /^[a-z][a-z0-9_]{2,31}$/u

/** The part of a Matrix ID before the server (`@minh:atum.chat` → `minh`); '' otherwise. */
function matrixLocalpart(userId: string): string {
  return /^@([^:]+):/u.exec(userId)?.[1] ?? ''
}

/** Whether a Matrix ID is one of Atum's opaque, allocated IDs. */
export function isOpaqueMatrixId(userId: string): boolean {
  return OPAQUE_LOCALPART.test(matrixLocalpart(userId))
}

/** A handle as the directory spells it, or undefined for anything else. */
export function validMatrixHandle(handle: string | undefined): string | undefined {
  return handle && HANDLE.test(handle) ? handle : undefined
}

function server(userId: string | undefined): string | undefined {
  const at = userId?.indexOf(':') ?? -1

  return at > 0 ? userId!.slice(at + 1) : undefined
}

/** Someone on another homeserver than the signed-in person (unknown owner: not remote). */
export function isRemoteMatrixUser(userId: string, ownerUserId?: string): boolean {
  const own = server(ownerUserId)

  return Boolean(own) && server(userId) !== own
}

/**
 * The name someone set, as a person reads it, or undefined when they set none. The SDK
 * reports a missing name as the Matrix ID, adds " (@id)" to a name two members share, and
 * MAS used to fall back to the localpart; none of those is a name.
 */
export function matrixPersonName(raw: string | undefined, userId: string): string | undefined {
  let name = raw?.trim()

  if (!name) {
    return undefined
  }

  const suffix = ` (${userId})`

  if (name.endsWith(suffix)) {
    name = name.slice(0, -suffix.length).trim()
  }

  if (!name || name === userId || name === matrixLocalpart(userId) && isOpaqueMatrixId(userId)) {
    return undefined
  }

  // A "name" that is somebody's opaque ID (or only IDs) is still not a name.
  return name.replace(OPAQUE_ID_IN_TEXT, '').replace(/[\s,()]/gu, '') ? name : undefined
}

/** A room name as the chat list may show it. The SDK names an unnamed chat after its
 * members, using a member's ID when they set no name and adding " (@id)" to a shared one:
 * the suffixes go, and a name still built from an ID is no name (the chat list then says
 * "Untitled chat" and the people list leaves the person out). */
export function matrixReadableRoomName(name: string): string {
  const cleaned = name.replace(/\s*\(@(?:user|agent|app|service|system)-[0-9a-f]{16,}:[^\s,()]+\)/gu, '')

  return cleaned.match(OPAQUE_ID_IN_TEXT) ? '' : cleaned
}

export interface MatrixPersonLabel {
  /** What to call them: their name, else their @handle, else a readable legacy ID, else
   * the caller's word for someone unnamed. Never an opaque ID. */
  name: string
  /** A second line or suffix: their @handle beside a name, or another server's full address. */
  address?: string
}

/**
 * A person as people see them. `handle` is only ever a directory-verified handle for this
 * exact Matrix ID; `unnamed` is the localized word for someone with no name ("Atum user").
 */
export function matrixPersonLabel({
  handle,
  name: raw,
  ownerUserId,
  unnamed,
  userId
}: {
  handle?: string
  name?: string
  ownerUserId?: string
  unnamed: string
  userId: string
}): MatrixPersonLabel {
  const name = matrixPersonName(raw, userId)

  if (isRemoteMatrixUser(userId, ownerUserId)) {
    return name ? { name, address: userId } : { name: userId }
  }

  const verified = validMatrixHandle(handle)

  if (name) {
    return verified ? { name, address: `@${verified}` } : { name }
  }

  if (verified) {
    return { name: `@${verified}` }
  }

  // An early readable ID (`@minh:…`) still reads as a name; it is not shown as a handle,
  // because the directory may give that handle to someone else.
  const local = matrixLocalpart(userId)

  return { name: local && !isOpaqueMatrixId(userId) ? local : unnamed }
}

/**
 * A short, stable mark that tells apart two people who share a name and have no verified
 * handle: four characters of their ID's random part, never the ID itself.
 */
export function matrixPersonTag(userId: string): string {
  const local = matrixLocalpart(userId)
  const random = local.slice(local.indexOf('-') + 1)

  return isOpaqueMatrixId(userId) ? `#${random.slice(0, 4)}` : local
}

export interface MatrixPeopleContext {
  /** Directory-verified handles by Matrix ID (`person-handles.ts`). */
  handles?: Readonly<Record<string, string>>
  /** Everyone in the chat, to tell apart two people who share a name. */
  members?: readonly Pick<MatrixMember, 'name' | 'userId'>[]
  ownerUserId?: string
  unnamed: string
}

/**
 * A member of a chat: their label, and whether another member shows the same name. Two
 * people sharing a name are told apart by @handle, else by a short mark.
 */
export function matrixMemberLabel(
  member: Pick<MatrixMember, 'name' | 'userId'>,
  { handles, members, ownerUserId, unnamed }: MatrixPeopleContext
): MatrixPersonLabel & { shared: boolean } {
  const label = (value: Pick<MatrixMember, 'name' | 'userId'>) =>
    matrixPersonLabel({ handle: handles?.[value.userId], name: value.name, ownerUserId, unnamed, userId: value.userId })

  const own = label(member)
  const shared = Boolean(members?.some(other => other.userId !== member.userId && label(other).name === own.name))

  return shared && !own.address ? { ...own, address: matrixPersonTag(member.userId), shared } : { ...own, shared }
}

/**
 * One line for a person in a transcript, a typing line or a reply: their name, with their
 * @handle (or a short mark) only when another member shares that name, and another
 * server's address always.
 */
export function matrixPersonLine(userId: string, context: MatrixPeopleContext): string {
  const member = context.members?.find(value => value.userId === userId) ?? { userId, name: '' }
  const label = matrixMemberLabel(member, context)

  return label.address && (label.shared || isRemoteMatrixUser(userId, context.ownerUserId))
    ? `${label.name} (${label.address})`
    : label.name
}
