// RETIRED legacy wallet (pre-Matrix app): read-only wallet and rewards IPC; the desktop checkout channels were removed 2026-10-05.
import type { AtumProtonsService } from './atum-protons'

interface IpcMainLike {
  handle(channel: string, listener: (_event: unknown, ...args: unknown[]) => unknown): void
  removeHandler?(channel: string): void
}

export interface AtumProtonsIpcAuthority {
  assertTrustedSender(event: unknown): void
}

export const ATUM_PROTONS_IPC_CHANNELS = [
  'atum:protons:wallet',
  'atum:protons:rewards',
  'atum:protons:rewards:claim'
] as const

export function registerAtumProtonsIpc(
  ipc: IpcMainLike,
  service: AtumProtonsService,
  authority: AtumProtonsIpcAuthority
): () => void {
  ipc.handle('atum:protons:rewards', event => {
    authority.assertTrustedSender(event)

    return service.rewards()
  })
  ipc.handle('atum:protons:rewards:claim', (event, kind) => {
    authority.assertTrustedSender(event)

    if (kind !== 'email' && kind !== 'calendar') { throw new Error('proton_reward_invalid') }

    return service.claimConnectionReward(kind)
  })
  ipc.handle('atum:protons:wallet', event => {
    authority.assertTrustedSender(event)

    return service.wallet()
  })

  return () => ATUM_PROTONS_IPC_CHANNELS.forEach(channel => ipc.removeHandler?.(channel))
}
