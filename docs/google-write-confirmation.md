# Google write confirmation card

When the assistant wants to send an email or add or change a calendar event, Shell keeps the
exact draft as a pending proposal. The desktop shows it as a native card in that agent's chat,
and the owner approves or declines it there. The card reads its proposals from Shell's owner
endpoints, never from the conversation: neither Shell, the agent, nor the desktop posts drafts
or canned text into the room for any of this. All of the card's wording is UI copy in the
owner's app language. English is the default, Vietnamese is provided, and other locales fall
back to English. The question and field names reuse the five-locale table that the
main-process write dialog already uses (`apps/desktop/shared/matrix-google-write-copy.ts`).

The desktop builds to Shell's "native proposal cards and owner endpoint contract" for the
Google MCP (`send_email`, `create_event`, `update_event`). That contract ships behind Shell's
Google MCP flag, which is off by default. While it is off, the list endpoint answers
`503 {"state":"unavailable"}` and the desktop shows no card.

## Endpoints

Main sends every request through `account.s1Request`, using the owner's MAS bearer and one
refresh after a 401. The renderer never receives the bearer or the URL. Every request carries:

```http
Authorization: Bearer <owner token>
X-Atum-Host-Bridge-Contract: atum.s2.host-bridge/1.0.0
```

The paths are on the domain's own HTTPS origin. Main refuses a plain-HTTP domain.

| request | body | success (HTTP 200) |
| --- | --- | --- |
| `GET /api/connections/google/proposals` | none | `{"proposals":[…]}` |
| `POST /api/connections/google/proposals/{proposalId}/delivered` | `{"digest":"<hex>"}` | `{"proposalId","digest","status":"delivered"}` |
| `POST /api/connections/google/proposals/{proposalId}/approve` | `{"digest":"<hex>"}` | `{"proposalId","digest","status":"confirmed"}` |
| `POST /api/connections/google/proposals/{proposalId}/decline` | `{"digest":"<hex>"}` | `{"proposalId","digest","status":"declined"}` |

Failures are `{"state":"refused"}` (HTTP 400, 401, 403 or 409) or `{"state":"unavailable"}`
(HTTP 503). Main reduces every answer to one of three states and passes only that state to
the window:

- `ok`: HTTP 200, exactly the three keys, naming this proposal, this digest, and the status
  for this action.
- `refused`: HTTP 400, 403 or 409, or a 401 that persists after the one refresh.
- `unavailable`: everything else. That includes a 503, any other status, a malformed or
  mismatched 200, a network failure or timeout, and an answer that arrives after the account
  changed.

Nothing reads as approved unless Shell returned `confirmed` for that exact proposal and digest.

## Pending list

Each entry has exactly these keys:

```json
{
  "proposalId": "<uuid>",
  "operationId": "<same uuid>",
  "agent": "<server-bound agent uuid>",
  "room": "!room:example.org",
  "draft": {},
  "digest": "<64 lowercase hex>",
  "status": "awaiting_owner"
}
```

The reader is strict (`apps/desktop/shared/matrix-google-write-proposal.ts`). A malformed
entry is dropped on its own and the rest of the list still shows. An entry is malformed when
it has an unknown key, an `operationId` that differs from its `proposalId`, a status other
than `awaiting_owner`, or a draft the card cannot show faithfully. Only one entry per agent
and room is kept. The desktop shows a room's entries only in the chat whose Matrix room id
equals `room`.

Drafts are untrusted display data. They are rendered as plain text and never as markdown.

- **Email** (it carries no `action`). The draft has `to`, an optional `cc` and `bcc`,
  `subject`, `body`, `quote` (the full forwarded original, or an empty string), `references`,
  an optional `threadId` and `inReplyTo`, and an optional `forwarded` object (`messageId`,
  `from`, `date`, `subject`, `quotePreview`, `quoteLength`, and optionally `truncated: true`).
  It also has `attachments`, each with `filename`, `mimeType`, `size` and an optional `sha256`,
  and never the file bytes. Every recipient is a bare address, and there is at least one.
- **Calendar.** The draft has `action` (`create_event` or `update_event`), `sourceId`,
  `title`, `start`, `end`, an optional `location` and `description`, and an `eventId` that is
  present exactly for `update_event`. `start` and `end` are RFC 3339 instants with an explicit
  offset.

## Digest

`digest` is the lowercase hexadecimal SHA-256 of the UTF-8 `canonicalJson(draft)`. The
desktop recomputes it from the parsed draft with the same canonical JSON as the platform
protocol package, `packages/device-protocol/canonical.ts`, which is a byte-for-byte port with
vendored fixture tests. The card offers Approve only once the recomputed digest equals the
proposal's. On a mismatch it shows the `changed` line, offers no action, and reports no
delivery.

## Card lifecycle

- **Reading.** The window reads the list when an agent chat opens, when the window regains
  focus, when a new event arrives in that chat, and after Shell answers a decision. If a read
  fails, the cards already shown stay as they are.
- **Delivered.** A verified, pending card reports `delivered` once per proposal. It does so
  only after the card has been on screen for a full second in a focused, foreground window
  (`useNoticePresented`, the same rule as other presented notices). It never reports on fetch,
  on re-render, or for a draft that did not verify.
- **Approve and Decline.** These share one single-use decision. The window sends at most one
  request at a time, and none after Shell accepted one. After an `unavailable` answer the
  actions stay and a retry is allowed. Shell refuses a replay, so a lost answer that was in fact
  accepted then closes the card rather than approving it twice.
- **Approve sends nothing.** Shell records `confirmed`, and the assistant's unchanged repeated
  call carries the request out. So the approved card says it is approved and that the assistant
  will carry it out. It never says sent, added or saved. The list includes only pending
  proposals, so no later outcome is shown on the card.
- **Supersede.** Shell keeps one pending proposal per agent and room. When a fresh list no
  longer includes a shown card and its agent has a newer proposal in that room, the old card
  settles as superseded and the newer card opens. A card that leaves the list for any other
  reason (expiry, a decision on another device) settles as closed.
- **No reply band.** While a card in the chat waits on the owner, the "no reply yet" band is
  suppressed, because the assistant has handed the turn to the owner.

## Card states

| state | English | Vietnamese |
| --- | --- | --- |
| pending (email) | Send this email? · **Approve** · Decline | Gửi email này? · **Duyệt** · Từ chối |
| pending (new event) | Add this event to your calendar? · **Approve** · Decline | Thêm sự kiện này vào lịch? · **Duyệt** · Từ chối |
| pending (event change) | Save these changes to your calendar? · **Approve** · Decline | Lưu thay đổi này vào lịch? · **Duyệt** · Từ chối |
| approving / declining | Approving… / Declining… (buttons disabled) | Đang duyệt… / Đang từ chối… |
| approved | Approved. Your assistant will carry it out. | Đã duyệt. Trợ lý sẽ thực hiện việc này. |
| declined | Declined. Your assistant won’t do this. | Đã từ chối. Trợ lý sẽ không thực hiện việc này. |
| superseded | A newer request replaced this one. | Một yêu cầu mới hơn đã thay thế yêu cầu này. |
| closed (refused, or no longer listed) | This request is no longer waiting for you. | Yêu cầu này không còn chờ bạn nữa. |
| changed (digest mismatch) | This draft doesn’t match what your assistant proposed, so it can’t be approved here. Ask for a fresh one. | Bản nháp này không khớp với đề xuất của trợ lý nên không thể duyệt ở đây. Hãy nhờ soạn lại. |
| unavailable (still open) | Couldn’t reach Atum. Try again. | Không kết nối được với Atum. Hãy thử lại. |

An open card shows:

- For an email: To, Cc, Bcc, the subject, the forwarded original's sender and subject, and
  the attachments by name and size. If it replies inside an existing conversation, it says so.
  It then shows the body exactly as written and the quoted original beneath it.
- For an event: the title, the start and end in the owner's time zone, the location, and the
  description.

The card leaves out only opaque identifiers (`sourceId`, `eventId`, `threadId`, `references`
and the forwarded `messageId`), which have no meaning to the owner. A settled card folds down
to one line naming the request, with its state underneath. The card never shows a cost.

## Code

- `apps/desktop/shared/matrix-google-write-proposal.ts`: the strict list and draft reader,
  the digest, and the action input reader.
- `apps/desktop/electron/matrix/google-connection-boundary.ts`:
  `requestMatrixGoogleWriteProposals`, `requestMatrixGoogleWriteAction`,
  `matrixGoogleWriteProposals` (the `s1Request` seam) and `createMatrixGoogleWriteIpcHandler`.
  The handler is on the channel `matrix:google-connections:write-proposals`, with requests
  `{kind:"list"}` and `{kind:"action",input:{proposalId,digest,action}}`. It checks the
  sender before it reads the input.
- `apps/desktop/src/matrix/google-write-card.tsx` and `google-write-card-copy.ts`: the card,
  the per-chat card list (`MatrixGoogleWriteProposals`, mounted above the composer in
  `app.tsx`) and the copy.

## Work proposals (owner, 2026-11-25: one rule)

The owner's own Work on this Mac can ask for Google changes too. Each one waits behind the same
card and the same owner endpoint as an assistant's, so nothing reaches Google until the owner
approves it. Shell (atum-platform migration `0550_google_mcp_work_proposals.sql`,
`apps/shell/src/lib/google-proposals.ts`) lists these proposals in the same owner list with
`source:"work"`, `agent:null` and `room:null`. Their `draft` is the exact preview Shell will
execute, and the digest covers that preview.

- **Seven actions.** `send_email`, `create_event` and `update_event` use the agent draft shapes.
  `create_draft` and `update_draft` use the email shape plus `action` and `sourceId`, and
  `update_draft` also has `draftId`. `mailbox` carries `operation`, exactly one of `threadId` or
  `messageId`, and `labels` only for `add_labels` and `remove_labels`. `create_label` carries
  `name`. The reader is `parseMatrixGoogleWorkProposalList`. It is as strict as the agent
  reader, and it keeps one proposal, because Shell keeps one open Work proposal per owner.
- **Never in an agent chat.** The agent reader drops Work entries, and the Work reader drops
  agent entries. Main returns them separately, as `proposals` and `work`.
- **Where the card shows.** The Work page puts it above the native Work view
  (`MatrixGoogleWorkWriteProposals` in `WorkScreen`). It sits outside the host region, so the
  native view shrinks and does not cover the card. A muted line under the question reads
  "From Work on this Mac".
- **Account binding.** Main names the account it read the list for, `owner` (the Matrix user).
  The page shows Work cards only when that name is the account on screen. It shows nothing for
  a list that names no account or names another one, and it drops its cards when the account
  changes. Main already discards any answer that arrives after a sign-in change.
- **Refresh.** No chat event signals a Work proposal, so the page reads the list on mount, on
  window focus, every 5 s while the page is visible (`MATRIX_GOOGLE_WORK_POLL_MS`), and after
  each decision. A push signal would replace the interval. That is deferred.
- **States.** Pending shows Approve and Decline. Settled states are one line each:
  - Approved: "Approved." Shell carries out the change right away, and the result goes to Work.
  - Declined: "Declined. Nothing was changed."
  - Superseded: "A newer request from Work replaced this one."
  - Expired: the proposal left the list unanswered and was not replaced. Shell lists a Work
    proposal for 24 h.
  - Changed: the digest does not match, and nothing is offered.
  - A Shell refusal also settles to the expired line.
- **Evidence.** The playground view `?view=work-google-write` renders the real card for every
  action and settled state. Tests: `src/matrix/google-work-write-card.test.tsx`,
  `shared/matrix-google-write-proposal.test.ts` ("Work proposal reader"),
  `electron/matrix/google-connection-boundary.test.ts` and `src/app/work/work-screen.test.tsx`.
