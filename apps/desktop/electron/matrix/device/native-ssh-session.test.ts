import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { expect, it, vi } from 'vitest'

import { createNativeSshSystem } from './native-ssh-system'

const exec = promisify(execFile)

const fixture = JSON.parse(
  await readFile(new URL('./native-ssh-fixtures/native-authorized-positive.json', import.meta.url), 'utf8')
)

it.each(['withdraw', 'stop'] as const)(
  'closes a real managed command on %s, preserving unrelated processes',
  async action => {
    const home = await mkdtemp(path.join(tmpdir(), "atum session's \\ "))
    const system = createNativeSshSystem({ home, run: vi.fn(async () => ({ stdout: '', stderr: '' })) as any })
    const unrelated = spawn('/bin/sleep', ['60'])
    let session: ReturnType<typeof spawn> | undefined

    try {
      await system.keys([fixture[0].publicKey])
      const root = path.join(home, 'Library/Application Support/Atum/native-ssh')
      const marker = path.join(root, 'sessions', (await readdir(path.join(root, 'sessions')))[0])
      const epoch = await readFile(marker, 'utf8')
      // A routine refresh must retain the authority epoch and running session.
      await system.keys([fixture[0].publicKey])
      expect(await readFile(marker, 'utf8')).toBe(epoch)
      session = spawn('/usr/bin/perl', [path.join(root, 'session.pl'), marker, epoch], {
        detached: true,
        env: { ...process.env, SHELL: '/bin/sh', SSH_ORIGINAL_COMMAND: 'sleep 60 & echo $!; wait' }
      })

      const exited = new Promise<number | null>((resolve, reject) => {
        session!.on('exit', resolve)
        session!.on('error', reject)
      })

      let descendant = 0
      await new Promise<void>((resolve, reject) => {
        session!.stdout!.once('data', data => { descendant = Number(data.toString().trim()); resolve() })
        session!.once('error', reject)
        session!.once('exit', () => reject(new Error('session exited before command')))
      })
      expect(session.exitCode).toBeNull()

      if (action === 'withdraw') {
        await system.keys([])
      } else {
        await system.stop()
      }

      expect(await exited).toBe(126)
      expect(unrelated.exitCode).toBeNull()
      expect(descendant).toBeGreaterThan(0)
      // A killed child may briefly remain a zombie until the OS reaps it.
      const state = await exec('/bin/ps', ['-o', 'stat=', '-p', String(descendant)]).catch(() => ({ stdout: '' }))
      expect(state.stdout.trim() === '' || state.stdout.trim().startsWith('Z')).toBe(true)
      expect(await readdir(path.join(root, 'sessions'))).toEqual([])
    } finally {
      session?.kill('SIGKILL')
      unrelated.kill('SIGKILL')
      await rm(home, { recursive: true, force: true })
    }
  }
)

it('preserves command bytes and exit status, denies a missing marker', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'atum-session-command-\\"'))

  try {
    const system = createNativeSshSystem({ home })
    await system.keys([fixture[0].publicKey])
    const root = path.join(home, 'Library/Application Support/Atum/native-ssh')
    const marker = path.join(root, 'sessions', (await readdir(path.join(root, 'sessions')))[0])
    const epoch = await readFile(marker, 'utf8')

    const run = (command: string) =>
      exec('/usr/bin/perl', [path.join(root, 'session.pl'), marker, epoch], {
        env: { ...process.env, SHELL: '/bin/sh', SSH_ORIGINAL_COMMAND: command }
      })

    expect((await run("printf '%s' 'quoted command bytes'")).stdout).toBe('quoted command bytes')
    await expect(run('exit 7')).rejects.toMatchObject({ code: 7 })
    const keys = await readFile(path.join(home, '.ssh/authorized_keys'), 'utf8')
    const forced = /command="((?:\\"|[^"])*)"/.exec(keys)![1].replace(/\\"/g, '"')
    expect(
      (
        await exec('/bin/sh', ['-c', forced], {
          env: { ...process.env, SHELL: '/bin/sh', SSH_ORIGINAL_COMMAND: 'printf forced-command' }
        })
      ).stdout
    ).toBe('forced-command')
    await rm(marker)
    await expect(run('echo should-not-run')).rejects.toMatchObject({ code: 126, stdout: '' })
    await system.keys([fixture[0].publicKey])
    expect(await readFile(marker, 'utf8')).not.toBe(epoch)
    await expect(run('echo stale-session')).rejects.toMatchObject({ code: 126, stdout: '' })
    expect(keys).toContain('no-X11-forwarding,no-user-rc,command="')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

it.each(['orphan', 'fork loop'])('revocation kills a real %s in the owned process group', async kind => {
  const home = await mkdtemp(path.join(tmpdir(), 'atum-session-orphan-'))
  const system = createNativeSshSystem({ home })
  let session: ReturnType<typeof spawn> | undefined
  let group = 0

  try {
    await system.keys([fixture[0].publicKey])
    const root = path.join(home, 'Library/Application Support/Atum/native-ssh')
    const marker = path.join(root, 'sessions', (await readdir(path.join(root, 'sessions')))[0])
    session = spawn('/usr/bin/perl', [path.join(root, 'session.pl'), marker, await readFile(marker, 'utf8')], {
      detached: true,
      env: { ...process.env, SHELL: '/bin/sh', SSH_ORIGINAL_COMMAND: kind === 'orphan'
        ? '(sleep 301 &); echo ready; sleep 301'
        : 'echo ready; while :; do (sleep 301 &); sleep 0.01; done' }
    })
    group = session.pid!
    const exited = new Promise(resolve => session!.once('exit', resolve))
    await new Promise(resolve => session!.stdout!.once('data', resolve))
    // Let the orphan reparent / fork loop populate while its foreground shell lives.
    await new Promise(resolve => setTimeout(resolve, 100))
    await system.keys([])
    await exited
    await expect.poll(async () => {
      const snapshot = await exec('/bin/ps', ['-axo', 'pid=,pgid=,stat='])

      return snapshot.stdout.split('\n').filter(line => {
        const fields = line.trim().split(/\s+/)

        return Number(fields[1]) === group && !fields[2]?.startsWith('Z')
      })
    }, { timeout: 3000 }).toEqual([])
  } finally {
    if (group) { try { process.kill(-group, 'SIGKILL') } catch { /* The process group has already exited. */ } }
    session?.kill('SIGKILL')
    await rm(home, { recursive: true, force: true })
  }
})

it('lets a PTY foreground command handle Ctrl-C without revoking the supervisor', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'atum-session-pty-'))

  try {
    const system = createNativeSshSystem({ home })
    await system.keys([fixture[0].publicKey])
    const root = path.join(home, 'Library/Application Support/Atum/native-ssh')
    const marker = path.join(root, 'sessions', (await readdir(path.join(root, 'sessions')))[0])

    const result = await exec('python3', ['-c', `
import os, pty, select, signal, sys, time, termios
pid, fd = pty.fork()
if pid == 0:
    os.environ['SHELL'] = '/bin/sh'
    os.environ['SSH_ORIGINAL_COMMAND'] = "trap 'echo interrupted; exit 42' INT; echo ready; while :; do sleep 1; done"
    os.execv('/usr/bin/perl', ['perl', *sys.argv[1:]])
try:
    data = b''
    deadline = time.monotonic() + 5
    while b'ready' not in data and time.monotonic() < deadline:
        if select.select([fd], [], [], .1)[0]: data += os.read(fd, 4096)
    assert b'ready' in data, data
    attrs = termios.tcgetattr(fd)
    attrs[3] |= termios.ISIG
    attrs[6][termios.VINTR] = b'\\x03'
    termios.tcsetattr(fd, termios.TCSANOW, attrs)
    os.write(fd, b'\\x03')
    while time.monotonic() < deadline:
        if select.select([fd], [], [], .05)[0]:
            try: data += os.read(fd, 4096)
            except OSError: pass
        done, status = os.waitpid(pid, os.WNOHANG)
        if done:
            assert os.waitstatus_to_exitcode(status) == 42, status
            print('PTY interrupt preserved child exit 42')
            break
        time.sleep(.05)
    else: raise AssertionError(('PTY command did not exit', data, os.tcgetpgrp(fd), pid))
finally:
    try: os.killpg(pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError): pass
    os.close(fd)
`, path.join(root, 'session.pl'), marker, await readFile(marker, 'utf8')])

    expect(result.stdout).toContain('PTY interrupt preserved child exit 42')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
