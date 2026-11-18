// Fixed OpenSSH forced command. No environment commands, OAuth, or provider calls.
import Foundation
import Darwin

// Complete JSON envelope bound shared with the desktop relay transports.
let limit = 16 * 1024 * 1024
let deadline = Date().addingTimeInterval(65)
var submitted = false
func fail(_ code: String) -> Never {
    let data = try! JSONSerialization.data(withJSONObject: [
        "state": "refused", "status": code == "unavailable" ? 503 : 409,
        "code": code, "retryable": code == "unavailable"
    ])
    FileHandle.standardOutput.write(data)
    exit(1)
}
func waitFor(_ fd: Int32, _ events: Int16) {
    let remaining = Int32(max(0, deadline.timeIntervalSinceNow * 1000))
    var p = pollfd(fd: fd, events: events, revents: 0)
    if remaining == 0 || poll(&p, 1, remaining) <= 0 { fail(submitted ? "stopped" : "unavailable") }
}
func readBounded(_ fd: Int32) -> Data {
    var result = Data()
    var buffer = [UInt8](repeating: 0, count: 8192)
    while true {
        waitFor(fd, Int16(POLLIN))
        let count = read(fd, &buffer, buffer.count)
        if count == 0 { return result }
        if count < 0 { fail(submitted ? "stopped" : "invalid_request") }
        if result.count + count > limit { fail("request_too_large") }
        result.append(contentsOf: buffer.prefix(count))
    }
}
func uuid(_ value: String) -> Bool {
    value.range(of: "^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$", options: .regularExpression) != nil
}
signal(SIGPIPE, SIG_IGN)
alarm(70) // A blocked stdout or kernel write must also have a finite lifetime.
let args = CommandLine.arguments
if args.count != 4 || !uuid(args[1]) || !uuid(args[2]) { fail("invalid_request") }
guard let epoch = Int(args[3]), epoch > 0, epoch <= 9_007_199_254_740_991,
      let home = getpwuid(getuid())?.pointee.pw_dir else { fail("invalid_request") }
let raw = readBounded(STDIN_FILENO)
guard var body = (try? JSONSerialization.jsonObject(with: raw)) as? [String: Any] else { fail("invalid_request") }
let fixed: [String: Any] = ["ownerPrincipal": args[1], "agentPrincipal": args[2], "connectionEpoch": epoch]
for (key, value) in fixed {
    if let existing = body[key], !((existing as AnyObject).isEqual(value)) { fail("invalid_request") }
    body[key] = value
}
guard let request = try? JSONSerialization.data(withJSONObject: body), request.count <= limit else { fail("request_too_large") }
let file = String(cString: home) + "/.atum-chatgpt-relay/relay.sock"
// The helper and desktop agree on a fixed owner-only socket, never an argv/environment path.
var directory = stat(), info = stat()
if lstat(String(cString: home) + "/.atum-chatgpt-relay", &directory) != 0 ||
   directory.st_uid != getuid() || directory.st_mode & 0o777 != 0o700 || directory.st_mode & S_IFMT != S_IFDIR ||
   lstat(file, &info) != 0 || info.st_uid != getuid() || info.st_mode & 0o777 != 0o600 || info.st_mode & S_IFMT != S_IFSOCK {
    fail("unavailable")
}
let fd = socket(AF_UNIX, SOCK_STREAM, 0)
if fd < 0 { fail("unavailable") }
var address = sockaddr_un()
address.sun_family = sa_family_t(AF_UNIX)
let bytes = Array(file.utf8) + [0]
if bytes.count > MemoryLayout.size(ofValue: address.sun_path) { fail("unavailable") }
withUnsafeMutableBytes(of: &address.sun_path) { target in target.copyBytes(from: bytes) }
let connected = withUnsafePointer(to: &address) {
    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
}
if connected != 0 { fail("unavailable") }
// From the first write onward a lost response is ambiguous and must never be retried.
submitted = true
request.withUnsafeBytes { bytes in
    var offset = 0
    while offset < bytes.count {
        waitFor(fd, Int16(POLLOUT))
        let count = write(fd, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
        if count <= 0 { fail("stopped") }
        offset += count
    }
}
shutdown(fd, SHUT_WR)
let response = readBounded(fd)
close(fd)
if response.isEmpty || (try? JSONSerialization.jsonObject(with: response)) == nil { fail("stopped") }
FileHandle.standardOutput.write(response)
