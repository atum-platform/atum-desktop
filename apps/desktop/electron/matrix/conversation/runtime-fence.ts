import { spawn } from 'node:child_process'
import path from 'node:path'

import { matrixHermesEnvironment, type MatrixHermesRuntimeConfig } from '../hermes-runtime'

const FENCE_READY_TIMEOUT_MS = 10_000
const FENCE_RELEASE_TIMEOUT_MS = 2_000

// This follows cron.scheduler._get_lock_paths without importing the full scheduler:
// <HERMES_HOME>/cron/.tick.lock. The child holds it until stdin closes.
const FENCE_PROGRAM = `import json, os, sqlite3, sys
from pathlib import Path

def reply(ok):
    sys.stdout.write(json.dumps({"ok": ok}, separators=(",", ":")) + "\\n")
    sys.stdout.flush()

if sys.platform == "win32":
    reply(False)
    raise SystemExit(0)

try:
    import fcntl
except Exception:
    reply(False)
    raise SystemExit(0)

home = Path(sys.argv[1]).resolve()
cron = home / "cron"
cron.mkdir(parents=True, exist_ok=True)
lock_fd = open(cron / ".tick.lock", "a", encoding="utf-8")
try:
    fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except OSError:
    lock_fd.close()
    reply(False)
    raise SystemExit(0)

def owner_live(pid, started_at):
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return None
    if not isinstance(started_at, int) or isinstance(started_at, bool):
        return None
    try:
        from gateway.status import _pid_exists, get_process_start_time
        if not _pid_exists(pid):
            return False
        current = get_process_start_time(pid)
        if current is None:
            return None
        return current == started_at
    except Exception:
        return None

database = cron / "executions.db"
if database.exists():
    try:
        connection = sqlite3.connect("file:" + str(database) + "?mode=ro", uri=True, timeout=1)
        rows = connection.execute(
            "SELECT pid, process_started_at FROM executions WHERE status IN ('claimed', 'running') "
            "ORDER BY claimed_at DESC, id DESC LIMIT 501"
        ).fetchall()
        connection.close()
        if len(rows) >= 500 or any(owner_live(pid, started_at) is not False for pid, started_at in rows):
            reply(False)
            raise SystemExit(0)
    except SystemExit:
        lock_fd.close()
        raise
    except Exception:
        lock_fd.close()
        reply(False)
        raise SystemExit(0)

reply(True)
sys.stdin.buffer.read()
lock_fd.close()
`

export interface ConversationRuntimeFence {
  /** False as soon as the child exits, the operation releases, or its signal aborts. */
  held(): boolean
  /** Idempotently closes stdin and bounds cleanup of the lock-holder child. */
  release(): Promise<void>
}

/**
 * Blocks the runtime's independent cron ticker throughout a marker/job/home
 * operation. Active or unprovable cron executions fail closed before any
 * caller receives a fence.
 */
export async function conversationRuntimeFence(
  runtime: MatrixHermesRuntimeConfig,
  home: string,
  signal: AbortSignal
): Promise<ConversationRuntimeFence> {
  if (!path.isAbsolute(home) || signal.aborted) {
    throw fenceError()
  }

  const child = spawn(runtime.python, ['-s', '-P', '-B', '-c', FENCE_PROGRAM, home], {
    cwd: runtime.source,
    env: matrixHermesEnvironment(runtime, home, home),
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true
  })

  let ready = false
  let released = false
  let exited = false
  let output = ''
  let settleReady: ((value: boolean) => void) | undefined
  let failReady: ((error: Error) => void) | undefined
  const startup = new Promise<boolean>((resolve, reject) => {
    settleReady = resolve
    failReady = reject
  })

  const onExit = () => {
    exited = true

    if (!ready) {
      failReady?.(fenceError())
    }
  }

  const onError = () => failReady?.(fenceError())

  const onAbort = () => {
    void release()
  }
  child.once('exit', onExit)
  child.once('error', onError)
  // The fence may exit between the writable check and the EOF used to release it.
  child.stdin.on('error', () => {})
  child.stdout.on('data', (chunk: Buffer) => {
    if (ready || output.length > 128) {
      return
    }
    output += chunk.toString('utf8')
    const line = output.indexOf('\n')

    if (line < 0) {
      return
    }

    try {
      const value = JSON.parse(output.slice(0, line)) as { ok?: unknown }

      if (value.ok === true) {
        ready = true
        settleReady?.(true)

        return
      }
    } catch {
      /* Closed refusal below. */
    }

    settleReady?.(false)
  })
  signal.addEventListener('abort', onAbort, { once: true })
  const timeout = setTimeout(() => settleReady?.(false), FENCE_READY_TIMEOUT_MS)

  async function release(): Promise<void> {
    if (released) {
      return
    }
    released = true
    signal.removeEventListener('abort', onAbort)

    if (child.stdin.writable) {
      child.stdin.end()
    }

    if (exited) {
      return
    }
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        if (!exited) {
          child.kill('SIGTERM')
        }
        resolve()
      }, FENCE_RELEASE_TIMEOUT_MS)

      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  try {
    const accepted = await startup
    clearTimeout(timeout)

    if (!accepted || signal.aborted) {
      await release()
      throw fenceError()
    }
  } catch {
    clearTimeout(timeout)
    await release()
    throw fenceError()
  }

  return { held: () => ready && !released && !exited && !signal.aborted, release }
}

function fenceError(): Error {
  return new Error('matrix_conversation_turn_live')
}
