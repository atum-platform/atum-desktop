import { useCallback, useEffect, useRef, useState } from 'react'

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
  /** A tunnel-down read that is not the service's first word (it starts down until its first refresh). */
  settled: boolean
  /** The administrator prompt did not turn Remote Login on: the way left is System Settings. */
  manual: boolean
}

/** The one line and action, or null when nothing needs the owner. */
export function matrixNativeMacLine(facts: MatrixNativeMacFacts, copy: MatrixNativeMacCopy): MatrixNativeMacLine | null {
  const words = copy.mac

  switch (facts.view?.status) {
    case 'needs_remote_login':
      return facts.manual
        ? { help: words.remoteLoginManual, action: { label: words.openSettings, run: 'open_settings' } }
        : { help: words.remoteLogin, action: { label: words.allow, run: 'enable_remote_login' } }

    case 'needs_full_disk_access_hint':
      return { help: words.fullDisk, action: { label: words.openSettings, run: 'open_settings' } }

    case 'tunnel_down':
      return facts.settled ? { help: words.unreachable, action: { label: words.tryAgain, run: 'connect' } } : null

    case 'error':
      return { help: words.unreachable, action: { label: words.tryAgain, run: 'connect' } }

    default:
      return null
  }
}

/** How often an open Connections page re-reads the state (main refreshes every minute). */
const READ_MS = 15_000

/** This Mac's native reach while `active`; nothing at all where main offers none (another OS, signed out). */
export function useMatrixNativeMac(
  active: boolean,
  bridge: MatrixNativeMacBridge | undefined = window.atumMatrix?.nativeMac
): MatrixNativeMacFacts & { busy: boolean; run(action: MatrixNativeSshAction): void } {
  const [view, setView] = useState<MatrixNativeSshView>()
  const [settled, setSettled] = useState(false)
  const [manual, setManual] = useState(false)
  const [busy, setBusy] = useState(false)
  const reads = useRef(0)

  useEffect(() => {
    if (!active || !bridge) {
      return
    }

    let live = true

    const read = () =>
      void bridge.ssh('status').then(
        next => {
          if (live) {
            reads.current += 1
            setView(next)
            setSettled(reads.current > 1)
          }
        },
        () => undefined
      )

    read()
    const timer = setInterval(read, READ_MS)

    return () => {
      live = false
      clearInterval(timer)
    }
  }, [active, bridge])

  const run = useCallback(
    function run(action: MatrixNativeSshAction): void {
      if (!bridge) {
        return
      }

      setBusy(true)
      void bridge
        .ssh(action)
        .then(
          next => {
            setView(next)
            // An explicit action's answer is the state after a real refresh.
            setSettled(true)

            if (action === 'enable_remote_login' && next.status === 'needs_remote_login') {
              setManual(true)
            }

            // Back from System Settings, check again at once rather than at the next minute.
            if (action === 'open_settings') {
              window.addEventListener('focus', () => run('connect'), { once: true })
            }
          },
          () => {
            if (action === 'enable_remote_login') {
              setManual(true)
            }
          }
        )
        .finally(() => setBusy(false))
    },
    [bridge]
  )

  return { view, settled, manual, busy, run }
}
