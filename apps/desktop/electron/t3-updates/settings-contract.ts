import type { AtumUpdateChannel } from '../../shared/atum-update-flow'

export interface DesktopUpdateSettings {
  migrate(currentVersion: string): Promise<{
    applied: { from_version: string; to_version: string } | null
    channel: AtumUpdateChannel
    deferred?: boolean
  }>
  getChannel(): Promise<unknown>
  setChannel(channel: AtumUpdateChannel): Promise<void>
}

export interface DesktopUpdateNotes {
  read(version: string, locale: string): Promise<unknown>
}
