import type { MatrixMember, MatrixMessage } from '../../shared/matrix'

import { matrixMemberLabel, type MatrixPeopleContext } from './person-name'

const MATRIX_USER_ID = /^@[^:\s]+:[^\s]+$/u
const SYSTEM_LOCALPART = /^@(agent|app|service|system)-/u
const ROOM_TOKENS = ['@channel', '@room'] as const

export interface MatrixHumanMention {
  avatarMxc?: string | null
  /** Their directory-verified @handle (without the @), shown under the name in the menu. */
  handle?: string
  name: string
  token: string
  userId: string
}

export interface MatrixMentionMatch {
  end: number
  query: string
  start: number
}

export interface MatrixMentionMarkdown {
  labels: ReadonlyMap<string, string>
  text: string
}

/** One `@query` immediately before the caret. A newline starts a fresh query. */
export function matrixMentionMatch(text: string, cursor = text.length): MatrixMentionMatch | null {
  const before = text.slice(0, cursor)
  const match = /(^|\s)@([^@\n]*)$/u.exec(before)

  if (!match) {
    return null
  }

  return {
    start: cursor - match[2]!.length - 1,
    end: cursor,
    query: match[2]!.trim().toLocaleLowerCase()
  }
}

/** Humans currently in this room, people first and stable by their visible name. Service,
 * app and agent identities are deliberately absent; their existing addressing paths remain. */
export function matrixHumanMentions({
  excluded,
  locale,
  members,
  people
}: {
  excluded: ReadonlySet<string>
  locale: string
  members: readonly MatrixMember[] | undefined
  people: MatrixPeopleContext
}): MatrixHumanMention[] {
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' })

  return (members ?? [])
    .filter(
      member =>
        member.membership === 'join' &&
        member.userId !== people.ownerUserId &&
        !excluded.has(member.userId) &&
        !SYSTEM_LOCALPART.test(member.userId)
    )
    .map(member => {
      const label = matrixMemberLabel(member, people)
      const handle = people.handles?.[member.userId]

      return {
        userId: member.userId,
        name: label.address && label.shared ? `${label.name} (${label.address})` : label.name,
        token: `@${handle ?? label.name}`,
        avatarMxc: member.avatarMxc,
        ...(handle ? { handle } : {})
      }
    })
    .filter(candidate => candidate.name.trim() && candidate.token.length > 1)
    .sort(
      (left, right) =>
        collator.compare(left.name, right.name) ||
        (left.userId < right.userId ? -1 : left.userId > right.userId ? 1 : 0)
    )
}

export function filterMatrixHumanMentions(
  candidates: readonly MatrixHumanMention[],
  query: string
): MatrixHumanMention[] {
  const wanted = query.trim().replace(/^@/u, '').toLocaleLowerCase()

  return candidates.filter(candidate => {
    const name = candidate.name.toLocaleLowerCase()
    const token = candidate.token.slice(1).toLocaleLowerCase()

    return !wanted || name.includes(wanted) || token.includes(wanted)
  })
}

export function insertMatrixMention(text: string, match: MatrixMentionMatch, token: string): string {
  return `${text.slice(0, match.start)}${token} ${text.slice(match.end)}`
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function tokenPattern(token: string): RegExp {
  return new RegExp(`(^|[\\s([{])(${escaped(token)})(?=$|[\\s.,!?;:)\\]}])`, 'iu')
}

export function containsMatrixMention(text: string, token: string): boolean {
  return tokenPattern(token).test(text)
}

/** Selected identities remain exact when two people share a name. A uniquely named token also
 * works when typed rather than picked, matching the existing agent/CoS affordance. */
export function matrixHumanMentionUserIds(
  text: string,
  candidates: readonly MatrixHumanMention[],
  selected: ReadonlySet<string>
): string[] {
  const counts = new Map<string, number>()

  for (const candidate of candidates) {
    const key = candidate.token.toLocaleLowerCase()
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  return candidates
    .filter(candidate => {
      if (!containsMatrixMention(text, candidate.token)) {
        return false
      }

      return selected.has(candidate.userId) || counts.get(candidate.token.toLocaleLowerCase()) === 1
    })
    .map(candidate => candidate.userId)
}

export function matrixRoomMentionRequested(text: string, allowed: boolean): boolean {
  return allowed && containsMatrixMention(text, '@channel')
}

/** Twenty or more recipients is deliberately a speed bump, not a setting or enrollment flow. */
export const MATRIX_ROOM_MENTION_CONFIRM_AT = 20

export function matrixRoomMentionNeedsConfirmation(roomMention: boolean, audience: number): boolean {
  return roomMention && audience >= MATRIX_ROOM_MENTION_CONFIRM_AT
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

/** Strict, bounded display projection of standard `m.mentions`. */
export function matrixMentionProjection(value: unknown): MatrixMessage['mentions'] | undefined {
  if (!object(value)) {
    return undefined
  }

  const rawIds = value.user_ids

  const ids = Array.isArray(rawIds)
    ? [...new Set(rawIds.filter((id): id is string => typeof id === 'string' && MATRIX_USER_ID.test(id)))].slice(0, 100)
    : []

  const room = value.room === true

  return ids.length || room ? { userIds: ids, room } : undefined
}

function markdownLabel(value: string): string {
  return value.replace(/([\\[\]])/gu, '\\$1')
}

function matrixTo(id: string): string {
  return `https://matrix.to/#/${encodeURIComponent(id)}`
}

function replaceOutsideCode(text: string, replace: (plain: string) => string): string {
  let output = ''
  let plain = ''
  let index = 0

  while (index < text.length) {
    if (text[index] !== '`') {
      plain += text[index]
      index += 1

      continue
    }

    output += replace(plain)
    plain = ''
    let ticks = 1

    while (text[index + ticks] === '`') {
      ticks += 1
    }

    const marker = '`'.repeat(ticks)
    const close = text.indexOf(marker, index + ticks)

    if (close < 0) {
      plain += text.slice(index)

      break
    }

    output += text.slice(index, close + ticks)
    index = close + ticks
  }

  return output + replace(plain)
}

/** Preserve ordinary markdown while turning only the event's declared mention tokens into
 * inert, host-rendered pills. Code spans/fences stay literal. */
export function matrixMentionMarkdown(
  body: string,
  mentions: MatrixMessage['mentions'],
  people: MatrixPeopleContext,
  roomId: string
): MatrixMentionMarkdown {
  if (!mentions) {
    return { text: body, labels: new Map() }
  }

  const targets: Array<{ id: string; token: string }> = []

  for (const userId of mentions.userIds) {
    const member = people.members?.find(value => value.userId === userId)

    if (!member) {
      continue
    }

    const label = matrixMemberLabel(member, people)
    const handle = people.handles?.[userId]

    if (handle) {
      targets.push({ id: userId, token: `@${handle}` })
    } else if (label.name) {
      targets.push({ id: userId, token: `@${label.name}` })
    }
  }

  if (mentions.room) {
    for (const token of ROOM_TOKENS) {
      targets.push({ id: roomId, token })
    }
  }

  targets.sort((left, right) => right.token.length - left.token.length)
  const labels = new Map<string, string>()
  let rendered = body

  rendered = replaceOutsideCode(rendered, plain => {
    let next = plain

    for (const target of targets) {
      const href = matrixTo(target.id)
      const pattern = tokenPattern(target.token)
      next = next.replace(pattern, (_whole, prefix: string, token: string) => {
        labels.set(href, token)

        return `${prefix}[${markdownLabel(token)}](${href})`
      })
    }

    return next
  })

  return { text: rendered, labels }
}
