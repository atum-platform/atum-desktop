import type { PetInfo, PetState } from './pet'
import type { AtumPetChatTurn } from './pet-chat/atum-pet-chat'

/** Private bundled renderer: no agent/room identity, chats, files or native bounds. */
export interface MatrixPetOverlaySnapshot {
  sprite: PetInfo
  locale: 'vi' | 'en' | 'ja' | 'zh' | 'zh-hant'
  intent: { pose: PetState; mirror: boolean; direction: -1 | 0 | 1; paused: boolean }
  size: { width: number; height: number; zoom: number }
  bubble?: { kind: 'yourTurn' | 'failed' | 'done' | 'excerpt'; text?: string }
  /** The pet's own newest turns; never the agent room's messages. */
  recent: AtumPetChatTurn[]
  /** Turns answered this session that the history does not hold yet (the answer to a first
   * chat, or the platform's fallback). Shown after `recent`; never stored. */
  unsaved: AtumPetChatTurn[]
  chatOpen: boolean
  dark?: boolean
}

export type MatrixPetOverlayAction =
  | 'chat'
  | 'wave'
  | 'sit'
  | 'lounge'
  | 'hide'
  | 'change'
  | 'size'
  | 'store'
  | 'settings'

export const MATRIX_PET_OVERLAY_IPC = {
  snapshot: 'matrix:pet-overlay:snapshot',
  drag: 'matrix:pet-overlay:drag',
  click: 'matrix:pet-overlay:click',
  menu: 'matrix:pet-overlay:menu',
  popIn: 'matrix:pet-overlay:pop-in',
  setInteractive: 'matrix:pet-overlay:interactive',
  submit: 'matrix:pet-overlay:submit'
} as const

export interface MatrixPetOverlayBridge {
  onSnapshot(callback: (snapshot: MatrixPetOverlaySnapshot) => void): () => void
  drag(phase: 'start' | 'end'): Promise<void>
  click(): Promise<void>
  menu(action: MatrixPetOverlayAction): Promise<void>
  popIn(): Promise<void>
  setInteractive(value: boolean): Promise<void>
  submit(text: string): Promise<void>
}
