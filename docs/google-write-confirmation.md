# Google write confirmation card

A Google write (sending an email, adding or changing a calendar event, or changing a Drive
file) goes ahead only when the owner presses Approve on a card in the desktop. The card shows
Shell's canonical draft. A typed reply in the chat authorises nothing. Nobody posts canned
chat text for any of this: the desktop supplies all of the card's wording as UI copy, in the
owner's app language. English is the default, Vietnamese is provided, and other locales fall
back to English. The field names reuse the five-locale table that the main-process write
dialog already uses (`apps/desktop/shared/matrix-google-write-copy.ts`).

The contract is `atum.google-write-confirmation/1`.

## Proposal event

The room's agent posts a timeline event (not a state event) of type
`io.atum.google.write_proposal`. It has no `msgtype` and no `body`:

```json
{
  "version": 1,
  "proposalId": "<lowercase UUID>",
  "digest": "sha256:<64 lowercase hex>",
  "expiresAt": 1772668800000,
  "draft": { "kind": "send_email", "...": "..." }
}
```

Keys must match exactly. Any unknown key, at the top level or inside the draft, makes the
whole event unreadable, and the card does not show it. `expiresAt` is in epoch milliseconds.

The draft is one of the following:

| kind | exact keys |
| --- | --- |
| `send_email` | `kind, from, to[], cc[], bcc[], subject, body, attachments[{name}], inReplyTo` |
| `create_event` | `kind, calendar, event` |
| `update_event` | `kind, calendar, current, next` |
| `drive_change` | `kind, action ("create" or "update"), name, folder, content` |

An event (`event`, `current` and `next`) has the keys `title, start, end, location, notes,
attendees[]`. `start` and `end` use Google Calendar's own shape. A timed event uses
`{dateTime, timeZone}`, where `dateTime` is RFC 3339 with an offset. An all-day event uses
`{date}`, and its `end` is exclusive, as in Google. Both ends must be the same form.

Further limits:

- Addresses are bare `local@domain` strings.
- Subjects, titles, names and locations are a single line.
- Text fields are plain text, up to 60,000 characters.
- `to` must have at least one entry.
- Each list holds at most 100 entries.
- The whole event must fit in Matrix's 64 KiB event limit.

**Digest.** The digest is `sha256:` followed by the lowercase hex SHA-256 of the UTF-8
canonical JSON of `draft`. The canonical JSON is the platform's `canonicalJson`: NFC strings
and keys, keys sorted by UTF-16 code unit, no whitespace, and safe integers only. Its port is
`packages/device-protocol/canonical.ts`. The desktop recomputes the digest from the draft it
parsed and rendered. When the result differs from `digest`, the card never offers Approve. It
shows the "changed" state instead.

Only a proposal from a room agent becomes a card. The newest proposal from each agent in a
room is the one open card. Every earlier proposal from that agent shows as superseded.

## Outcome event

After every terminal transition, the agent posts `io.atum.google.write_outcome`:

```json
{
  "version": 1,
  "proposalId": "<uuid>",
  "state": "done | approved | declined | superseded | expired | failed",
  "m.relates_to": { "rel_type": "m.reference", "event_id": "<proposal event>" }
}
```

`m.relates_to` is optional. The desktop matches the outcome to the proposal by sender and
`proposalId`. The outcome never appears as a row in the chat, and it settles the card on
every device. `approved` means the owner approved and Shell dispatched the write, but Shell
could not confirm the result (dispatched or `outcome_unknown`). The desktop also applies two
local rules: a newer proposal supersedes an older one, and a card expires at `expiresAt`.

## Decision endpoint

```
POST {domain resource}/google/proposals/{proposalId}/decision
Authorization: Bearer <MAS owner access token>
Content-Type: application/json
Accept: application/json
X-Atum-Google-Write-Contract: atum.google-write-confirmation/1
Idempotency-Key: <proposalId>:<approve|decline>

{ "decision": "approve" | "decline", "digest": "sha256:<hex of the rendered draft>" }
```

The Electron main process sends this request through `account.s1Request`, which uses the
owner's native bearer and refreshes it once after a 401. The renderer never holds the bearer.
The idempotency key is fixed for a given proposal and decision. A retry after a lost answer,
whether it comes after a refresh, after a restart, or from another device, therefore gets
Shell's saved answer and never causes a second write.

Every response is `application/json` and carries `profile` and `proposalId`, which echo the
request:

| HTTP | body | card state |
| --- | --- | --- |
| 200 | `{state: "done"}` (approve) | done |
| 202 | `{state: "approved"}` (approve) | approved, not confirmed. Never retried. |
| 200 | `{state: "declined"}` (decline) | declined |
| 409 | `{error: "digest_mismatch"}` | changed |
| 409 | `{error: "superseded"}` | superseded |
| 409 | `{error: "already_decided"}` | answered |
| 410 | `{error: "expired"}` | expired |
| 404 | `{error: "not_found"}` | expired |
| 422 | `{error: "write_failed"}` (approve) | failed |
| 401 | (any) | the bearer is refreshed once, then retry |
| anything else | | retry |

The desktop handles any other answer as retry: another status code, another body shape, a
mismatched profile or proposal, a positive answer to the other decision, or a network failure
or timeout. A retry leaves the card open, shows one calm line, and re-sends with the same key.
No path leads to an approved state unless Shell answered positively for that exact proposal
and decision. The main process allows 120 seconds for an answer, which covers Shell's
110-second dispatch.

## Card states

| state | English | Vietnamese |
| --- | --- | --- |
| pending (email) | Send this email? · **Send** · Decline | Gửi email này? · **Gửi** · Từ chối |
| pending (new event) | Add this event to your calendar? · **Add event** | Thêm sự kiện này vào lịch? · **Thêm sự kiện** |
| pending (event change) | Save these changes to your calendar? · **Save changes** | Lưu thay đổi này vào lịch? · **Lưu thay đổi** |
| pending (Drive) | Create this file in Drive? · **Create file** / Save these changes in Drive? · **Save changes** | Tạo tệp này trong Drive? · **Tạo tệp** / Lưu thay đổi này trong Drive? · **Lưu thay đổi** |
| approving / declining | Approving… / Declining… (buttons disabled) | Đang duyệt… / Đang từ chối… |
| done | Sent. · Added to your calendar. · Changes saved to your calendar. · Created in Drive. · Changes saved in Drive. | Đã gửi. · Đã thêm vào lịch. · Đã lưu thay đổi vào lịch. · Đã tạo trong Drive. · Đã lưu thay đổi trong Drive. |
| approved | Approved. It could not be confirmed yet, so check Google before asking again. | Đã duyệt. Chưa xác nhận được kết quả, hãy kiểm tra trên Google trước khi nhờ lại. |
| declined | Declined. Nothing changed. | Đã từ chối. Không có gì thay đổi. |
| superseded | A newer request replaced this one. Nothing changed. | Một yêu cầu mới hơn đã thay thế yêu cầu này. Không có gì thay đổi. |
| expired | This request expired. Nothing changed. | Yêu cầu này đã hết hạn. Không có gì thay đổi. |
| changed | This draft changed after it was shown, so it was not sent. Ask for a fresh one. | Bản nháp đã thay đổi sau khi hiển thị nên chưa được gửi. Hãy nhờ soạn lại. |
| answered | This request was already answered. | Yêu cầu này đã được trả lời. |
| failed | This did not go through. Nothing changed. You can ask again. | Chưa thực hiện được. Không có gì thay đổi. Bạn có thể nhờ lại. |
| retry (still open) | Could not reach Atum. Try again. | Không kết nối được với Atum. Hãy thử lại. |

An open card shows the whole draft:

- For an email: the sender, recipients (To, Cc and Bcc), subject, whether it replies inside
  an existing conversation, the body exactly as written (plain text with line breaks kept),
  and the attachments by name.
- For an event: its times in the owner's time zone, with the event's own zone named when it
  differs, plus location, guests and notes.
- For an event change: what each field is now and what it will become.
- For a Drive change: the file, its folder, and the content to be written.

Once a card is settled, it folds down to one line naming the request, with its end state
underneath. The card never shows a cost.

## Older desktops

Older desktops project only `m.room.message` events (`apps/desktop/src/matrix/message.ts`).
A proposal on its own event type is therefore dropped there: nothing is shown, no raw JSON
appears, and nothing can be approved. Other Matrix clients hide unknown event types. The
write happens only from a desktop that renders the card.

## Code

- `apps/desktop/shared/matrix-google-write-proposal.ts`: the strict reader, the digest and
  the transcript fold.
- `apps/desktop/src/matrix/message.ts`: projects the proposal and outcome events.
- `apps/desktop/src/matrix/app.tsx`: runs the fold beside `matrixFoldSubscriptionFallbacks`.
- `apps/desktop/src/matrix/google-write-card.tsx` and `google-write-card-copy.ts`: the card
  and its copy.
- `apps/desktop/electron/matrix/google-connection-boundary.ts`:
  `requestMatrixGoogleWriteDecision`, `matrixGoogleWriteDecider` and
  `createMatrixGoogleWriteIpcHandler`. The handler is on the channel
  `matrix:google-connections:decide-write` and checks the sender, as the Google connection
  request does.
