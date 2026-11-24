
import { afterEach, expect, it, vi } from 'vitest'

const capture = vi.hoisted(() => ({ ready: false, calls: 0 }))
vi.mock('node:child_process', () => ({
  execFile: (_shell: string, _args: string[], _options: unknown, done: (error: Error | null, stdout: string) => void) => {
    capture.calls++
    done(capture.ready ? null : new Error('ETIMEDOUT'), capture.ready ? '__T3CODE_ENV_PATH_START__\n/fixture/bin\n__T3CODE_ENV_PATH_END__' : '')
  }
}))
import { loginShellPath } from './shell-environment'

afterEach(() => vi.resetModules())

it('retries after timed-out captures and caches the next successful capture', async () => {
  const first = loginShellPath()
  expect(loginShellPath()).toBe(first)
  await first
  const calls = capture.calls
  capture.ready = true
  const second = loginShellPath()
  expect(second).not.toBe(first)
  expect(await second).toContain('/fixture/bin')
  expect(capture.calls).toBe(calls + 1)
  expect(loginShellPath()).toBe(second)
})
