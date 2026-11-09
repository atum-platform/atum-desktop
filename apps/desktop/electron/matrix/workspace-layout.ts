import { execFile } from 'node:child_process'
import { lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface MatrixWorkspaceChoice {
  legacy: string
  workspace: string
  default: boolean
  reason?: 'workspace_named_inside_drive'
}

function canonical(value: string): string {
  try {
    return realpathSync(value)
  } catch {
    return path.resolve(value)
  }
}

function contains(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)

  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}

/** The native resolver's one decision, also used before deciding whether migration is needed. */
export function matrixWorkspaceChoice(
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
  knownDriveRoots: readonly string[] = []
): MatrixWorkspaceChoice {
  const legacy = path.join(home, 'Atum')
  const workspace = path.join(legacy, 'Workspace')
  const fallback: MatrixWorkspaceChoice = { legacy, workspace, default: true }
  const named = env.HERMES_DESKTOP_CWD?.trim()

  if (!named || !path.isAbsolute(named)) {
    return fallback
  }

  try {
    if (!statSync(named).isDirectory()) {
      return fallback
    }

    const resolved = canonical(named)

    if (resolved === canonical(legacy)) {
      return fallback
    }

    if ([path.join(legacy, 'Drive'), ...knownDriveRoots].some(root => contains(canonical(root), resolved))) {
      return { ...fallback, reason: 'workspace_named_inside_drive' }
    }

    return { legacy, workspace: named, default: false }
  } catch {
    return fallback
  }
}

/** Create the private default without following a replaced Atum/Workspace link. */
export function ensureMatrixWorkspace(choice: MatrixWorkspaceChoice, knownDriveRoots: readonly string[] = []): string {
  return matrixWorkspaceLocation(choice, knownDriveRoots, true)
}

/** Watched folders use the same collision/fence decision without creating anything. */
export function readMatrixWorkspace(choice: MatrixWorkspaceChoice, knownDriveRoots: readonly string[] = []): string {
  return matrixWorkspaceLocation(choice, knownDriveRoots, false)
}

function matrixWorkspaceLocation(
  choice: MatrixWorkspaceChoice,
  knownDriveRoots: readonly string[],
  create: boolean
): string {
  if (knownDriveRoots.some(root => contains(canonical(root), canonical(choice.workspace)))) {
    throw new Error('workspace_layout_blocked')
  }

  if (!choice.default) {
    return choice.workspace
  }

  if (create) {
    try {
      mkdirSync(choice.legacy, { mode: 0o700 })
    } catch {
      // Existing directories are checked below.
    }
  }

  try {
    const parent = lstatSync(choice.legacy)

    if (!parent.isDirectory() || parent.isSymbolicLink()) {
      return path.dirname(choice.legacy)
    }

    if (create) {
      try {
        mkdirSync(choice.workspace, { mode: 0o700 })
      } catch {
        // A collision must never be replaced.
      }
    }

    const workspace = lstatSync(choice.workspace)

    if (workspace.isDirectory() && !workspace.isSymbolicLink()) {
      return choice.workspace
    }
  } catch {
    // The legacy directory remains the fallback for a blocked Workspace.
  }

  return choice.legacy
}

export interface MatrixWorkspaceLayoutResult {
  status: 'completed' | 'already_completed' | 'not_needed' | 'deferred' | 'blocked'
  moved: number
  skipped: number
  reason?: string
}

export interface MatrixWorkspaceLayoutInput {
  home: string
  userData: string
  python: string
  /** Must be sampled while A-APP holds startup closed to every runtime/turn. */
  quiescent: boolean
  env?: NodeJS.ProcessEnv
  knownDriveRoots?: readonly string[]
  runtimeSource?: string
  runtimeProfiles?: string
  signal?: AbortSignal
  /** Fault injection for the real temporary-directory crash proof; never bridge input. */
  testCrashAfterMove?: number
  /** Exercise a destination appearing between the precheck and native rename. */
  testRaceDestination?: string
}

const empty = (status: MatrixWorkspaceLayoutResult['status'], reason?: string): MatrixWorkspaceLayoutResult => ({
  status,
  moved: 0,
  skipped: 0,
  ...(reason ? { reason } : {})
})

/** One native-only launch operation. Paths and the private journal never reach a renderer or log. */
export async function migrateMatrixWorkspaceLayout(
  input: MatrixWorkspaceLayoutInput
): Promise<MatrixWorkspaceLayoutResult> {
  const choice = matrixWorkspaceChoice(input.env ?? {}, input.home, input.knownDriveRoots)

  if (!choice.default) {
    return empty('not_needed')
  }

  if (!input.quiescent || input.signal?.aborted) {
    return empty('deferred', 'workspace_layout_deferred')
  }

  if (![input.home, input.userData, input.python].every(value => path.isAbsolute(value))) {
    return empty('blocked', 'workspace_layout_blocked')
  }

  return new Promise(resolve => {
    const child = execFile(
      input.python,
      ['-I', '-B', '-S', '-c', NATIVE_LAYOUT],
      {
        cwd: input.home,
        timeout: 60_000,
        maxBuffer: 4096,
        signal: input.signal
      },
      (error, stdout) => {
        if (error) {
          resolve(empty('deferred', 'workspace_layout_interrupted'))

          return
        }

        try {
          const result = JSON.parse(stdout) as MatrixWorkspaceLayoutResult

          if (
            !['completed', 'already_completed', 'deferred', 'blocked'].includes(result.status) ||
            !Number.isSafeInteger(result.moved) ||
            result.moved < 0 ||
            !Number.isSafeInteger(result.skipped) ||
            result.skipped < 0 ||
            (result.reason !== undefined && !/^workspace_layout_[a-z_]+$/.test(result.reason))
          ) {
            throw new Error('invalid_result')
          }

          resolve(result)
        } catch {
          resolve(empty('blocked', 'workspace_layout_blocked'))
        }
      }
    )

    child.stdin?.on('error', () => {})
    child.stdin?.end(
      JSON.stringify({
        legacy: choice.legacy,
        userData: input.userData,
        driveRoots: input.knownDriveRoots ?? [],
        runtimeRoots: [
          input.python,
          ...(input.runtimeSource ? [input.runtimeSource] : []),
          ...(input.runtimeProfiles ? [input.runtimeProfiles] : [])
        ],
        crashAfterMove: input.testCrashAfterMove ?? 0,
        raceDestination: input.testRaceDestination ?? null
      })
    )
  })
}

// Bundled Python's standard library supplies native exclusive rename and crash-released flock.
// Ordinary Node rename is unsuitable: a destination created after a precheck would be replaced.
const NATIVE_LAYOUT = String.raw`
import ctypes, errno, fcntl, json, os, stat, subprocess, sys, time

def reply(status, moved=0, skipped=0, reason=None):
    result = dict(status=status, moved=moved, skipped=skipped)
    if reason: result['reason'] = reason
    print(json.dumps(result), flush=True)

def identity(info):
    return [str(info.st_dev), str(info.st_ino)]

def directory(name, parent=None, create=False):
    if create:
        try: os.mkdir(name, 0o700, dir_fd=parent)
        except FileExistsError: pass
    fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
    if os.fstat(fd).st_uid != os.getuid():
        os.close(fd)
        raise ValueError('directory_owner')
    return fd

def regular(name, parent, flags, create=False):
    fd = os.open(name, flags | os.O_NOFOLLOW | (os.O_CREAT if create else 0), 0o600, dir_fd=parent)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
        os.close(fd)
        raise ValueError('receipt_owner')
    return fd

def read_json(name, parent):
    try: fd = regular(name, parent, os.O_RDONLY)
    except FileNotFoundError: return None
    with os.fdopen(fd, 'rb') as source:
        data = source.read(16 * 1024 * 1024 + 1)
    if len(data) > 16 * 1024 * 1024: raise ValueError('receipt_cap')
    return json.loads(data)

def holds_legacy(legacy, workspace):
    def held(value):
        return (value == legacy or value.startswith(legacy + os.sep)) and not (
            value == workspace or value.startswith(workspace + os.sep))
    if sys.platform == 'darwin':
        result = subprocess.run(['/usr/sbin/lsof', '-a', '-u', str(os.getuid()), '-d', 'cwd', '-F0pfn'],
                                capture_output=True, timeout=10)
        if result.returncode not in (0, 1) or result.stderr: raise ValueError('process_probe')
        for field in result.stdout.split(b'\0'):
            field = field.lstrip(b'\n')
            if field.startswith(b'n') and held(os.fsdecode(field[1:])): return True
        return False
    if sys.platform.startswith('linux'):
        for name in os.listdir('/proc'):
            if not name.isdecimal() or int(name) == os.getpid(): continue
            try:
                if os.stat('/proc/' + name).st_uid != os.getuid(): continue
                if held(os.readlink('/proc/' + name + '/cwd')): return True
            except OSError as error:
                if error.errno in (errno.ENOENT, errno.ESRCH): continue
                raise ValueError('process_probe')
        return False
    raise ValueError('unsupported_platform')

def rename_exclusive(source, source_fd, target, target_fd):
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform == 'darwin':
        native = libc.renameatx_np
        flag = 0x00000004  # RENAME_EXCL, SDK sys/stdio.h
    elif sys.platform.startswith('linux'):
        native = libc.renameat2
        flag = 1  # RENAME_NOREPLACE
    else: raise ValueError('unsupported_platform')
    native.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    native.restype = ctypes.c_int
    if native(source_fd, os.fsencode(source), target_fd, os.fsencode(target), flag):
        value = ctypes.get_errno()
        raise OSError(value, os.strerror(value))

def contained(root, value):
    return value == root or value.startswith(root + os.sep)

def run(cfg):
    legacy = cfg['legacy']
    user_data = cfg['userData']
    if any(not isinstance(p, str) or not os.path.isabs(p) or '\0' in p
           for p in [legacy, user_data] + cfg['driveRoots'] + cfg['runtimeRoots']):
        raise ValueError('native_paths')
    # No files move until the native process view also proves quiescence.
    resolved_legacy = os.path.realpath(legacy)
    resolved_workspace = os.path.realpath(os.path.join(legacy, 'Workspace'))
    if any(contained(os.path.realpath(p), resolved_workspace) for p in cfg['driveRoots']):
        raise ValueError('workspace_inside_drive')
    try: held = holds_legacy(resolved_legacy, resolved_workspace)
    except (OSError, ValueError, subprocess.SubprocessError):
        reply('deferred', reason='workspace_layout_deferred')
        return
    if held:
        reply('deferred', reason='workspace_layout_deferred')
        return
    os.makedirs(user_data, mode=0o700, exist_ok=True)
    data_fd = directory(user_data)
    try:
        try: lock_fd = regular('workspace-layout.lock', data_fd, os.O_RDWR | os.O_EXCL, True)
        except FileExistsError: lock_fd = regular('workspace-layout.lock', data_fd, os.O_RDWR)
        try:
            try: fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                reply('deferred', reason='workspace_layout_deferred')
                return
            root_fd = directory(legacy, create=True)
            try:
                workspace_fd = directory('Workspace', root_fd, True)
                try:
                    perform(cfg, root_fd, workspace_fd, data_fd)
                finally: os.close(workspace_fd)
            finally: os.close(root_fd)
        finally: os.close(lock_fd)
    finally: os.close(data_fd)

def perform(cfg, root_fd, workspace_fd, data_fd):
    header = dict(version=1, legacyIdentity=identity(os.fstat(root_fd)),
                  workspaceIdentity=identity(os.fstat(workspace_fd)))
    marker = read_json('workspace-layout.json', data_fd)
    if marker is not None:
        if any(marker.get(k) != v for k, v in header.items()) or not isinstance(marker.get('completedAt'), int):
            raise ValueError('marker_binding')
        if not isinstance(marker.get('moved'), list) or not isinstance(marker.get('skipped'), list):
            raise ValueError('marker_shape')
        reply('already_completed', len(marker['moved']), len(marker['skipped']))
        return
    journal_name = 'workspace-layout.pending.jsonl'
    try: journal_fd = regular(journal_name, data_fd, os.O_RDWR | os.O_APPEND | os.O_EXCL, True)
    except FileExistsError: journal_fd = regular(journal_name, data_fd, os.O_RDWR | os.O_APPEND)
    try:
        data = os.read(journal_fd, 16 * 1024 * 1024 + 1)
        if len(data) > 16 * 1024 * 1024: raise ValueError('journal_cap')
        if data and not data.endswith(b'\n'):
            # An interrupted append cannot authorize a move; the prior intent was fsynced first.
            end = data.rfind(b'\n') + 1
            os.ftruncate(journal_fd, end)
            data = data[:end]
        events = [json.loads(line) for line in data.splitlines()]
        def record(event):
            encoded = (json.dumps(event, ensure_ascii=True) + '\n').encode('ascii')
            if os.fstat(journal_fd).st_size + len(encoded) > 16 * 1024 * 1024:
                raise ValueError('journal_cap')
            offset = 0
            while offset < len(encoded): offset += os.write(journal_fd, encoded[offset:])
            os.fsync(journal_fd)
        if events:
            if events.pop(0) != header: raise ValueError('journal_binding')
        else:
            record(header)
            os.fsync(data_fd)
        moved, skipped, intents = [], [], {}
        reasons = {'reserved', 'dot', 'link', 'special', 'collision', 'drive_root', 'runtime', 'application_data', 'changed', 'move_failed'}
        for event in events:
            name = event.get('name')
            if not isinstance(name, str) or not name or name in ('.', '..') or '/' in name or '\0' in name:
                raise ValueError('journal_name')
            kind = event.get('kind')
            if kind == 'intent': intents[name] = event['identity']
            elif kind == 'moved':
                if name not in moved: moved.append(name)
                intents.pop(name, None)
            elif kind == 'skipped' and event.get('reason') in reasons:
                skipped.append(dict(name=name, reason=event['reason']))
                intents.pop(name, None)
            else: raise ValueError('journal_event')
        def note_skip(name, reason):
            record(dict(kind='skipped', name=name, reason=reason))
            skipped.append(dict(name=name, reason=reason))
        def note_moved(name):
            record(dict(kind='moved', name=name))
            if name not in moved: moved.append(name)
        def info(name, parent):
            try: return os.stat(name, dir_fd=parent, follow_symlinks=False)
            except FileNotFoundError: return None
        for name, expected in intents.items():
            source, target = info(name, root_fd), info(name, workspace_fd)
            if target is not None and identity(target) == expected and (source is None or identity(source) != expected):
                note_moved(name)
                if source is not None: note_skip(name, 'changed')
            elif source is None or identity(source) != expected:
                note_skip(name, 'changed')
            elif target is not None:
                note_skip(name, 'collision')
        finished = set(moved) | {entry['name'] for entry in skipped}
        protected = [(value, 'drive_root') for value in cfg['driveRoots']]
        protected += [(value, 'runtime') for value in cfg['runtimeRoots']]
        protected += [(cfg['userData'], 'application_data')]
        roots = [(os.path.abspath(p), reason) for p, reason in protected]
        roots += [(os.path.realpath(p), reason) for p, reason in protected]
        legacy = os.path.abspath(cfg['legacy'])
        actual_legacy = os.path.realpath(legacy)
        if any(contained(os.path.realpath(p), os.path.join(actual_legacy, 'Workspace')) for p in cfg['driveRoots']):
            raise ValueError('workspace_inside_drive')
        completed_moves = 0
        for name in sorted(os.listdir(root_fd)):
            if name in finished: continue
            source = info(name, root_fd)
            if source is None: continue
            reason = None
            if name in ('Drive', 'Workspace', 'Agents'): reason = 'reserved'
            elif name.startswith('.'): reason = 'dot'
            elif stat.S_ISLNK(source.st_mode): reason = 'link'
            elif not (stat.S_ISREG(source.st_mode) or stat.S_ISDIR(source.st_mode)): reason = 'special'
            else:
                reason = next((why for p, why in roots if contained(os.path.join(legacy, name), p)
                               or contained(os.path.join(actual_legacy, name), p)), None)
            if reason:
                note_skip(name, reason)
                continue
            if info(name, workspace_fd) is not None:
                note_skip(name, 'collision')
                continue
            expected = identity(source)
            record(dict(kind='intent', name=name, identity=expected))
            current = info(name, root_fd)
            if current is None or identity(current) != expected or stat.S_ISLNK(current.st_mode):
                note_skip(name, 'changed')
                continue
            try:
                if cfg.get('raceDestination') == name:
                    racer = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                                    0o600, dir_fd=workspace_fd)
                    try: os.write(racer, b'synthetic-race')
                    finally: os.close(racer)
                rename_exclusive(name, root_fd, name, workspace_fd)
            except FileExistsError:
                note_skip(name, 'collision')
                continue
            except OSError:
                note_skip(name, 'move_failed')
                continue
            completed_moves += 1
            os.fsync(root_fd)
            os.fsync(workspace_fd)
            if cfg.get('crashAfterMove', 0) == completed_moves: os._exit(86)
            note_moved(name)
        marker = dict(header, completedAt=int(time.time() * 1000), moved=moved, skipped=skipped)
        temporary = 'workspace-layout.' + os.urandom(16).hex() + '.tmp'
        fd = regular(temporary, data_fd, os.O_WRONLY | os.O_EXCL, True)
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as target:
                json.dump(marker, target, ensure_ascii=True)
                target.flush()
                os.fsync(target.fileno())
            rename_exclusive(temporary, data_fd, 'workspace-layout.json', data_fd)
            os.fsync(data_fd)
        finally:
            try: os.unlink(temporary, dir_fd=data_fd)
            except FileNotFoundError: pass
        reply('completed', len(moved), len(skipped))
    finally: os.close(journal_fd)

try:
    body = sys.stdin.buffer.read(262145)
    if len(body) > 262144: raise ValueError('request_cap')
    run(json.loads(body))
except Exception:
    reply('blocked', reason='workspace_layout_blocked')
`
