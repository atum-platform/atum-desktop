export interface AppBotAudienceMember {
  userId: string
  membership: string
}

export const APP_BOT_AUDIENCE_CHANGED = 'matrix_app_bot_audience_changed' as const
export const APP_BOT_AUDIENCE_UNKNOWN = 'matrix_app_bot_audience_unknown' as const

export type AppBotAudienceFailureCode =
  | typeof APP_BOT_AUDIENCE_CHANGED
  | typeof APP_BOT_AUDIENCE_UNKNOWN

export class AppBotAudienceError extends Error {
  constructor(readonly code: AppBotAudienceFailureCode) {
    super(code)
    this.name = 'AppBotAudienceError'
  }
}

export const appBotPerson = (userId: string) =>
  /^@(?!(?:agent|app|service|system)-)[^:\s]+:atumplatform\.com$/u.test(userId)

/**
 * Return the only person this room can still be treated as a direct audience for.
 * Matrix retains departed membership state, so any historical third identity keeps
 * the room from silently becoming a different person's DM later.
 */
export function appBotDirectPerson(
  members: readonly AppBotAudienceMember[],
  botUserId: string
): string | undefined {
  const people = members.filter(member => member.userId !== botUserId && appBotPerson(member.userId))
  const other = members.some(member => member.userId !== botUserId && !appBotPerson(member.userId))
  return !other && people.length === 1 && ['join', 'invite'].includes(people[0]!.membership)
    ? people[0]!.userId
    : undefined
}

export function appBotDirectSafe(
  members: readonly AppBotAudienceMember[],
  botUserId: string,
  intendedPerson: string
): boolean {
  return appBotDirectPerson(members, botUserId) === intendedPerson
}
