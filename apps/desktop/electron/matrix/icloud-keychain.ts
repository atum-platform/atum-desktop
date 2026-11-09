import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

/**
 * The person's recovery key in iCloud Keychain, through the Atum Keys helper
 * (native/atum-keys,  WS-D): a new Mac on the same
 * Apple ID with Passwords & Keychain sync on unlocks by itself. iCloud Keychain is end-to-end
 * encrypted: neither Apple nor Atum can read the item.
 *
 * - The helper exists only in a build that had its provisioning profile; without it, or when its
 *   probe fails (`unprovisioned`, `locked`), this is simply unavailable and the key stays in this
 *   Mac's vault alone.
 * - One JSON request on the helper's stdin (the key never goes on a command line), one answer,
 *   five seconds at most. Values are never logged.
 * - `remove` removes the item on every device of that Apple ID: only the person's own choice
 *   (Settings) does it, never "forget the key on this Mac".
 */
/** `caller`: the helper refused the process that ran it (only Atum itself may read, write or remove
 * the key; native/atum-keys/main.swift). */
export type MatrixKeychainCode =
  | 'unprovisioned'
  | 'locked'
  | 'not_found'
  | 'invalid'
  | 'error'
  | 'caller'
  | 'unavailable'

export type MatrixKeychainAnswer = { ok: true; value?: string } | { ok: false; code: MatrixKeychainCode }

export type MatrixKeychainRequest =
  | { op: 'probe' }
  | { op: 'read'; account: string }
  | { op: 'write'; account: string; value: string }
  | { op: 'remove'; account: string }

const CODES = new Set<MatrixKeychainCode>(['unprovisioned', 'locked', 'not_found', 'invalid', 'error', 'caller'])
const TIMEOUT_MS = 5_000
const RECOVERY_KEY = /^[A-Za-z0-9 ]{1,256}$/
const KEY_ID = /^[!-~]{1,255}$/

/** Where a packaged app keeps the helper. */
export function matrixKeychainHelper(resourcesPath: string): string {
  return path.join(resourcesPath, 'atum-keys', 'Atum Keys.app', 'Contents', 'MacOS', 'atum-keys')
}

/** Runs the helper once. Never throws: a helper that is missing, slow or garbled is `unavailable`. */
export function runMatrixKeychain(
  helper: string,
  request: MatrixKeychainRequest,
  timeoutMs = TIMEOUT_MS
): Promise<MatrixKeychainAnswer> {
  return new Promise(resolve => {
    let settled = false
    let output = ''

    const finish = (answer: MatrixKeychainAnswer) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        resolve(answer)
      }
    }

    let child: ReturnType<typeof spawn>

    try {
      child = spawn(helper, [], { stdio: ['pipe', 'pipe', 'ignore'] })
    } catch {
      finish({ ok: false, code: 'unavailable' })

      return
    }

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ ok: false, code: 'unavailable' })
    }, timeoutMs)

    child.on('error', () => finish({ ok: false, code: 'unavailable' }))
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', chunk => {
      output += chunk

      if (output.length > 16_384) {
        child.kill('SIGKILL')
        finish({ ok: false, code: 'unavailable' })
      }
    })
    child.on('close', () => {
      try {
        const answer = JSON.parse(output) as { ok?: unknown; value?: unknown; code?: unknown }

        if (answer?.ok === true) {
          finish(typeof answer.value === 'string' ? { ok: true, value: answer.value } : { ok: true })
        } else {
          finish({
            ok: false,
            code: CODES.has(answer?.code as MatrixKeychainCode) ? (answer.code as MatrixKeychainCode) : 'error'
          })
        }
      } catch {
        finish({ ok: false, code: 'unavailable' })
      }
    })
    child.stdin?.on('error', () => {})
    child.stdin?.end(JSON.stringify(request))
  })
}

export interface MatrixICloudKeychainOptions {
  /** The helper's executable, when this build has one. */
  helper?: string
  run?: typeof runMatrixKeychain
  exists?: (file: string) => boolean
  log?: (line: string) => void
}

/** The kept key's iCloud copy for one Matrix user. */
export class MatrixICloudKeychain {
  private probe?: Promise<boolean>

  constructor(private readonly options: MatrixICloudKeychainOptions) {}

  private run(request: MatrixKeychainRequest) {
    return (this.options.run ?? runMatrixKeychain)(this.options.helper!, request)
  }

  /** The helper is here and its keychain group is reachable (asked once per launch). */
  available(): Promise<boolean> {
    const helper = this.options.helper

    if (!helper || !(this.options.exists ?? existsSync)(helper)) {
      return Promise.resolve(false)
    }

    this.probe ??= this.run({ op: 'probe' }).then(answer => {
      this.options.log?.(
        `[Matrix] icloud keychain ${answer.ok === true ? 'available' : `unavailable code=${answer.code}`}`
      )

      return answer.ok
    })

    return this.probe
  }

  async read(userId: string): Promise<{ key: string; keyId?: string } | undefined> {
    if (!(await this.available())) {
      return undefined
    }

    const answer = await this.run({ op: 'read', account: userId })

    if (!answer.ok || !answer.value) {
      return undefined
    }

    try {
      const value = JSON.parse(answer.value) as { v?: unknown; key?: unknown; keyId?: unknown }

      if (value?.v !== 1 || typeof value.key !== 'string' || !RECOVERY_KEY.test(value.key)) {
        return undefined
      }

      return {
        key: value.key,
        ...(typeof value.keyId === 'string' && KEY_ID.test(value.keyId) ? { keyId: value.keyId } : {})
      }
    } catch {
      return undefined
    }
  }

  async write(userId: string, key: string, keyId?: string): Promise<boolean> {
    if (!RECOVERY_KEY.test(key) || !(await this.available())) {
      return false
    }

    const answer = await this.run({
      op: 'write',
      account: userId,
      value: JSON.stringify({ v: 1, key, ...(keyId ? { keyId } : {}) })
    })

    this.options.log?.(
      `[Matrix] icloud keychain write ok=${answer.ok}${answer.ok === true ? '' : ` code=${answer.code}`}`
    )

    return answer.ok
  }

  /** Removes the item on every device of this Apple ID. */
  async remove(userId: string): Promise<boolean> {
    if (!(await this.available())) {
      return false
    }

    const answer = await this.run({ op: 'remove', account: userId })
    this.options.log?.(`[Matrix] icloud keychain remove ok=${answer.ok}`)

    return answer.ok
  }
}
