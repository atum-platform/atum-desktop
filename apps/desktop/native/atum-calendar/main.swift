import EventKit
import Foundation
import CryptoKit

// Full access is the EventKit permission needed to read schedule state before a
// guarded write. The desktop main process owns the human confirmation gate.
func emit(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value) {
        FileHandle.standardOutput.write(data)
    }
}

private let maximumSpan: TimeInterval = 31 * 86_400
private let dateFormatter: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
}()

private func isoDate(_ date: Date) -> String {
    dateFormatter.string(from: date)
}

// Requiring milliseconds and an explicit UTC offset (including Z) prevents a
// device locale or an ambiguous date-only value from changing a write.
private func strictDate(_ value: Any?) -> Date? {
    guard let value = value as? String,
          value.range(of: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}(Z|[+-]\\d{2}:\\d{2})$", options: .regularExpression) != nil,
          let date = dateFormatter.date(from: value),
          date.timeIntervalSinceReferenceDate.isFinite else {
        return nil
    }
    return date
}

private func safeText(_ value: Any?, maximumLength: Int, required: Bool = false, multiline: Bool = false) -> String? {
    guard let value = value as? String,
          (!required || !value.isEmpty), value.count <= maximumLength else {
        return nil
    }
    // Notes are plain text and may contain ordinary line breaks and tabs.
    guard !value.unicodeScalars.contains(where: { scalar in
        (scalar.value <= 0x1f && !(multiline && [9, 10, 13].contains(scalar.value))) || (0x7f...0x9f).contains(scalar.value)
    }) else {
        return nil
    }
    return value
}

private func editableInput(_ input: [String: Any]) -> (title: String, start: Date, end: Date, location: String, description: String)? {
    guard let title = safeText(input["title"], maximumLength: 500, required: true),
          let location = safeText(input["location"] ?? "", maximumLength: 1_000),
          let description = safeText(input["description"] ?? "", maximumLength: 20_000, multiline: true),
          let start = strictDate(input["start"]), let end = strictDate(input["end"]),
          end > start, end.timeIntervalSince(start) <= maximumSpan else {
        return nil
    }
    return (title, start, end, location, description)
}

private func calendarSnapshot(_ calendar: EKCalendar, defaultCalendar: EKCalendar?) -> [String: Any] {
    [
        "id": calendar.calendarIdentifier,
        "label": calendar.title,
        "detail": calendar.source.title,
        "primary": calendar.calendarIdentifier == defaultCalendar?.calendarIdentifier,
        "writable": calendar.allowsContentModifications
    ]
}

private func recurrenceMetadata(_ event: EKEvent) -> [[String: Any]] {
    (event.recurrenceRules ?? []).map { rule in
        // EventKit does not expose a stable Codable recurrence representation.
        // Its description is the complete native rule representation and is
        // retained in the revision to detect changes to a series.
        ["rule": String(rule.description.prefix(4_000))]
    }.sorted { ($0["rule"] as? String ?? "") < ($1["rule"] as? String ?? "") }
}

private func participantMetadata(_ event: EKEvent) -> [[String: Any]] {
    (event.attendees ?? []).map { participant in
        [
            "name": String((participant.name ?? "").prefix(500)),
            "url": String(participant.url.absoluteString.prefix(1_000)),
            "status": participant.participantStatus.rawValue,
            "role": participant.participantRole.rawValue,
            "type": participant.participantType.rawValue,
            "currentUser": participant.isCurrentUser
        ]
    }.sorted {
        let lhs = "\($0["url"] as? String ?? "")\u{0}\($0["name"] as? String ?? "")"
        let rhs = "\($1["url"] as? String ?? "")\u{0}\($1["name"] as? String ?? "")"
        return lhs < rhs
    }
}

private func canonicalRevision(_ value: [String: Any]) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else {
        return ""
    }
    return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

private func eventSnapshot(_ event: EKEvent, calendarId: String) -> [String: Any] {
    let recurrence = recurrenceMetadata(event)
    let participants = participantMetadata(event)
    var snapshot: [String: Any] = [
        "id": event.eventIdentifier ?? "",
        "calendarId": calendarId,
        "title": String((event.title ?? "").prefix(500)),
        "start": isoDate(event.startDate),
        "end": isoDate(event.endDate),
        "location": String((event.location ?? "").prefix(1_000)),
        "description": String((event.notes ?? "").prefix(20_000)),
        "allDay": event.isAllDay,
        "participants": participants,
        "recurrence": recurrence,
        "hasAttendees": event.hasAttendees,
        "hasRecurrence": event.hasRecurrenceRules
    ]
    snapshot["revision"] = canonicalRevision(snapshot)
    return snapshot
}

private func isSimplePersonalEvent(_ event: EKEvent) -> Bool {
    !event.isAllDay && !event.hasAttendees && !event.hasRecurrenceRules
}

@main
struct CalendarHelper {
    static func main() async {
        guard #available(macOS 14.0, *) else {
            emit(["error": "unavailable"])
            return
        }
        let data = FileHandle.standardInput.readDataToEndOfFile()
        guard data.count < 65536,
              let input = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let action = input["action"] as? String,
              ["status", "connect", "calendars", "events", "event", "create-event", "update-event"].contains(action) else {
            emit(["error": "invalid_input"])
            return
        }
        let store = EKEventStore()
        if action == "connect" {
            do {
                guard try await store.requestFullAccessToEvents() else {
                    emit(["error": "denied"])
                    return
                }
            } catch {
                emit(["error": "denied"])
                return
            }
        }
        guard EKEventStore.authorizationStatus(for: .event) == .fullAccess else {
            emit(["error": "reconnect"])
            return
        }
        if action == "status" || action == "connect" || action == "calendars" {
            let defaultCalendar = store.defaultCalendarForNewEvents
            emit(["calendars": store.calendars(for: .event).map {
                calendarSnapshot($0, defaultCalendar: defaultCalendar)
            }])
            return
        }

        if action == "events" {
            guard let from = input["start"] as? String, let to = input["end"] as? String,
                  let start = dateFormatter.date(from: from), let end = dateFormatter.date(from: to),
                  start.timeIntervalSinceReferenceDate.isFinite,
                  end.timeIntervalSinceReferenceDate.isFinite,
                  end > start, end.timeIntervalSince(start) <= maximumSpan else {
                emit(["error": "invalid_input"])
                return
            }
            guard let ids = input["calendarIds"] as? [String], !ids.isEmpty,
                  ids.count <= 100 else {
                emit(["error": "invalid_input"])
                return
            }
            let calendars = ids.compactMap { store.calendar(withIdentifier: $0) }
            guard calendars.count == ids.count else {
                emit(["error": "reconnect"])
                return
            }
            let predicate = store.predicateForEvents(withStart: start, end: end, calendars: calendars)
            let events = store.events(matching: predicate).sorted { $0.startDate < $1.startDate }
            emit([
                "events": events.prefix(100).map { event -> [String: Any] in
                    ["id": event.eventIdentifier ?? "", "title": event.title ?? "",
                     "start": isoDate(event.startDate), "end": isoDate(event.endDate),
                     "allDay": event.isAllDay, "calendar": event.calendar?.title ?? "",
                     "location": event.location ?? "", "description": String((event.notes ?? "").prefix(4000))]
                },
                "more": events.count > 100
            ])
            return
        }

        guard let calendarId = input["calendarId"] as? String,
              !calendarId.isEmpty,
              let calendar = store.calendar(withIdentifier: calendarId) else {
            emit(["error": "reconnect"])
            return
        }
        guard calendar.allowsContentModifications else {
            emit(["error": "unsupported"])
            return
        }

        if action == "create-event" {
            guard let values = editableInput(input) else {
                emit(["error": "invalid_input"])
                return
            }
            let event = EKEvent(eventStore: store)
            event.calendar = calendar
            event.title = values.title
            event.startDate = values.start
            event.endDate = values.end
            event.location = values.location
            event.notes = values.description
            event.isAllDay = false
            do {
                try store.save(event, span: .thisEvent, commit: true)
            } catch {
                // A thrown native save can be ambiguous (for example after an
                // account sync interruption), so callers must never resend it.
                emit(["error": "outcome_unknown"])
                return
            }
            guard let id = event.eventIdentifier, !id.isEmpty else {
                emit(["error": "outcome_unknown"])
                return
            }
            let snapshot = eventSnapshot(event, calendarId: calendarId)
            emit(["id": snapshot["id"] as? String ?? id, "event": snapshot])
            return
        }

        guard let id = input["id"] as? String, !id.isEmpty,
              let event = store.event(withIdentifier: id),
              event.calendar?.calendarIdentifier == calendarId else {
            emit(["error": "invalid_input"])
            return
        }
        if action == "event" {
            emit(["event": eventSnapshot(event, calendarId: calendarId)])
            return
        }

        guard action == "update-event",
              let expectedRevision = input["expectedRevision"] as? String,
              expectedRevision.count == 64,
              expectedRevision.allSatisfy({ $0.isHexDigit }),
              let values = editableInput(input) else {
            emit(["error": "invalid_input"])
            return
        }
        guard isSimplePersonalEvent(event) else {
            // Never turn a single request into an invitation, a series change,
            // or an all-day conversion. Those require a dedicated flow.
            emit(["error": "unsupported"])
            return
        }
        // This is deliberately the last read before mutation. There is no
        // retry: a concurrent remote change must be re-read and re-confirmed.
        guard eventSnapshot(event, calendarId: calendarId)["revision"] as? String == expectedRevision else {
            emit(["error": "conflict"])
            return
        }
        event.title = values.title
        event.startDate = values.start
        event.endDate = values.end
        event.location = values.location
        event.notes = values.description
        event.isAllDay = false
        do {
            try store.save(event, span: .thisEvent, commit: true)
        } catch {
            emit(["error": "outcome_unknown"])
            return
        }
        let snapshot = eventSnapshot(event, calendarId: calendarId)
        emit(["id": snapshot["id"] as? String ?? id, "event": snapshot])
    }
}
