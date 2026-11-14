import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'

import { expect, it } from 'vitest'

import { type GuiAuthorizeRequest, GuiBroker } from './gui-broker'

interface HostAnswer {
  state: string
  result: { error?: string; refusal?: string }
}

it.skipIf(!process.env.ATUM_SYNC_PYTHON).each(['manual', 'off', 'interactive'])('runs host → broker → Cua backend → fake OS driver with %s approvals', async mode => {
  const root = path.resolve('../..')
  const home = mkdtempSync(path.join(os.tmpdir(), 'atum-gui-host-'))

  const child = spawn(process.env.ATUM_SYNC_PYTHON!, [path.join(root, 'tests/hermes_cli/atum_gui_host_fixture.py'), mode], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: home, HERMES_HOME: home, PYTHONPATH: root, HERMES_INTERACTIVE: mode === 'interactive' ? '1' : '0' }
  })

  let live = true
  let paused = false
  let own = false
  const requests: GuiAuthorizeRequest[] = []
  const driver: { action: string; pid: number; processes: number; threads: number }[] = []
  const released: { processStopped: boolean; threadStopped: boolean }[] = []
  let backends = 0

  const broker = new GuiBroker({
    authority: () => ({ live, paused }), ownApp: () => ({ pids: own ? requests.flatMap(r => r.target.pid ? [r.target.pid] : []) : [] }),
    requestUploadApproval: async () => 'approved', audit: () => {}
  })

  const pending = new Map<number, { resolve(result: HostAnswer): void; reject(error: Error): void }>()
  let stderr = ''
  let failure: Error | undefined
  child.stderr.on('data', chunk => { stderr += String(chunk) })

  const fail = (error: Error) => {
    failure = error

    for (const entry of pending.values()) {entry.reject(error)}
    pending.clear()
  }

  child.on('error', fail)
  child.on('exit', (code, signal) => fail(new Error(`fixture exited ${code ?? signal}: ${stderr}`)))
  const lines = createInterface({ input: child.stdout })
  lines.on('line', line => {
    const frame = JSON.parse(line)

    if (frame.method === 'device.gui_authorize') {
      requests.push(frame.params)
      void broker.authorize(frame.params).then(result => child.stdin.write(JSON.stringify({ id: frame.id, result }) + '\n'))
    } else if (frame.method === 'fixture.driver') {
      driver.push(frame.params)
    } else if (frame.method === 'fixture.released') {
      released.push(frame.params)
    } else if (frame.method === 'fixture.backend') {
      backends++
    } else if (typeof frame.id === 'number') {
      pending.get(frame.id)?.resolve(frame.result ?? frame.error)
      pending.delete(frame.id)
    }
  })
  let id = 0

  const rpc = (method: string, params: Record<string, unknown>) => new Promise<HostAnswer>((resolve, reject) => {
    if (failure) {reject(failure);

 return}

    const requestId = ++id
    pending.set(requestId, { resolve, reject })
    child.stdin.write(JSON.stringify({ id: requestId, method, params }) + '\n')
  })

  const call = (args: Record<string, unknown>, grantId = 'g1') =>
    rpc('device.computer_use', { commandId: `c${id + 1}`, grantId, args })

  try {
    expect(await call({ action: 'focus_app', app: 'Fixture', raise_window: true }), stderr).toMatchObject({ state: 'completed' })

    for (const args of [
      { action: 'click', coordinate: [10, 20] }, { action: 'type', text: 'fixture' },
      { action: 'key', keys: 'cmd+a' }, { action: 'drag', from_coordinate: [1, 2], to_coordinate: [3, 4] },
      { action: 'scroll', direction: 'down' }
    ]) {
      const answer = await call(args)
      expect(answer.state).toBe('completed')
      expect(answer.result.error).toBeUndefined()
    }

    expect(driver.map(d => d.action)).toEqual(['click', 'type_text', 'hotkey', 'drag', 'scroll'])
    expect(requests.map(r => r.action)).toEqual(['focus_app', 'bring_to_front', 'click', 'type', 'key', 'drag', 'scroll'])
    expect(requests.slice(2).map(r => r.target.pid)).toEqual(driver.map(d => d.pid))

    for (let n = 0; n < 20; n++) {
      expect((await call({ action: 'click', coordinate: [10, 20] })).state).toBe('completed')
      expect(requests.at(-1)?.target.pid).toBe(driver.at(-1)?.pid)
    }

    expect(backends).toBe(1)
    expect(driver.every(d => d.processes === 1 && d.threads === 1)).toBe(true)
    // A second grant starts without the first grant's sticky target.
    expect((await call({ action: 'click', coordinate: [10, 20] }, 'g2')).result.refusal).toBe('no_target')
    expect((await call({ action: 'focus_app', app: 'Fixture' }, 'g2')).state).toBe('completed')
    expect((await call({ action: 'click', coordinate: [10, 20] }, 'g2')).state).toBe('completed')
    expect(requests.at(-1)?.target.pid).toBe(driver.at(-1)?.pid)
    expect(driver.at(-1)?.pid).not.toBe(driver[0].pid)
    expect(backends).toBe(2)

    // A Hermes bypass must never bypass the Mac broker. This also exercises the regular path
    // with no interactive environment, where the old shared gate refused before the broker.
    live = false
    expect((await call({ action: 'click', coordinate: [10, 20] })).result.refusal).toBe('stopped')
    live = true
    paused = true
    expect((await call({ action: 'type', text: 'fixture' })).result.refusal).toBe('paused')
    paused = false
    own = true
    expect((await call({ action: 'key', keys: 'cmd+a' })).state).toBe('completed')
    own = false
    expect((await call({ action: 'focus_app', app: 'Keychain Access' })).result.refusal).toBe('security_ui')
    expect(driver).toHaveLength(27)

    for (const app of ['Terminal', 'iTerm2', 'Script Editor', 'Automator', 'Shortcuts', 'Warp', 'Ghostty', 'Alacritty', 'kitty', 'WezTerm', 'Hyper', 'Tabby', 'Rio', 'Wave', 'Termius', 'Script Debugger']) {
      expect((await call({ action: 'focus_app', app, raise_window: true })).result.refusal).toBe('command_app')
      expect((await call({ action: 'capture', app })).state).toBe('completed')
      const answer = await call({ action: 'type', text: 'echo fixture' })
      expect(answer.state).toBe('failed_no_effect')
      expect(answer.result.refusal).toBe('command_app')
    }

    expect(driver).toHaveLength(27)
    expect(await rpc('device.release_gui', {})).toEqual({ code: 'invalid_params' })
    expect(released).toHaveLength(0)
    await rpc('device.release_gui', { grantId: 'g1' })
    expect(released).toEqual([{ pid: driver[0].pid, processStopped: true, threadStopped: true }])
    expect((await call({ action: 'focus_app', app: 'Fixture' })).result.refusal).toBe('stopped')
    await rpc('device.shutdown', {})
    expect(released).toHaveLength(2)
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
      child.kill('SIGKILL')
      await closed
    }

    lines.close()
    rmSync(home, { recursive: true, force: true })
  }
}, 30_000)
