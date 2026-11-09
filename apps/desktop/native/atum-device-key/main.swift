import CryptoKit
import Foundation
import LocalAuthentication

// atum-device-key — the Mac device service's Secure Enclave signer (S1 WS-3b,
// contract atum.device-service/1 §3.3, proven by G0-SE).
//
// Two P-256 keys live in the Secure Enclave:
//   * identity  (.privateKeyUsage)                 — Hello, Proof, receipts and origin
//                                                    assertions. Signs with no prompt, and
//                                                    (AfterFirstUnlock) while the screen is
//                                                    LOCKED: macOS locks the WhenUnlocked
//                                                    keybag class at screen lock, which made the
//                                                    device connection fail every night
//                                                    (`device_key_failed`, 8,197 log lines
//                                                    10-12→10-20). Keys made before this change
//                                                    keep WhenUnlocked; the class is fixed in the
//                                                    blob.
//   * approval  (.privateKeyUsage)                 — enrollment, rotation, approvals and
//                                                    standing grants. Enrollment signs only a
//                                                    validated EnrollDevice frame and never asks.
//                                                    Protected actions still pass a fresh Touch ID
//                                                    (or macOS password) check in `approve`.
//
// The Secure Enclave only ever returns a device-bound wrapped blob, stored 0600 in the
// key directory; it is useless off this chip and the helper never prints a private key.
//
// The helper signs a SHA-256 DIGEST. Electron main frames every message itself
// (`utf8("atum.device-service.v1\0" + type + "\0") || canonicalJson(body)` for the
// device-service protocol, `utf8("atum.origin.v1\0") || canonicalJson(assertion)` for an
// origin assertion), hashes it, and passes the 32 bytes here. An ECDSA signature over that
// digest is exactly ES256 over the framed bytes, so the controller and DA verify it with
// Node `crypto.verify('sha256', framed, {key, dsaEncoding: 'ieee-p1363'}, sig)`. Keeping the
// framing out of the helper keeps one canonical implementation (in TypeScript) and lets one
// helper serve both domains.
//
// Commands (all output is one JSON object on stdout):
//   create                      [--keydir DIR]  create both keys if missing; print public info
//   public                      [--keydir DIR]  reload both keys from their blobs; print public info
//   sign-identity <digestB64u>  [--keydir DIR]  ES256 over the digest with the identity key
//   sign-enrollment <frameB64u> [--keydir DIR]  validate and sign one EnrollDevice frame
//   approve <digestB64u> <reason...> [--keydir DIR]
//                                               a fresh user-presence check whose prompt is
//                                               <reason>, then ES256 with the approval key
//   delete                      [--keydir DIR]  remove both blobs (a revoked enrollment's keys)
//
// Exit codes: 0 ok; 2 the approval was not given (cancelled, timed out, refused, or the key
// refused to sign); 1 anything else.

private func emit(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
    }
}

private func fail(_ message: String, code: Int32 = 1) -> Never {
    emit(["ok": false, "error": message])
    exit(code)
}

// Unpadded base64url, the contract's encoding for key IDs, keys and signatures.
private func b64url(_ data: Data) -> String {
    var s = data.base64EncodedString()
    s = s.replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
    while s.hasSuffix("=") { s.removeLast() }
    return s
}

private func b64urlDecode(_ value: String) -> Data? {
    guard value.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil else { return nil }
    var s = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    let pad = s.count % 4
    if pad == 1 { return nil }
    if pad != 0 { s += String(repeating: "=", count: 4 - pad) }
    return Data(base64Encoded: s)
}

// kid = base64url(sha256(SPKI DER)), 43 characters.
private func keyId(_ publicKey: P256.Signing.PublicKey) -> String {
    b64url(Data(SHA256.hash(data: publicKey.derRepresentation)))
}

private func publicInfo(_ publicKey: P256.Signing.PublicKey) -> [String: Any] {
    ["kid": keyId(publicKey), "spki": b64url(publicKey.derRepresentation)]
}

// A precomputed SHA-256 digest, so CryptoKit signs it as-is (ECDSA over the digest)
// instead of hashing the input a second time.
private struct PrecomputedSHA256: Digest {
    static var byteCount: Int { 32 }
    let bytes: [UInt8]

    func withUnsafeBytes<R>(_ body: (UnsafeRawBufferPointer) throws -> R) rethrows -> R {
        try bytes.withUnsafeBytes(body)
    }

    func makeIterator() -> Array<UInt8>.Iterator { bytes.makeIterator() }
    var description: String { "PrecomputedSHA256" }
}

private func digest(_ value: String) -> PrecomputedSHA256 {
    guard let data = b64urlDecode(value), data.count == 32 else { fail("digest_invalid") }
    return PrecomputedSHA256(bytes: [UInt8](data))
}

struct KeyDir {
    let url: URL
    var identityBlob: URL { url.appendingPathComponent("identity.key") }
    var approvalBlob: URL { url.appendingPathComponent("approval.key") }
    var silentEnrollmentMarker: URL { url.appendingPathComponent("silent-enrollment-v1") }

    func ensure() throws {
        try FileManager.default.createDirectory(
            at: url, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.path)
    }

    func write(_ data: Data, to target: URL) throws {
        try data.write(to: target, options: [.atomic])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: target.path)
    }
}

private func defaultKeyDir() -> URL {
    // Electron main always passes --keydir (<userData>/device/keys/<owner>). This default is
    // only a developer fallback and is never used by a packaged run.
    let home = FileManager.default.homeDirectoryForCurrentUser
    return home.appendingPathComponent(".atum/device-key", isDirectory: true)
}

private func requireSecureEnclave() {
    guard SecureEnclave.isAvailable else { fail("secure_enclave_unavailable") }
}

private func accessControl() -> SecAccessControl {
    let flags: SecAccessControlCreateFlags = [.privateKeyUsage]
    // Both keys must support routine enrollment/channel work after screen lock. Protected uses of
    // the approval key still pass the explicit, zero-reuse LocalAuthentication gate in `approve`.
    let accessible = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    var error: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(
        nil, accessible, flags, &error) else {
        fail("access_control_failed: \(error?.takeRetainedValue().localizedDescription ?? "unknown")")
    }
    return access
}

private func load(_ blob: URL, context: LAContext? = nil) throws -> SecureEnclave.P256.Signing.PrivateKey {
    let data = try Data(contentsOf: blob)
    if let context {
        return try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: data, authenticationContext: context)
    }
    return try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: data)
}

private func parseArgs(_ args: [String]) -> (KeyDir, [String]) {
    var rest: [String] = []
    var dir = defaultKeyDir()
    var i = 0
    while i < args.count {
        if args[i] == "--keydir", i + 1 < args.count {
            dir = URL(fileURLWithPath: args[i + 1], isDirectory: true)
            i += 2
        } else {
            rest.append(args[i]); i += 1
        }
    }
    return (KeyDir(url: dir), rest)
}

private func cmdCreate(_ dir: KeyDir) {
    requireSecureEnclave()
    do {
        try dir.ensure()
        let fm = FileManager.default
        // Both or neither: a half-made pair (a crash between the two writes) is remade whole,
        // never paired with a stray key.
        var haveIdentity = fm.fileExists(atPath: dir.identityBlob.path)
        var haveApproval = fm.fileExists(atPath: dir.approvalBlob.path)
        if haveIdentity != haveApproval {
            try? fm.removeItem(at: dir.identityBlob)
            try? fm.removeItem(at: dir.approvalBlob)
            haveIdentity = false
            haveApproval = false
        }
        // Before desktop 0.20.19 the approval key itself required user presence. That pair is
        // nevertheless this physical Mac's durable identity: replacing both blobs here made an
        // app update look like a new Mac. Keep it as-is. Only a genuinely new pair receives the
        // silent-enrollment marker below; Electron also asks `public` before `create`.
        let identity: SecureEnclave.P256.Signing.PrivateKey
        let approval: SecureEnclave.P256.Signing.PrivateKey
        var created = false
        if haveIdentity && haveApproval {
            identity = try load(dir.identityBlob)
            approval = try load(dir.approvalBlob)
        } else {
            identity = try SecureEnclave.P256.Signing.PrivateKey(accessControl: accessControl())
            approval = try SecureEnclave.P256.Signing.PrivateKey(accessControl: accessControl())
            try dir.write(approval.dataRepresentation, to: dir.approvalBlob)
            try dir.write(identity.dataRepresentation, to: dir.identityBlob)
            try dir.write(Data("1\n".utf8), to: dir.silentEnrollmentMarker)
            created = true
        }
        emit([
            "ok": true,
            "created": created,
            "identity": publicInfo(identity.publicKey),
            "approval": publicInfo(approval.publicKey)
        ])
    } catch {
        fail("create_failed: \(error)")
    }
}

private func cmdPublic(_ dir: KeyDir) {
    do {
        let identity = try load(dir.identityBlob)
        let approval = try load(dir.approvalBlob)
        emit(["ok": true, "identity": publicInfo(identity.publicKey), "approval": publicInfo(approval.publicKey)])
    } catch {
        fail("keys_missing")
    }
}

private func cmdDelete(_ dir: KeyDir) {
    let fm = FileManager.default
    for blob in [dir.identityBlob, dir.approvalBlob, dir.silentEnrollmentMarker] where fm.fileExists(atPath: blob.path) {
        do { try fm.removeItem(at: blob) } catch { fail("delete_failed: \(error)") }
    }
    emit(["ok": true])
}

private func cmdSignIdentity(_ dir: KeyDir, _ rest: [String]) {
    guard rest.count == 1 else { fail("usage: sign-identity <digestB64u> [--keydir DIR]") }
    let value = digest(rest[0])
    do {
        let identity = try load(dir.identityBlob)
        let signature = try identity.signature(for: value)
        emit(["ok": true, "kid": keyId(identity.publicKey), "sig": b64url(signature.rawRepresentation)])
    } catch {
        fail("sign_identity_failed: \(error)")
    }
}

private func cmdSignEnrollment(_ dir: KeyDir, _ rest: [String]) {
    guard rest.count == 1, let frame = b64urlDecode(rest[0]), frame.count <= 65536 else {
        fail("usage: sign-enrollment <frameB64u> [--keydir DIR]")
    }
    let prefix = Data("atum.device-service.v1\0EnrollDevice\0".utf8)
    guard frame.starts(with: prefix), frame.count > prefix.count else { fail("enrollment_invalid") }
    let value = PrecomputedSHA256(bytes: [UInt8](SHA256.hash(data: frame)))
    do {
        let approval = try load(dir.approvalBlob)
        let signature = try approval.signature(for: value)
        emit(["ok": true, "kid": keyId(approval.publicKey), "sig": b64url(signature.rawRepresentation)])
    } catch {
        fail("sign_enrollment_failed: \(error)")
    }
}

private func cmdApprove(_ dir: KeyDir, _ rest: [String]) {
    guard rest.count >= 2 else { fail("usage: approve <digestB64u> <reason> [--keydir DIR]") }
    let value = digest(rest[0])
    let reason = rest[1...].joined(separator: " ")
    guard !reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, reason.count <= 600 else {
        fail("reason_invalid")
    }
    let requested = Double(ProcessInfo.processInfo.environment["ATUM_APPROVE_TIMEOUT"] ?? "") ?? 600
    let timeout = min(max(requested, 1), 900)

    let context = LAContext()
    context.localizedFallbackTitle = ""
    // No reuse, ever (G0 finding F2): every approval needs its OWN fresh presence check, never
    // a Touch ID the owner gave moments earlier for something else. With a reuse window, an
    // agent could ride an unrelated unlock to get a protected action approved.
    context.touchIDAuthenticationAllowableReuseDuration = 0

    var policyError: NSError?
    // .deviceOwnerAuthentication: Touch ID where present, otherwise the macOS password dialog
    // (the Mac mini without a Touch ID keyboard, owner decision Q4).
    guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &policyError) else {
        fail("presence_unavailable: \(policyError?.localizedDescription ?? "unknown")")
    }

    let semaphore = DispatchSemaphore(value: 0)
    var granted = false
    var evalError: Error?
    context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { ok, error in
        granted = ok
        evalError = error
        semaphore.signal()
    }
    if semaphore.wait(timeout: .now() + timeout) == .timedOut {
        context.invalidate()
        fail("approval_timeout", code: 2)
    }
    if !granted {
        switch (evalError as? LAError)?.code {
        case .userCancel, .systemCancel, .appCancel, .authenticationFailed, .userFallback:
            fail("approval_denied", code: 2)
        default:
            fail("approval_failed: \(evalError?.localizedDescription ?? "unknown")", code: 2)
        }
    }

    do {
        let approval = try load(dir.approvalBlob)
        let signature = try approval.signature(for: value)
        context.invalidate()
        emit(["ok": true, "kid": keyId(approval.publicKey), "sig": b64url(signature.rawRepresentation)])
    } catch {
        // A refusal to sign after a granted check is a non-approval, never a silent pass.
        context.invalidate()
        fail("approval_sign_failed", code: 2)
    }
}

let argv = Array(CommandLine.arguments.dropFirst())
guard let command = argv.first else {
    fail("usage: atum-device-key <create|public|sign-identity|sign-enrollment|approve|delete> [...]")
}
let (keyDir, rest) = parseArgs(Array(argv.dropFirst()))
switch command {
case "create": cmdCreate(keyDir)
case "public": cmdPublic(keyDir)
case "sign-identity": cmdSignIdentity(keyDir, rest)
case "sign-enrollment": cmdSignEnrollment(keyDir, rest)
case "approve": cmdApprove(keyDir, rest)
case "delete": cmdDelete(keyDir)
default: fail("unknown_command: \(command)")
}
