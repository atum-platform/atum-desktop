import Foundation
import Security

// Atum Keys: the person's recovery key in iCloud Keychain, so a new Mac on the same Apple ID
// unlocks by itself ( WS-D).
//
// A separate, separately provisioned helper app: the synced data-protection keychain needs a
// keychain access group authorized by a Developer ID provisioning profile, which only an app-like
// bundle can carry (TN3137). Kept out of the main app, a broken, expired or missing profile costs
// only this helper (the app falls back to its own vault), never the app's launch.
//
// One JSON request on stdin, one JSON answer on stdout. The key arrives on stdin only, never as
// an argument, and is never written anywhere but the keychain item.
//
//   {"op":"probe"}                                   -> {"ok":true}
//   {"op":"read","account":"@user:server"}           -> {"ok":true,"value":"…"} | {"ok":false,"code":"not_found"}
//   {"op":"write","account":"…","value":"…"}         -> {"ok":true}
//   {"op":"remove","account":"…"}                    -> {"ok":true}   (removes it on every device)
//
// Errors: unprovisioned (errSecMissingEntitlement: no profile, or the wrong one), locked
// (errSecInteractionNotAllowed: before the first unlock), not_found, invalid, error, and caller:
//
// Only Atum itself reads, writes or removes the key. The process that started this helper must be
// signed by Atum's team with the app's own identifier (`callerRequirement`), checked once the
// request has been read, right before the keychain is touched; anything else (a script, a shell,
// another app) gets {"ok":false,"code":"caller"}, and so does a helper whose parent already
// exited (launchd adopted it). `probe` answers anyone: it reads an item that holds no secret and
// never returns a value, and the release check runs it from the build script.
//
// A pid names a process, not a program: a caller that runs Atum's own binary as Node
// (ELECTRON_RUN_AS_NODE) or execs it under the same pid passes. That is the same boundary as the
// app's own vault, whose keychain item is bound to the same signature; closing both needs
// Electron's RunAsNode fuse off ( review round 1).

private let service = "io.atum.owner-recovery.v1"
private let accessGroup = "7D5FC62RXD.com.atum.shared"
private let probeAccount = "io.atum.probe"

#if ATUM_KEYS_CALLER_TEST
// Test builds only (scripts/atum-keys-caller.test.mjs): an ad-hoc signed parent with this
// identifier stands in for Atum, so the check is proven to let the right caller through.
private let callerRequirement = #"identifier "com.atum.keys-caller-test""#
#else
private let callerRequirement =
    #"anchor apple generic and certificate leaf[subject.OU] = "7D5FC62RXD" and identifier "com.atum.matrix-candidate""#
#endif

/// The process that started this helper is Atum: its running code satisfies `callerRequirement`.
private func callerIsAtum() -> Bool {
    let parent = getppid()

    // Orphaned (the caller exited) or started by launchd: nobody vouches for this request.
    guard parent > 1 else { return false }

    var requirement: SecRequirement?
    guard SecRequirementCreateWithString(callerRequirement as CFString, [], &requirement) == errSecSuccess,
          let requirement else { return false }

    var code: SecCode?
    let attributes = [kSecGuestAttributePid as String: NSNumber(value: parent)] as CFDictionary
    guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &code) == errSecSuccess, let code else { return false }

    // The running process (its kernel-validated signature, not just a file on disk) meets it.
    return SecCodeCheckValidity(code, [], requirement) == errSecSuccess
}

private func emit(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value) {
        FileHandle.standardOutput.write(data)
    }
}

private func failure(_ status: OSStatus) -> [String: Any] {
    switch status {
    case errSecMissingEntitlement: return ["ok": false, "code": "unprovisioned"]
    case errSecInteractionNotAllowed: return ["ok": false, "code": "locked"]
    case errSecItemNotFound: return ["ok": false, "code": "not_found"]
    default: return ["ok": false, "code": "error", "status": Int(status)]
    }
}

private func base(_ account: String) -> [String: Any] {
    [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
        kSecAttrAccessGroup as String: accessGroup,
        kSecUseDataProtectionKeychain as String: true
    ]
}

// A Matrix user ID, or the probe's own account: never free text.
private func validAccount(_ value: Any?) -> String? {
    guard let account = value as? String, account.count <= 1024 else { return nil }
    if account == probeAccount { return account }
    return account.range(of: "^@[!-9;-~]+:[!-~]+$", options: .regularExpression) != nil ? account : nil
}

private func read(_ account: String) -> [String: Any] {
    var query = base(account)
    query[kSecAttrSynchronizable as String] = kSecAttrSynchronizableAny
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    guard status == errSecSuccess else { return failure(status) }
    guard let data = result as? Data, let value = String(data: data, encoding: .utf8) else {
        return ["ok": false, "code": "error"]
    }
    return ["ok": true, "value": value]
}

private func write(_ account: String, _ value: String) -> [String: Any] {
    guard let data = value.data(using: .utf8), data.count <= 4096 else { return ["ok": false, "code": "invalid"] }
    var item = base(account)
    item[kSecAttrSynchronizable as String] = true
    // Not "this device only": the point is that it syncs. Readable once the Mac was unlocked
    // after a restart, so a launch at login finds it.
    item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
    item[kSecAttrLabel as String] = "Atum recovery key"
    item[kSecValueData as String] = data
    let status = SecItemAdd(item as CFDictionary, nil)

    if status == errSecDuplicateItem {
        var query = base(account)
        query[kSecAttrSynchronizable as String] = true
        let update: [String: Any] = [kSecValueData as String: data]
        let updated = SecItemUpdate(query as CFDictionary, update as CFDictionary)
        return updated == errSecSuccess ? ["ok": true] : failure(updated)
    }

    return status == errSecSuccess ? ["ok": true] : failure(status)
}

private func remove(_ account: String) -> [String: Any] {
    var query = base(account)
    query[kSecAttrSynchronizable as String] = kSecAttrSynchronizableAny
    let status = SecItemDelete(query as CFDictionary)
    return status == errSecSuccess || status == errSecItemNotFound ? ["ok": true] : failure(status)
}

private func run() -> [String: Any] {
    let input = FileHandle.standardInput.readDataToEndOfFile()

    guard input.count <= 8192,
          let request = try? JSONSerialization.jsonObject(with: input) as? [String: Any],
          let op = request["op"] as? String else {
        return ["ok": false, "code": "invalid"]
    }

    if op == "probe" {
        // Reading an item that need not exist proves the access group is authorized.
        let result = read(probeAccount)
        if result["ok"] as? Bool == true || (result["code"] as? String) == "not_found" {
            return ["ok": true]
        }
        return result
    }

    // The key itself: for Atum only, and decided before the keychain is touched.
    guard callerIsAtum() else { return ["ok": false, "code": "caller"] }

    switch op {
    case "read":
        guard let account = validAccount(request["account"]) else { return ["ok": false, "code": "invalid"] }
        return read(account)
    case "write":
        guard let account = validAccount(request["account"]), let value = request["value"] as? String else {
            return ["ok": false, "code": "invalid"]
        }
        return write(account, value)
    case "remove":
        guard let account = validAccount(request["account"]) else { return ["ok": false, "code": "invalid"] }
        return remove(account)
    default:
        return ["ok": false, "code": "invalid"]
    }
}

emit(run())
