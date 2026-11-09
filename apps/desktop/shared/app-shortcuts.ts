/** Display intent only, never an app grant, room membership or installation. */
export type AppShortcutVisibility = 'shown' | 'hidden'
export interface AppShortcutState {
  visibility: AppShortcutVisibility | 'default' | 'unknown'
  status: 'ready' | 'loading' | 'readonly' | 'saving' | 'unconfirmed' | 'failed'
}
export const APP_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
