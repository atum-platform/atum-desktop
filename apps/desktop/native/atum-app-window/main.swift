import AppKit
import ApplicationServices
import Carbon

struct Rect: Codable {
    let x: Double; let y: Double; let width: Double; let height: Double
    var cg: CGRect { CGRect(x: x, y: y, width: width, height: height) }
    init(_ rect: CGRect) { x = rect.minX; y = rect.minY; width = rect.width; height = rect.height }
}
struct Request: Decodable {
    let operation: String
    let appPath: String?
    let bundleId: String?
    let windowId: Int?
    let bounds: Rect?
    let processId: Int?
    let documentPath: String?
}
struct Window: Codable {
    let id: Int
    let title: String
    let bounds: Rect
    let fullscreen: Bool
    let minimized: Bool
}
struct DocumentWindow: Codable {
    let appPath: String
    let bundleId: String
    let processId: Int
    let windowId: Int
    let title: String
    let documentPath: String?
}
struct Response: Encodable {
    var windows: [Window]?
    var bounds: Rect?
    var error: String?
    var icons: [String: String]?
    var names: [String: String]?
    var documents: [DocumentWindow]?
    var documentPath: String?
    var automationAllowed: Bool?
}
struct IconRequest: Decodable { let operation: String; let paths: [String] }

// App artwork and Finder names are metadata. Neither requires Accessibility
// or a running app. Artwork renders at 112 px: the launcher grid draws 56 CSS
// px tiles on 2x displays. Names are Finder's localized display names ("Lịch",
// not "Calendar"), independent of Spotlight indexing.
let iconSide = 112
func icons(_ request: IconRequest) throws -> Response {
    try require(request.operation == "icons" && request.paths.count <= 512, "invalid")
    var result: [String: String] = [:]
    var names: [String: String] = [:]
    for path in request.paths {
        // A wrapped iPhone/iPad app has no Contents/Info.plist at its outer bundle.
        let wrapped = FileManager.default.fileExists(atPath: path + "/WrappedBundle")
        guard path.hasPrefix("/"), path.hasSuffix(".app"), wrapped || Bundle(path: path)?.bundleIdentifier != nil else {continue}
        names[path] = FileManager.default.displayName(atPath: path)
        let image = NSWorkspace.shared.icon(forFile: path)
        var proposed = CGRect(x: 0, y: 0, width: iconSide, height: iconSide)
        guard let cg = image.cgImage(forProposedRect: &proposed, context: nil, hints: nil),
              let space = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(data: nil, width: iconSide, height: iconSide, bitsPerComponent: 8,
                bytesPerRow: iconSide * 4, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {continue}
        context.interpolationQuality = .high
        context.draw(cg, in: CGRect(x: 0, y: 0, width: iconSide, height: iconSide))
        guard let resized = context.makeImage(),
              let png = NSBitmapImageRep(cgImage: resized).representation(using: .png, properties: [:]) else {continue}
        result[path] = "data:image/png;base64," + png.base64EncodedString()
    }
    return Response(icons: result, names: names)
}
struct Failure: Error { let code: String }
func require(_ value: Bool, _ code: String) throws { if !value { throw Failure(code: code) } }
func attr(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
func frame(_ element: AXUIElement) -> CGRect? {
    guard let rawPosition = attr(element, kAXPositionAttribute), let rawSize = attr(element, kAXSizeAttribute),
          CFGetTypeID(rawPosition) == AXValueGetTypeID(), CFGetTypeID(rawSize) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero; var size = CGSize.zero
    guard AXValueGetValue(unsafeBitCast(rawPosition, to: AXValue.self), .cgPoint, &point),
          AXValueGetValue(unsafeBitCast(rawSize, to: AXValue.self), .cgSize, &size) else { return nil }
    return CGRect(origin: point, size: size)
}
func same(_ left: CGRect, _ right: CGRect) -> Bool {
    abs(left.minX - right.minX) <= 2 && abs(left.minY - right.minY) <= 2 &&
    abs(left.width - right.width) <= 2 && abs(left.height - right.height) <= 2
}
func native(_ pid: pid_t) -> [(Int, CGRect)] {
    (CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] ?? []).compactMap { row in
        guard row[kCGWindowOwnerPID as String] as? Int == Int(pid), row[kCGWindowLayer as String] as? Int == 0,
              let id = row[kCGWindowNumber as String] as? Int,
              let raw = row[kCGWindowBounds as String] as? [String: Any],
              let bounds = CGRect(dictionaryRepresentation: raw as CFDictionary) else { return nil }
        return (id, bounds)
    }
}
func canonical(_ url: URL) -> String { url.resolvingSymlinksInPath().standardizedFileURL.path }

let documentBundleIds: Set<String> = ["com.microsoft.Excel", "com.microsoft.Powerpoint"]
func documentPath(_ element: AXUIElement) -> String? {
    guard let raw = attr(element, kAXDocumentAttribute) as? String, !raw.isEmpty else { return nil }
    let url: URL?
    if raw.hasPrefix("/") {
        url = URL(fileURLWithPath: raw)
    } else {
        url = URL(string: raw)
    }
    guard let file = url, file.isFileURL, !file.path.isEmpty else { return nil }
    return canonical(file)
}
func documentWindows(_ running: NSRunningApplication, _ bundleId: String, _ appPath: String) -> [DocumentWindow] {
    let app = AXUIElementCreateApplication(running.processIdentifier)
    AXUIElementSetMessagingTimeout(app, 2)
    let elements = (attr(app, kAXWindowsAttribute) as? [AXUIElement] ?? []).filter {
        attr($0, kAXSubroleAttribute) as? String == kAXStandardWindowSubrole
    }
    let nativeFrames = native(running.processIdentifier)
    return elements.compactMap { element in
        guard let bounds = frame(element) else { return nil }
        let ids = nativeFrames.filter { same($0.1, bounds) }
        guard ids.count == 1 else { return nil }
        return DocumentWindow(appPath: appPath, bundleId: bundleId, processId: Int(running.processIdentifier),
                              windowId: ids[0].0, title: attr(element, kAXTitleAttribute) as? String ?? "",
                              documentPath: documentPath(element))
    }
}
func openDocumentWindows() throws -> Response {
    // This is a pure Accessibility metadata read. AXIsProcessTrusted checks
    // current permission without presenting the system prompt.
    try require(AXIsProcessTrusted(), "permission")
    var documents: [DocumentWindow] = []
    for bundleId in documentBundleIds {
        let matches = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).filter { $0.bundleURL != nil }
        // Multiple instances cannot be safely paired to an opaque candidate.
        guard matches.count <= 1 else { continue }
        guard let running = matches.first, let url = running.bundleURL else { continue }
        documents.append(contentsOf: documentWindows(running, bundleId, canonical(url)))
    }
    return Response(documents: documents)
}
func resolveOpenDocumentWindow(_ request: Request) throws -> Response {
    try require(AXIsProcessTrusted(), "permission")
    guard let bundleId = request.bundleId, documentBundleIds.contains(bundleId),
          let appPath = request.appPath, appPath.hasPrefix("/"),
          let processId = request.processId, processId > 0,
          let windowId = request.windowId, windowId > 0,
          let expectedPath = request.documentPath, expectedPath.hasPrefix("/") else { throw Failure(code: "unavailable") }
    let matches = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).filter {
        Int($0.processIdentifier) == processId && $0.bundleURL.map { canonical($0) == appPath } ?? false
    }
    try require(matches.count == 1, "unavailable")
    let exact = documentWindows(matches[0], bundleId, appPath).filter {
        $0.windowId == windowId && $0.documentPath == expectedPath
    }
    // The document identity guards against a recycled WindowServer id, a
    // closed window, and Save As changing the open file between list/select.
    try require(exact.count == 1, "unavailable")
    return Response(documentPath: expectedPath)
}
func wordAutomationAllowed() -> Bool {
    let bundleId = "com.microsoft.Word"
    let bytes = Data(bundleId.utf8)
    var target = AEAddressDesc()
    let created: OSErr = bytes.withUnsafeBytes { (raw: UnsafeRawBufferPointer) -> OSErr in
        AECreateDesc(DescType(typeApplicationBundleID), raw.baseAddress, raw.count, &target)
    }
    guard created == OSErr(noErr) else { return false }
    defer { AEDisposeDesc(&target) }
    // askUserIfNeeded=false is the essential contract: this helper is a
    // preflight for picker discovery, never a TCC prompt trigger.
    return AEDeterminePermissionToAutomateTarget(&target, AEEventClass(typeWildCard), AEEventID(typeWildCard), false) == noErr
}
func execute(_ request: Request) throws -> Response {
    if request.operation == "document-windows" { return try openDocumentWindows() }
    if request.operation == "resolve-document-window" { return try resolveOpenDocumentWindow(request) }
    if request.operation == "word-automation-permission" { return Response(automationAllowed: wordAutomationAllowed()) }
    try require(["windows", "arrange", "restore"].contains(request.operation), "invalid")
    // Detection/launch works without this permission. Never prompt from a probe.
    try require(AXIsProcessTrusted(), "permission")
    guard let bundleId = request.bundleId, let appPath = request.appPath else { throw Failure(code: "invalid") }
    let matches = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).filter {
        $0.bundleURL.map { canonical($0) == canonical(URL(fileURLWithPath: appPath)) } ?? false
    }
    try require(matches.count == 1, "unavailable")
    let running = matches[0]
    let app = AXUIElementCreateApplication(running.processIdentifier)
    AXUIElementSetMessagingTimeout(app, 2)
    let elements = (attr(app, kAXWindowsAttribute) as? [AXUIElement] ?? []).filter {
        attr($0, kAXSubroleAttribute) as? String == kAXStandardWindowSubrole
    }
    let nativeFrames = native(running.processIdentifier)
    let identified: [(AXUIElement, Window)] = elements.compactMap { element in
        guard let bounds = frame(element) else { return nil }
        let ids = nativeFrames.filter { same($0.1, bounds) }
        guard ids.count == 1 else { return nil }
        return (element, Window(id: ids[0].0, title: attr(element, kAXTitleAttribute) as? String ?? "",
                               bounds: Rect(bounds), fullscreen: attr(element, "AXFullScreen") as? Bool ?? false,
                               minimized: attr(element, kAXMinimizedAttribute) as? Bool ?? false))
    }
    if request.operation == "windows" { return Response(windows: identified.map { $0.1 }) }
    guard let id = request.windowId, let target = identified.first(where: { $0.1.id == id }),
          let requested = request.bounds else { throw Failure(code: "unavailable") }
    try require(!target.1.fullscreen && !target.1.minimized, "fullscreen")
    try require([requested.x, requested.y, requested.width, requested.height].allSatisfy { $0.isFinite }
                && requested.width >= 100 && requested.height >= 100, "invalid")
    var point = requested.cg.origin; var size = requested.cg.size
    guard let positionValue = AXValueCreate(.cgPoint, &point), let sizeValue = AXValueCreate(.cgSize, &size) else {
        throw Failure(code: "layout-failed")
    }
    // AX writes acknowledge before the app has applied its geometry. A size
    // change at the old position can also be clamped to the display edge. Let
    // each move settle, then converge against both AX and WindowServer frames.
    for _ in 0..<20 {
        try require(attr(target.0, "AXFullScreen") as? Bool != true, "fullscreen")
        try require(AXUIElementSetAttributeValue(target.0, kAXPositionAttribute as CFString, positionValue) == .success, "layout-failed")
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        try require(AXUIElementSetAttributeValue(target.0, kAXSizeAttribute as CFString, sizeValue) == .success, "layout-failed")
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        if let result = native(running.processIdentifier).first(where: { $0.0 == id }),
           same(result.1, requested.cg), let actual = frame(target.0), same(actual, result.1) {
            if request.operation == "arrange" { AXUIElementPerformAction(target.0, kAXRaiseAction as CFString) }
            return Response(bounds: Rect(result.1))
        }
    }
    throw Failure(code: "layout-failed")
}

let response: Response
do {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    try require(data.count <= 65536, "invalid")
    if let request = try? JSONDecoder().decode(IconRequest.self, from: data), request.operation == "icons" {
        response = try icons(request)
    } else {
        response = try execute(JSONDecoder().decode(Request.self, from: data))
    }
} catch { response = Response(error: (error as? Failure)?.code ?? "unavailable") }
if let data = try? JSONEncoder().encode(response) { FileHandle.standardOutput.write(data) }
