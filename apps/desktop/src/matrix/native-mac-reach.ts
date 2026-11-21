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
  /** The quiet way back to a fresh Connect, beside the fix, only where a route may be left behind. */
  reset?: { label: string; run: MatrixNativeSshAction }
}

export interface MatrixNativeMacFacts {
  view?: MatrixNativeSshView
  /** The administrator prompt did not turn Remote Login on: the way left is System Settings. */
  manual: boolean
}

type FailureWord = 'recovery' | 'cleanup' | 'files' | 'helper' | 'details'

/** Safe codes we know in plain words; anything else names the step it stopped at. */
const FAILURE_WORD: Record<string, FailureWord> = {
  native_ssh_route_recovery_required: 'recovery',
  native_ssh_cleanup_pending: 'cleanup',
  native_ssh_file_failed: 'files',
  native_ssh_symlink: 'files',
  EACCES: 'files',
  EPERM: 'files',
  EROFS: 'files',
  ENOENT: 'helper',
  invalid_keys: 'details',
  invalid_prepare: 'details',
  invalid_host: 'details',
  invalid_device: 'details',
  invalid_ssh_key: 'details',
  invalid_ssh_block: 'details',
  invalid_relay_key: 'details',
  relay_shell_key_collision: 'details',
  // The account refused the key list a purpose-aware setup needs.
  device_registry_400_invalid: 'details'
}

export function matrixNativeMacFailureLine(
  view: MatrixNativeSshView | undefined,
  copy: MatrixNativeMacCopy
): string {
  const words = copy.mac
  const word = view?.code ? FAILURE_WORD[view.code] : undefined

  if (word) {
    return words.failure[word]
  }

  const step = view?.step ? words.failure.steps[view.step] : undefined

  return step ? words.failure.atStep(step, view?.code) : words.unreachable
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

    case 'not_connected':
      return { help: words.notConnected, action: { label: words.connect, run: 'connect' } }

    case 'tunnel_down':
      return { help: words.unreachable, action: { label: words.tryAgain, run: 'connect' } }

    case 'error':
      return {
        help: matrixNativeMacFailureLine(facts.view, copy),
        action: { label: words.tryAgain, run: 'connect' },
        reset: { label: words.disconnect, run: 'disconnect' }
      }

    default:
      return null
  }
}

/**
 * Read the setup result on entry, after actions and when the window regains focus. Focus never
 * reconnects a Mac the owner just disconnected: only Connect does that.
 */
export function useMatrixNativeMac(
  active: boolean,
  bridge: MatrixNativeMacBridge | undefined = window.atumMatrix?.nativeMac
): MatrixNativeMacFacts & { busy: boolean; running?: MatrixNativeSshAction; run(action: MatrixNativeSshAction): void } {
  const [result, setResult] = useState<MatrixNativeMacFacts>({ manual: false })
  const [running, setRunning] = useState<MatrixNativeSshAction>()
  const disconnected = useRef(false)

  const take = useCallback((view: MatrixNativeSshView | undefined, action?: MatrixNativeSshAction) => {
    if (action === 'connect') {
      // Connect is the one way back from a disconnect, whatever it answers.
      disconnected.current = false
    } else if (action === 'disconnect' || !action) {
      disconnected.current = view?.status === 'not_connected'
    }

    setResult(previous =>
      view
        ? { view, manual: action === 'enable_remote_login' && view.status === 'needs_remote_login' }
        : { ...previous, manual: action === 'enable_remote_login' }
    )
  }, [])

  const run = useCallback(
    (action: MatrixNativeSshAction) => {
      if (!active || !bridge) {
        return
      }

      setRunning(action)
      void bridge
        .ssh(action)
        .then(
          view => take(view, action),
          async () => {
            // Main answers a failed action with its error; the status it now holds is the reason.
            take(await bridge.ssh('status').catch(() => undefined), action)
          }
        )
        .finally(() => setRunning(undefined))
    },
    [active, bridge, take]
  )

  useEffect(() => {
    if (!active || !bridge) {
      return
    }

    let live = true
    void bridge.ssh('status').then(
      view => {
        if (live) {
          take(view)
        }
      },
      () => undefined
    )

    const refresh = () => {
      if (!disconnected.current) {
        run('connect')
      }
    }

    window.addEventListener('focus', refresh)

    return () => {
      live = false
      window.removeEventListener('focus', refresh)
    }
  }, [active, bridge, run, take])

  return { ...result, busy: running !== undefined, running, run }
}
