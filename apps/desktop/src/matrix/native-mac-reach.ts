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
  // The account refused the key list a purpose-aware setup needs.
  device_registry_400_invalid: 'details'
}

export function matrixNativeMacFailureLine(
  view: MatrixNativeSshView | undefined,
  copy: MatrixNativeMacCopy
): string {
  const words = copy.mac
  const code = view?.code ?? view?.reason
  const word = code && Object.hasOwn(FAILURE_WORD, code) ? FAILURE_WORD[code] : undefined

  const step = view?.step ? words.failure.steps[view.step] : undefined

  if (word) {
    const detail = words.failure[word]

    return step ? `${words.failure.atStep(step)} ${detail}` : detail
  }

  return step ? words.failure.atStep(step, code === 'unknown' ? undefined : code) : words.unreachable
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
      if (facts.view.reason === 'native_ssh_cleanup_pending') {
        return { help: words.failure.cleanup, action: { label: words.disconnect, run: 'disconnect' } }
      }

      return {
        help: matrixNativeMacFailureLine(facts.view, copy),
        action: { label: words.tryAgain, run: 'connect' },
        reset: { label: words.disconnect, run: 'disconnect' }
      }

    default:
      return null
  }
}

/** Status reads: an owner's action waits behind one of these rather than being dropped. */
const QUIET: ReadonlySet<MatrixNativeSshAction> = new Set<MatrixNativeSshAction>(['status', 'refresh'])

/**
 * Read the setup result on entry, after actions and when the window regains focus. Focus never
 * reconnects a Mac the owner just disconnected: only Connect does that.
 */
export function useMatrixNativeMac(
  active: boolean,
  bridge: MatrixNativeMacBridge | undefined = window.atumMatrix?.nativeMac
): MatrixNativeMacFacts & { busy: boolean; running?: MatrixNativeSshAction; run(action: MatrixNativeSshAction): Promise<void> } {
  const [result, setResult] = useState<MatrixNativeMacFacts>({ manual: false })
  const [running, setRunning] = useState<MatrixNativeSshAction>()
  const flight = useRef<{ action: MatrixNativeSshAction; done: Promise<void> } | null>(null)
  const runRef = useRef<(action: MatrixNativeSshAction) => Promise<void>>(() => Promise.resolve())

  const take = useCallback((view: MatrixNativeSshView | undefined, action?: MatrixNativeSshAction) => {
    setResult(previous =>
      view
        ? { view, manual: action === 'enable_remote_login' && view.status === 'needs_remote_login' }
        : { ...previous, manual: action === 'enable_remote_login' }
    )
  }, [])

  /**
   * One action at a time; it settles when main has answered. A second action while one runs waits on it instead of starting:
   * the owner's own action queues behind a quiet status refresh (the window regaining focus after a macOS prompt), and anything
   * else simply shares the running one (a double click starts nothing twice).
   */
  const run = useCallback(
    (action: MatrixNativeSshAction): Promise<void> => {
      if (!active || !bridge) {
        return Promise.resolve()
      }

      const current = flight.current

      if (current) {
        return QUIET.has(current.action) && !QUIET.has(action)
          ? current.done.then(() => runRef.current(action))
          : current.done
      }

      setRunning(action)

      const done = bridge
        .ssh(action)
        .then(
          view => take(view, action),
          async () => {
            // Main answers a failed action with its error; the status it now holds is the reason.
            take(await bridge.ssh('status').catch(() => undefined), action)
          }
        )
        .finally(() => {
          flight.current = null
          setRunning(undefined)
        })

      flight.current = { action, done }

      return done
    },
    [active, bridge, take]
  )

  runRef.current = run

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

    const refresh = () => void run('refresh')

    window.addEventListener('focus', refresh)

    return () => {
      live = false
      window.removeEventListener('focus', refresh)
    }
  }, [active, bridge, run, take])

  return { ...result, busy: running !== undefined, running, run }
}
