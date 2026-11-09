import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

import { UtilityFailure } from './google'

export interface AppleAdapters {
  available: { calendar: boolean }
  calendar(input: Record<string, unknown>, signal?: AbortSignal): Promise<any>
}

/** No shell, inherited provider secrets, command-line passwords, or stderr logging. */
export function runUtilityHelper(command: string, args: string[], input: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
  const abortCode = () => signal?.reason?.name === 'TimeoutError' ? 'timeout' as const : 'cancelled' as const

  if (signal?.aborted) { return Promise.reject(new UtilityFailure(abortCode())) }

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'en_US.UTF-8' }
    })

    let output = ''
    let failed = false

    const fail = (code: 'timeout' | 'cancelled' | 'unavailable' | 'network') => {
      failed = true
      child.kill()
      reject(new UtilityFailure(code))
    }

    const abort = () => fail(abortCode())
    signal?.addEventListener('abort', abort, { once: true })

    if (signal?.aborted) { abort() }
    const timer = setTimeout(() => fail('timeout'), 90_000)
    child.once('error', () => fail('unavailable'))
    child.stdout.on('data', chunk => {
      output += chunk.toString('utf8')

      if (output.length > 2 * 1024 * 1024) { fail('network') }
    })
    child.stdin.on('error', () => { /* Process failure is settled by error/close. */ })
    child.once('close', code => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)

      if (failed) { return }

      if (code !== 0) {
        reject(new UtilityFailure('unavailable'))

        return
      }

      try {
        const result = JSON.parse(output)

        if (result.error) {
          const allowed = ['reconnect', 'network', 'denied', 'unavailable', 'invalid_input', 'conflict', 'unsupported', 'outcome_unknown']
          reject(new UtilityFailure(allowed.includes(result.error) ? result.error : 'network'))
        } else { resolve(result) }
      } catch { reject(new UtilityFailure('network')) }
    })
    child.stdin.end(JSON.stringify(input))
  })
}

export function createAppleAdapters(calendarHelper: string): AppleAdapters {
  return {
    get available() {
      return {
        calendar: process.platform === 'darwin' && Number(process.getSystemVersion?.()?.split('.')[0] ?? 0) >= 14 && existsSync(calendarHelper)
      }
    },
    calendar: (input, signal) => {
      if (process.platform !== 'darwin' || !existsSync(calendarHelper)) { throw new UtilityFailure('unavailable') }

      return runUtilityHelper(calendarHelper, [], input, signal)
    }
  }
}
