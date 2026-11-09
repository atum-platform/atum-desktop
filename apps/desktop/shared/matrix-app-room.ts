/** Immutable m.room.create metadata, not an app-account permission grant. */
export const MATRIX_APP_GROUP_TYPE = 'io.atum.app_group.v1'
export const MATRIX_APP_GROUP_BINDING = 'io.atum.app_group'

export function appGroupBinding(content: Record<string, unknown>, sender?: string) {
  const binding = content[MATRIX_APP_GROUP_BINDING]

  if (content.type !== MATRIX_APP_GROUP_TYPE || !sender || !binding || typeof binding !== 'object') {
    return undefined
  }

  const app: unknown = Reflect.get(binding, 'app')

  return typeof app === 'string' && /^@[^\s:]+:[^\s]+$/.test(app) && app !== sender ? { owner: sender, app } : undefined
}
