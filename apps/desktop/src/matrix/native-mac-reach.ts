import { useCallback, useEffect, useState } from 'react'

import type { MatrixNativeMacBridge, MatrixNativeSshAction, MatrixNativeSshView } from '../../shared/matrix-native-mac'
import type { MatrixNativeMacCopy } from '../../shared/matrix-native-mac-copy'

/**
 * Native Hermes reaching this Mac, as this Mac's row in Settings › Connections › Your Macs says it.
 * Setup is automatic (main enrolls, keeps the tunnel and the keys); the row speaks only when the
 * owner has something to do, with one line and one action. Connected is the row's quiet Ready.
 */
export interface MatrixNativeMacLine {
  help: string
  action: { label: string; run: MatrixNativeSshAction }
}

export interface MatrixNativeMacFacts {
  view?: MatrixNativeSshView
  /** The administrator prompt did not turn Remote Login on: the way left is System Settings. */
  manual: boolean
}

/** The one line and action, or null when nothing needs the owner. */
export function matrixNativeMacLine(
  facts: MatrixNativeMacFacts,
  copy: MatrixNativeMacCopy
): MatrixNativeMacLine | null {
  const words = copy.mac

  switch (facts.view?.status) {
    case 'needs_remote_login':
      return facts.manual
        ? { help: words.remoteLoginManual, action: { label: words.openSettings, run: 'open_settings' } }
        : { help: words.remoteLogin, action: { label: words.allow, run: 'enable_remote_login' } }

    case 'needs_full_disk_access_hint':
      return { help: words.fullDisk, action: { label: words.openSettings, run: 'open_settings' } }

    case 'tunnel_down':
      return { help: words.unreachable, action: { label: words.tryAgain, run: 'connect' } }

    case 'error':
      return { help: words.unreachable, action: { label: words.tryAgain, run: 'connect' } }

    default:
      return null
  }
}

/** Read the setup result on entry, after actions and when the window regains focus. */
export function useMatrixNativeMac(
  active: boolean,
  bridge: MatrixNativeMacBridge | undefined = window.atumMatrix?.nativeMac
): MatrixNativeMacFacts & { busy: boolean; run(action: MatrixNativeSshAction): void } {
  const [result, setResult] = useState<MatrixNativeMacFacts>({ manual: false })
  const [busy, setBusy] = useState(false)

  const run = useCallback(
    (action: MatrixNativeSshAction) => {
      if (!active || !bridge) {
        return
      }

      setBusy(true)
      void bridge
        .ssh(action)
        .then(
          view => setResult({ view, manual: action === 'enable_remote_login' && view.status === 'needs_remote_login' }),
          () => setResult(previous => ({ ...previous, manual: action === 'enable_remote_login' }))
        )
        .finally(() => setBusy(false))
    },
    [active, bridge]
  )

  useEffect(() => {
    if (!active || !bridge) {
      return
    }

    let live = true
    void bridge.ssh('status').then(
      view => {
        if (live) {
          setResult({ view, manual: false })
        }
      },
      () => undefined
    )
    const refresh = () => run('connect')
    window.addEventListener('focus', refresh)

    return () => {
      live = false
      window.removeEventListener('focus', refresh)
    }
  }, [active, bridge, run])

  return { ...result, busy, run }
}
