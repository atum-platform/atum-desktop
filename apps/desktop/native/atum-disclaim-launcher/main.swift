import Darwin
import Foundation

// atum-disclaim-launcher — spawns a child whose TCC responsibility is disclaimed
// (WS-4 prototype, G0-SB).
//
// macOS attributes privacy grants (Automation / Apple Events, Accessibility /
// synthetic input, Screen Recording, …) to the *responsible* process of a tree,
// not the leaf. A plain child of Atum.app inherits Atum's responsibility, so an
// agent command could reach, say, `osascript -> System Events` under Atum's
// Automation grant, or post synthetic events under Atum's Accessibility grant —
// sidestepping the whole device sandbox. Disclaiming responsibility makes the
// child answer for itself: a fresh, ungranted Developer ID binary with no TCC
// grants at all. Seatbelt cannot block Apple Events (confirmed in G0), so this
// launcher plus the exec denies on the osascript family are how that channel is
// actually closed.
//
// `responsibility_spawnattrs_setdisclaim` is a private libsystem SPI; it is the
// same mechanism Terminal and other shells use so their children answer for
// themselves. Declared here by symbol name.
//
// Usage: atum-disclaim-launcher [--disclaim 0|1] -- <program> [args...]
//   --disclaim 1  (default) child is responsible for itself (no inherited grants)
//   --disclaim 0  child inherits the caller's responsibility (for an A/B probe)
// stdio and environment are inherited; the launcher waits and forwards the exit
// status. The --disclaim flag exists only so the acceptance probe can isolate the
// single variable; the shipping device host always disclaims.
//
//        atum-disclaim-launcher --sweep <pid>
//   Kills (SIGKILL) every process whose responsible process is <pid>, except <pid>
//   itself, and prints {"killed":[...]}. The disclaimed device host is responsible
//   for itself, and responsibility is inherited across fork, exec and setsid, so
//   this reaches every descendant of the host, including a double-forked daemon
//   that left its process group (whose environment `ps -E` cannot show for an
//   Apple platform binary). Electron main runs it after a Stop.

@_silgen_name("responsibility_spawnattrs_setdisclaim")
func responsibility_spawnattrs_setdisclaim(_ attr: UnsafeMutablePointer<posix_spawnattr_t?>, _ disclaim: Int32) -> Int32

@_silgen_name("responsibility_get_pid_responsible_for_pid")
func responsibility_get_pid_responsible_for_pid(_ pid: pid_t) -> pid_t

private func die(_ message: String, code: Int32 = 127) -> Never {
    FileHandle.standardError.write(Data("atum-disclaim-launcher: \(message)\n".utf8))
    exit(code)
}

var args = Array(CommandLine.arguments.dropFirst())

// Collection needs a proof, not Stop's best-effort sweep. Stop the responsible host first so
// it cannot spawn more writers, stop/kill its descendants (including setsid daemons), and
// verify no live member of that responsibility tree remains before reporting quiescence.
if args.first == "--quiesce" {
    guard args.count == 2, let target = pid_t(args[1]), target > 1, target != getpid(), target != getppid(),
          responsibility_get_pid_responsible_for_pid(target) == target else {
        die("invalid quiescence target", code: 64)
    }
    guard kill(target, SIGSTOP) == 0 else { die("cannot stop quiescence target") }
    var stopped = false
    for _ in 0..<200 {
        var info = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        guard proc_pidinfo(target, PROC_PIDTBSDINFO, 0, &info, size) == size else { die("cannot inspect quiescence target") }
        if info.pbi_status == SSTOP { stopped = true; break }
        usleep(10_000)
    }
    guard stopped else { die("quiescence target did not stop") }
    var killed = Set<pid_t>()
    func members() -> [pid_t] {
        let capacity = Int(proc_listallpids(nil, 0)) + 256
        guard capacity > 256 else { die("cannot enumerate processes") }
        var pids = [pid_t](repeating: 0, count: capacity)
        let count = pids.withUnsafeMutableBufferPointer {
            proc_listallpids($0.baseAddress, Int32($0.count * MemoryLayout<pid_t>.size))
        }
        guard count > 0, count < capacity else { die("incomplete process enumeration") }
        return pids.prefix(Int(count)).filter { pid in
            guard pid > 1, pid != target, pid != getpid(), responsibility_get_pid_responsible_for_pid(pid) == target else { return false }
            var info = proc_bsdinfo()
            let size = Int32(MemoryLayout<proc_bsdinfo>.size)
            let found = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size)
            // A gone process cannot write; a live process with unreadable facts is a failed proof.
            if found == 0 && kill(pid, 0) != 0 && errno == ESRCH { return false }
            guard found == size else { die("cannot inspect responsible process") }
            return info.pbi_status != SZOMB
        }
    }
    var quiet = false
    for _ in 0..<200 {
        let live = members()
        if live.isEmpty { quiet = true; break }
        for pid in live {
            if kill(pid, SIGSTOP) != 0 && errno != ESRCH { die("cannot stop responsible process") }
            if kill(pid, SIGKILL) == 0 { killed.insert(pid) }
            else if errno != ESRCH { die("cannot kill responsible process") }
        }
        usleep(10_000)
    }
    guard quiet else { die("responsible processes remain") }
    guard kill(target, SIGKILL) == 0 || errno == ESRCH else { die("cannot kill quiescence target") }
    print("{\"quiescent\":true,\"killed\":[\(killed.sorted().map { String($0) }.joined(separator: ","))]}")
    exit(0)
}

if args.first == "--sweep" {
    guard args.count == 2, let target = pid_t(args[1]), target > 1, target != getpid(), target != getppid() else {
        die("usage: atum-disclaim-launcher --sweep <pid>", code: 64)
    }
    let capacity = Int(proc_listallpids(nil, 0)) + 256
    var pids = [pid_t](repeating: 0, count: capacity)
    let count = pids.withUnsafeMutableBufferPointer {
        proc_listallpids($0.baseAddress, Int32($0.count * MemoryLayout<pid_t>.size))
    }
    var killed: [pid_t] = []
    for pid in pids.prefix(max(0, Int(count))) where pid > 1 && pid != target && pid != getpid() {
        if responsibility_get_pid_responsible_for_pid(pid) == target && kill(pid, SIGKILL) == 0 {
            killed.append(pid)
        }
    }
    print("{\"killed\":[\(killed.map { String($0) }.joined(separator: ","))]}")
    exit(0)
}

var disclaim: Int32 = 1
while let first = args.first, first.hasPrefix("--") {
    if first == "--disclaim", args.count >= 2 {
        disclaim = (args[1] == "0") ? 0 : 1
        args.removeFirst(2)
    } else if first == "--" {
        args.removeFirst()
        break
    } else {
        die("unknown option \(first)")
    }
}
guard !args.isEmpty else { die("usage: atum-disclaim-launcher [--disclaim 0|1] -- <program> [args...]") }

let program = args[0]

var attr: posix_spawnattr_t?
guard posix_spawnattr_init(&attr) == 0 else { die("posix_spawnattr_init failed") }
defer { posix_spawnattr_destroy(&attr) }

// Reset signal dispositions and start the child in its own process group so the
// device host can kill the whole tree on Stop.
posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETSID))

if responsibility_spawnattrs_setdisclaim(&attr, disclaim) != 0 {
    die("responsibility_spawnattrs_setdisclaim failed")
}

// Build the C argv (NULL-terminated).
var cargs: [UnsafeMutablePointer<CChar>?] = args.map { strdup($0) }
cargs.append(nil)
defer { for p in cargs where p != nil { free(p) } }

var pid: pid_t = 0
let rc: Int32 = program.contains("/")
    ? posix_spawn(&pid, program, nil, &attr, &cargs, environ)
    : posix_spawnp(&pid, program, nil, &attr, &cargs, environ)
if rc != 0 { die("spawn failed: \(String(cString: strerror(rc)))") }

var status: Int32 = 0
while waitpid(pid, &status, 0) == -1 && errno == EINTR {}

if (status & 0x7f) == 0 {
    exit((status >> 8) & 0xff)          // normal exit, forward code
} else {
    exit(128 + (status & 0x7f))         // killed by signal
}
