export const MAC_MESSAGE_USAGE =
  "paraphrase only; never quote; never store others' words or private details"

export type MacKnowledgeSource = 'google' | 'folders' | 'messages' | 'browser' | 'location' | 'teamSpaces'
export type MacSourcePermission = 'full_disk' | 'location'
export type MacSourceErrorCode = 'disabled' | 'invalid' | 'permission_needed' | 'unavailable'

export interface MacSourceError {
  error: MacSourceErrorCode
  permission?: MacSourcePermission
}

export interface MacSourceConsentSnapshot {
  google: boolean
  folders: boolean
  messages: boolean
  browser: boolean
  location: boolean
  teamSpaces: boolean
}

export interface MacMessageConversation {
  id: string
  title: string
  participants: Array<{ name?: string; handle?: string }>
  isGroup: boolean
  lastActivity: string
  messageCount: number
  fromMeShare: number
}

export interface MacMessage {
  fromMe: boolean
  sender: string
  at: string
  text: string
}

export interface MacBrowserHistoryEntry {
  browser: 'safari' | 'chrome'
  title: string
  domain: string
  path: string
  lastVisit: string
  visits: number
}

export interface MacCityLocation {
  city?: string
  region?: string
  country?: string
  timeZone: string
  lat?: number
  lon?: number
  accuracyMeters?: number
}

export type MacSourcesResult =
  | MacSourceError
  | { conversations: MacMessageConversation[]; usage: typeof MAC_MESSAGE_USAGE }
  | {
      messages: MacMessage[]
      usage: typeof MAC_MESSAGE_USAGE
      omittedAttributedBodies: number
    }
  | { history: MacBrowserHistoryEntry[]; permissionNeeded?: MacSourcePermission[] }
  | MacCityLocation

export const disabledResult = (): MacSourceError => ({ error: 'disabled' })
export const invalidResult = (): MacSourceError => ({ error: 'invalid' })
export const unavailableResult = (): MacSourceError => ({ error: 'unavailable' })
export const permissionResult = (permission: MacSourcePermission): MacSourceError => ({
  error: 'permission_needed',
  permission
})
