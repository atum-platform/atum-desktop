import { ClientEvent, type MatrixClient } from 'matrix-js-sdk'
import { CryptoEvent } from 'matrix-js-sdk/lib/crypto-api'

/** Read-only display availability. Never equate secret storage with message backup. */
export function matrixBackupAvailability(client: MatrixClient, changed: () => void) {
  let active = true
  let generation = 0
  let available = false

  const refresh = () => {
    const request = ++generation
    const current = () => active && request === generation
    void Promise.resolve()
      .then(() => current() ? client.getCrypto()?.getKeyBackupInfo() : undefined)
      .then(info => {
        if (current()) {
          const next = typeof info?.version === 'string' && info.version.length > 0

          if (next !== available) {
            available = next
            changed()
          }
        }
      })
      .catch(() => {
        if (current() && available) {
          available = false
          changed()
        }
      })
  }

  const synced = (state: string) => {
    if (state === 'PREPARED') {refresh()}
  }

  client.on(ClientEvent.Sync, synced)
  client.on(CryptoEvent.KeyBackupStatus, refresh)
  refresh()

  return {
    available: () => available,
    stop() {
      active = false
      generation++
      client.off(ClientEvent.Sync, synced)
      client.off(CryptoEvent.KeyBackupStatus, refresh)
    }
  }
}
