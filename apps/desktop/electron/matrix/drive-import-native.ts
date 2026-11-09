import { spawn } from 'node:child_process'

import type { MatrixDriveImportSkip } from '../../shared/matrix-drive'
import { ownedBackgroundChildren } from '../owned-background-children'

import type { MatrixDriveImportPattern } from './drive-exclusions'

export interface NativeDriveImportTarget {
  root: string
  dev: number
  ino: number
  /** Main-only account/fence fact. Never part of the helper output or renderer plan. */
  ownerKey: string
}

export interface NativeDriveImportInput {
  mode: 'plan' | 'run' | 'cleanup'
  home: string
  target?: NativeDriveImportTarget
  sources?: readonly string[]
  protectedRoots?: readonly string[]
  patterns?: readonly MatrixDriveImportPattern[]
  planId?: string
  fingerprint?: string
  total?: number
  remaining?: number
  /** Test-only native seam, never renderer input. */
  testCancelAfterCopy?: number
}

export interface NativeDriveImportReply {
  state: 'planned' | 'completed' | 'cancelled' | 'changed' | 'no_room' | 'unavailable' | 'refused'
  reason?:
    | 'home'
    | 'protected'
    | 'in_drive'
    | 'unavailable'
    | 'too_many'
    | 'timeout'
    | 'quota_unknown'
    | 'staging_volume'
    | 'empty'
  files?: number
  folders?: number
  bytes?: number
  skipped?: Record<MatrixDriveImportSkip, number>
  used?: number
  fingerprint?: string
  added: number
}

/** Owned stdlib process; no renderer paths, credentials, inherited environment or stderr logs. */
export function executeNativeDriveImport(
  python: string,
  input: NativeDriveImportInput,
  signal?: AbortSignal,
  targetStillCurrent?: () => boolean
): Promise<NativeDriveImportReply> {
  if (signal?.aborted) {
    return Promise.resolve({ state: 'cancelled', added: 0 })
  }

  return new Promise(resolve => {
    const child = ownedBackgroundChildren.track(spawn(python, ['-I', '-B', '-S', '-c', nativeImport], {
      cwd: input.home,
      env: { PATH: '/usr/bin:/bin' },
      stdio: ['pipe', 'pipe', 'ignore']
    }))

    let output = ''
    let reply: NativeDriveImportReply | undefined
    let settled = false
    let kill: ReturnType<typeof setTimeout> | undefined

    const stop = () => {
      child.kill('SIGTERM')
      kill ??= setTimeout(() => child.kill('SIGKILL'), 2_000).unref()
    }

    // Planning can spend 10s on the selection and another 10s on local Drive usage.
    const timeout = setTimeout(stop, input.mode === 'run' ? 300_000 : 30_000).unref()

    const finish = (reply: NativeDriveImportReply) => {
      if (settled) {
        return
      }

      settled = true
      clearTimeout(timeout)
      clearTimeout(kill)
      signal?.removeEventListener('abort', stop)
      resolve(reply)
    }

    signal?.addEventListener('abort', stop, { once: true })
    child.stdout.on('data', chunk => {
      output += String(chunk)

      if (output.length > 16_384) {
        stop()
      }

      for (let end = output.indexOf('\n'); end >= 0; end = output.indexOf('\n')) {
        const line = output.slice(0, end)
        output = output.slice(end + 1)

        try {
          const message = JSON.parse(line)

          if (message.checkTarget === true) {
            let place = false

            try {
              place = !signal?.aborted && (targetStillCurrent?.() ?? true)
            } catch {
              place = false
            }

            child.stdin.write(JSON.stringify({ place }) + '\n')
          } else {
            reply = message
          }
        } catch {
          stop()
        }
      }
    })
    child.on('error', () => finish({ state: 'unavailable', added: 0 }))
    child.stdin.on('error', () => {})
    child.on('close', () => {
      try {
        if (
          !reply ||
          !['planned', 'completed', 'cancelled', 'changed', 'no_room', 'unavailable', 'refused'].includes(reply.state)
        ) {
          throw new Error()
        }

        finish(reply)
      } catch {
        finish({ state: 'unavailable', added: 0 })
      }
    })
    child.stdin.write(JSON.stringify(input) + '\n')
  })
}

const nativeImport = String.raw`
import ctypes, errno, hashlib, json, os, re, shutil, signal, stat, sys, time

class Refused(Exception):
    def __init__(self, reason): self.reason = reason
class Changed(Exception): pass
class Cancelled(Exception): pass

cancelled = False
parent_pid = os.getppid()
if hasattr(signal,'alarm'): signal.alarm(300)
def stop(*_):
    global cancelled
    cancelled = True
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)

def check(deadline=None):
    if cancelled or os.getppid() != parent_pid: raise Cancelled()
    if deadline is not None and time.monotonic() > deadline: raise Refused('timeout')

DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
READ = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
def drive_marker(fd):
    try: os.stat('.atum-drive-binding.json', dir_fd=fd, follow_symlinks=False)
    except FileNotFoundError: return False
    return True

def directory(value, create=False, protect_drive=False):
    if not os.path.isabs(value) or '\0' in value: raise Refused('unavailable')
    fd = os.open('/', DIR)
    try:
        for part in value.split('/')[1:]:
            if not part or part == '.': continue
            if part == '..': raise Refused('unavailable')
            if create:
                try: os.mkdir(part, 0o700, dir_fd=fd)
                except FileExistsError: pass
            child = os.open(part, DIR, dir_fd=fd)
            os.close(fd)
            fd = child
            if protect_drive and drive_marker(fd): raise Refused('in_drive')
        return fd
    except:
        os.close(fd)
        raise

def identity(s): return [s.st_dev, s.st_ino, s.st_mode, s.st_size, s.st_mtime_ns]
def compared(value): return value.casefold() if sys.platform in ('darwin','win32') else value
def overlap(a, b):
    a, b = compared(a), compared(b)
    return a == b or a.startswith(b.rstrip('/') + '/') or b.startswith(a.rstrip('/') + '/')
def bound_target(cfg):
    target = cfg['target']
    fd = directory(target['root'])
    s = os.fstat(fd)
    if s.st_dev != target['dev'] or s.st_ino != target['ino']:
        os.close(fd)
        raise Changed()
    return fd

def rules(cfg):
    flags = re.IGNORECASE if sys.platform in ('darwin','win32') else 0
    return [(re.compile(p['expression'], flags), p['directoryOnly'], p['reason']) for p in cfg['patterns']]

def inventory(cfg):
    deadline = time.monotonic() + 10
    skipped = {k: 0 for k in ['private','code','excluded','shortcuts','special','unreadable']}
    digest = hashlib.sha256()
    rows, top = [], []
    counts = {'files': 0, 'folders': 0, 'bytes': 0}
    entries = 0
    patterns = rules(cfg)
    home = os.path.realpath(cfg['home'])
    protected = [os.path.realpath(p) for p in cfg.get('protectedRoots', [])] + [os.path.join(home,'Atum','.import')]
    drive = cfg['target']['root']

    def visit(parent, name, rel, index):
        nonlocal entries
        check(deadline)
        entries += 1
        if entries > 50000: raise Refused('too_many')
        try: s = os.stat(name, dir_fd=parent, follow_symlinks=False)
        except OSError:
            skipped['unreadable'] += 1
            digest.update(json.dumps([index,rel,'unreadable']).encode())
            return
        digest.update(json.dumps([index,rel,identity(s)], ensure_ascii=True).encode())
        if stat.S_ISLNK(s.st_mode):
            skipped['shortcuts'] += 1
            return
        isdir = stat.S_ISDIR(s.st_mode)
        if not isdir and not stat.S_ISREG(s.st_mode):
            skipped['special'] += 1
            return
        # _csync_excluded_common's QString length rule, also outside the pattern list.
        if len(name.encode('utf-16-le','surrogatepass')) // 2 > 254:
            skipped['excluded'] += 1
            return
        relative = '/'.join(rel)
        for expression, directory_only, reason in patterns:
            if (not directory_only or isdir) and expression.search(relative):
                skipped[reason] += 1
                return
        try: fd = os.open(name, DIR if isdir else READ, dir_fd=parent)
        except OSError:
            skipped['unreadable'] += 1
            return
        try:
            if identity(os.fstat(fd)) != identity(s): raise Changed()
            if isdir and drive_marker(fd): raise Refused('in_drive')
            rows.append([index, rel[1:], 'folder' if isdir else 'file', identity(s)])
            if isdir:
                counts['folders'] += 1
                names = []
                with os.scandir(fd) as listing:
                    for entry in listing:
                        check(deadline)
                        if len(names) + entries >= 50000: raise Refused('too_many')
                        names.append(entry.name)
                for child in sorted(names): visit(fd, child, rel + [child], index)
            else:
                counts['files'] += 1
                counts['bytes'] += s.st_size
            if identity(os.fstat(fd)) != identity(s): raise Changed()
        finally: os.close(fd)

    for index, source in enumerate(cfg['sources']):
        check(deadline)
        if not os.path.isabs(source): raise Refused('unavailable')
        if overlap(source, drive): raise Refused('in_drive')
        # Home/ancestors are refused without rejecting ordinary descendants of home.
        if compared(source) == compared(home) or compared(home).startswith(compared(source).rstrip('/') + '/') or source == '/': raise Refused('home')
        if any(overlap(source, p) for p in protected): raise Refused('protected')
        ancestors = os.path.dirname(source).strip('/').split('/')
        # A directly picked id_rsa inside .ssh must not evade its parent-directory rule.
        for end in range(1, len(ancestors) + 1):
            ancestor = '/'.join(ancestors[:end])
            if any(expression.search(ancestor) for expression, _, _ in patterns): raise Refused('protected')
        parent = directory(os.path.dirname(source), protect_drive=True)
        try:
            name = os.path.basename(source)
            if name in ('', '.', '..'): raise Refused('unavailable')
            before = len(rows)
            visit(parent, name, [name], index)
            if len(rows) > before: top.append([index,name])
        finally: os.close(parent)
    if not rows: raise Refused('empty')
    return {'counts': counts, 'skipped': skipped, 'fingerprint': digest.hexdigest(), 'rows': rows, 'top': top}

def drive_usage(fd):
    deadline, entries, size = time.monotonic() + 10, 0, 0
    def walk(folder):
        nonlocal entries, size
        with os.scandir(folder) as listing:
            for entry in listing:
                check(deadline)
                entries += 1
                if entries > 50000: raise Refused('quota_unknown')
                s = os.stat(entry.name, dir_fd=folder, follow_symlinks=False)
                if stat.S_ISREG(s.st_mode): size += s.st_size
                elif stat.S_ISDIR(s.st_mode):
                    child = os.open(entry.name, DIR, dir_fd=folder)
                    try: walk(child)
                    finally: os.close(child)
                # Links/special files have no synchronised regular-file bytes.
    try: walk(fd)
    except Cancelled: raise
    except: raise Refused('quota_unknown')
    return size

def import_parent(cfg, create=False):
    parent = directory(os.path.join(cfg['home'], 'Atum', '.import'), create)
    s = os.fstat(parent)
    if s.st_uid != os.getuid() or s.st_mode & 0o077:
        os.close(parent)
        raise Refused('unavailable')
    return parent

def cleanup(cfg):
    try: parent = import_parent(cfg)
    except FileNotFoundError: return
    try:
        if not shutil.rmtree.avoids_symlink_attacks: raise Refused('unavailable')
        # Only our UUID/private directory/private marker; names and paths never leave.
        with os.scandir(parent) as listing:
            for entry in listing:
                check()
                if not re.fullmatch(r'[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}', entry.name): continue
                try:
                    fd = os.open(entry.name, DIR, dir_fd=parent)
                    try:
                        s = os.fstat(fd)
                        if s.st_uid != os.getuid() or s.st_mode & 0o077: continue
                        marker = os.open('.atum-import.json', READ, dir_fd=fd)
                        try:
                            m = os.fstat(marker)
                            if not stat.S_ISREG(m.st_mode) or m.st_uid != os.getuid() or m.st_nlink != 1 or m.st_size > 1024: continue
                            record = json.loads(os.read(marker, 1025))
                        finally: os.close(marker)
                    finally: os.close(fd)
                    if record.get('version') == 1 and record.get('planId') == entry.name and type(record.get('createdAt')) is int and record['createdAt'] < int(time.time()*1000) - 86400000:
                        current = os.stat(entry.name, dir_fd=parent, follow_symlinks=False)
                        if [current.st_dev,current.st_ino] == [s.st_dev,s.st_ino]: shutil.rmtree(entry.name, dir_fd=parent)
                except (OSError, ValueError, TypeError, AttributeError): continue
    finally: os.close(parent)

def exclusive_rename(source_fd, source, target_fd, target):
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform == 'darwin':
        rename = libc.renameatx_np
        rename.argtypes = [ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint]
        flag = 4
    elif sys.platform == 'linux':
        rename = libc.renameat2
        rename.argtypes = [ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint]
        flag = 1
    else: raise Refused('unavailable')
    rename.restype = ctypes.c_int
    if rename(source_fd, os.fsencode(source), target_fd, os.fsencode(target), flag):
        code = ctypes.get_errno()
        raise OSError(code, 'exclusive placement failed')

def source_file(cfg, index, relative, expected):
    source = cfg['sources'][index]
    parent = directory(os.path.dirname(source))
    try:
        parts = [os.path.basename(source)] + relative
        for part in parts[:-1]:
            child = os.open(part, DIR, dir_fd=parent)
            os.close(parent)
            parent = child
        fd = os.open(parts[-1], READ, dir_fd=parent)
        s = os.fstat(fd)
        if not stat.S_ISREG(s.st_mode) or identity(s) != expected:
            os.close(fd)
            raise Changed()
        return fd
    finally: os.close(parent)

def stage_directory(parent, parts):
    fd = os.dup(parent)
    try:
        for part in parts:
            child = os.open(part, DIR, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except:
        os.close(fd)
        raise

def copy_file(source, parent, name, expected):
    cloned = False
    if sys.platform == 'darwin':
        libc = ctypes.CDLL(None, use_errno=True)
        clone = getattr(libc, 'fclonefileat', None)
        if clone:
            clone.argtypes = [ctypes.c_int,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint]
            clone.restype = ctypes.c_int
            cloned = clone(source, parent, os.fsencode(name), 0) == 0
    if not cloned:
        out = os.open(name, os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW, 0o600, dir_fd=parent)
        try:
            while True:
                check()
                chunk = os.read(source, 1024*1024)
                if not chunk: break
                view = memoryview(chunk)
                while view:
                    check()
                    written = os.write(out, view)
                    if written <= 0: raise OSError(errno.EIO,'copy failed')
                    view = view[written:]
            os.fsync(out)
        finally: os.close(out)
    else:
        out = os.open(name, READ, dir_fd=parent)
        try:
            os.fchmod(out, 0o600)
            os.fsync(out)
        finally: os.close(out)
    if identity(os.fstat(source)) != expected: raise Changed()

def run(cfg, drive, data, reply):
    if data['fingerprint'] != cfg['fingerprint']: raise Changed()
    remaining = cfg.get('remaining')
    if remaining is None: remaining = max(0, cfg['total'] - drive_usage(drive))
    if data['counts']['bytes'] > remaining: raise Refused('quota_unknown') if remaining < 0 else OSError(errno.EDQUOT, 'no room')
    parent = import_parent(cfg, True)
    stage = None
    stage_stat = None
    plan = cfg['planId']
    if not re.fullmatch(r'[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}', plan):
        os.close(parent)
        raise Refused('unavailable')
    try:
        if os.fstat(parent).st_dev != os.fstat(drive).st_dev: raise Refused('staging_volume')
        os.mkdir(plan, 0o700, dir_fd=parent)
        stage = os.open(plan, DIR, dir_fd=parent)
        stage_stat = os.fstat(stage)
        marker = os.open('.atum-import.json', os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW, 0o600, dir_fd=stage)
        try:
            os.write(marker, json.dumps({'version':1,'planId':plan,'createdAt':int(time.time()*1000)}).encode())
            os.fsync(marker)
        finally: os.close(marker)
        os.fsync(stage)
        os.fsync(parent)
        for index, _ in data['top']: os.mkdir(str(index), 0o700, dir_fd=stage)
        copied = 0
        directories = []
        for index, rel, kind, expected in data['rows']:
            check()
            parts = [str(index),'payload'] + rel
            destination = stage_directory(stage, parts[:-1])
            try:
                if kind == 'folder':
                    os.mkdir(parts[-1], 0o700, dir_fd=destination)
                    directories.append(parts)
                else:
                    source = source_file(cfg,index,rel,expected)
                    try: copy_file(source,destination,parts[-1],expected)
                    finally: os.close(source)
                    copied += 1
                    if cfg.get('testCancelAfterCopy') == copied: raise Cancelled()
            finally: os.close(destination)
        for parts in reversed(directories):
            fd = stage_directory(stage,parts)
            try: os.fsync(fd)
            finally: os.close(fd)
        # A changed source selection after the copy is not silently imported.
        if inventory(cfg)['fingerprint'] != cfg['fingerprint']: raise Changed()
        if cfg.get('remaining') is None and data['counts']['bytes'] > max(0, cfg['total'] - drive_usage(drive)): raise OSError(errno.EDQUOT,'no room')
        for index, name in data['top']:
            check()
            # Revalidate account/fence in main after copying, before every placement.
            print(json.dumps({'checkTarget':True}),flush=True)
            answer = json.loads(sys.stdin.readline())
            if answer.get('place') is not True: raise Cancelled()
            check()
            current = bound_target(cfg)
            os.close(current)
            source = stage_directory(stage,[str(index)])
            try:
                suffix = 2 if name.casefold() == 'agents' else 1
                while suffix <= 1000:
                    check()
                    leaf = name if suffix == 1 else name + ' (' + str(suffix) + ')'
                    try:
                        exclusive_rename(source,'payload',drive,leaf)
                        reply['added'] += 1
                        os.fsync(drive)
                        break
                    except OSError as error:
                        if error.errno not in (errno.EEXIST,errno.ENOTEMPTY): raise
                        suffix += 1
                else: raise Refused('unavailable')
            finally: os.close(source)
        reply['state'] = 'completed'
    finally:
        if stage is not None:
            os.close(stage)
            current = os.stat(plan,dir_fd=parent,follow_symlinks=False)
            if [current.st_dev,current.st_ino] == [stage_stat.st_dev,stage_stat.st_ino] and shutil.rmtree.avoids_symlink_attacks:
                shutil.rmtree(plan,dir_fd=parent)
                os.fsync(parent)
        os.close(parent)

reply = {'state':'unavailable','added':0}
drive = None
try:
    cfg = json.loads(sys.stdin.readline())
    if cfg['mode'] == 'cleanup':
        cleanup(cfg)
        reply['state'] = 'completed'
    else:
        drive = bound_target(cfg)
        data = inventory(cfg)
        if cfg['mode'] == 'plan':
            used = drive_usage(drive) if cfg.get('remaining') is None else 0
            reply.update(data['counts'])
            reply.update({'state':'planned','skipped':data['skipped'],'used':used,'fingerprint':data['fingerprint']})
        else: run(cfg,drive,data,reply)
except Cancelled: reply['state'] = 'cancelled'
except Changed: reply['state'] = 'changed'
except Refused as error: reply.update({'state':'refused','reason':error.reason})
except OSError as error:
    reply['state'] = 'no_room' if error.errno in (errno.ENOSPC,errno.EDQUOT) else 'unavailable'
except: reply['state'] = 'unavailable'
finally:
    if drive is not None: os.close(drive)
print(json.dumps(reply,separators=(',',':')))
`
