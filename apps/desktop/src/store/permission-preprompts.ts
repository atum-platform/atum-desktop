import { atom } from 'nanostores'

import { persistString, storedString } from '@/lib/storage'

export type AtumPermissionPrompt =
  | { kind: 'notifications'; onConfirm: () => void }
  | { folderName: string; kind: 'files'; onConfirm: () => void }

const NOTIFICATION_SHOWN_KEY = 'hermes.desktop.atum.permissions.notificationsPrompted'
const DEFERRED = import.meta.env.ATUM_DEMO_DEFER_PERMISSIONS === '1'
let sequenceActive = false
let notificationsArmed = false

export const $atumPermissionPrompt = atom<AtumPermissionPrompt | null>(null)

export type PrePromptDecision = 'blocked' | 'not-needed' | 'shown'

export function setAtumPermissionSequenceActive(active: boolean): void {
  sequenceActive = active
}

export function armNotificationPermissionPrompt(): void {
  notificationsArmed = true
}

export function requestNotificationPrePrompt(onConfirm: () => void): PrePromptDecision {
  if (!sequenceActive || storedString(NOTIFICATION_SHOWN_KEY) === 'true') {return 'not-needed'}

  if (DEFERRED || !notificationsArmed || $atumPermissionPrompt.get()) {return 'blocked'}
  $atumPermissionPrompt.set({ kind: 'notifications', onConfirm })
  notificationsArmed = false

  return 'shown'
}

export function requestFileAccessPrePrompt(folderName: string, onConfirm: () => void): boolean {
  if (!sequenceActive || DEFERRED || $atumPermissionPrompt.get()) {return false}
  $atumPermissionPrompt.set({ folderName, kind: 'files', onConfirm })

  return true
}

export function resolveAtumPermissionPrompt(confirmed: boolean): void {
  const prompt = $atumPermissionPrompt.get()

  if (!prompt) {return}

  $atumPermissionPrompt.set(null)

  if (prompt.kind === 'notifications') {persistString(NOTIFICATION_SHOWN_KEY, 'true')}

  if (confirmed) {prompt.onConfirm()}
}
