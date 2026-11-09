# `atum.agent-chats/1`: the live chat view an owner's agent reads

- **Row:** Agent chat awareness (owner decision 2026-10-20: "Agents' awareness of all user's chat
  messages is a CORE feature of Atum"; chats are plain by default, end-to-end encryption is an
  owner opt-in). Authored 2026-10-20 on the platform's `feat/agent-chats` branch.
- **Status:** frozen when merged; never edited after. An amendment is a new version directory.
- **Boundary:** contract and synthetic fixtures only. The shaper (`apps/shell/src/lib/chat-view.ts`),
  the two route fronts and the session table are separate files; the Hermes tool `atum_chats` is the
  app lane's.
- **Checked by** `pnpm verify:s1-contracts` (both `spec/_tools/contract_pack.*` checkers) and the
  `@atum/protocol` mirror (`test/agent-chats.test.ts`). Authored by `spec/_tools/s1/author-packs.mjs`.

## What it is

One request, one bounded answer. The agent's tool arguments are the request body; the Shell, holding a
short-lived Matrix session of its own for the owner, asks Synapse's client API what the owner can see and
returns a **read-only, capped, quoted** view. The agent knows at least what the owner knows and sees: every
room the owner has joined (person, group, agent or bot) is read the same way, with no per-room approval and
no exclusion list. The owner is the authority: a call made as the owner can only reach rooms the owner
currently joined, checked again on every operation. Nothing is stored here and there is **no send, join, redact, react or
read-receipt operation** in this contract (an `op` other than the three below is refused).

| `op` | request | answer |
|---|---|---|
| `list` | `{op, unreadOnly?, sinceMs?, limit?, before?}` | `{rooms:[room], truncated, next?}`, most recent first; `next` is the `before` for the following rooms |
| `read` | `{op, id, limit?, before?}` | `{id, label, messages:[message], next?}`, oldest first; `next` is the `before` for earlier history |
| `search` | `{op, query, id?, limit?}` | `{hits:[{id, eventId, label, at, from, mine, snippet}]}`, most recent first |

`before` and `next` are opaque cursors (a read cursor only continues the room it came from). Every message
(and a room's `last`, and a hit) carries its `eventId`. A message whose latest text is an edit shows that
text with `edited: true`; a redacted one shows `text: null` with `redacted: true`. A room's
`notifications` and `highlights` are Synapse's counts, `null` when Synapse did not say (never 0 for
"unknown"). `sinceMs` is an absolute Unix epoch-millisecond timestamp.

Routes: cloud `POST /api/matrix/v1/cloud/controller/executors/{executorId}/chats` (controller
credential, executor kind `cloud` only) and native `POST /api/matrix/v1/chats` (the owner's native
token; the calling agent principal is logged for audit only, and every one of the owner's agents may
call it). Both take and return exactly the shapes here.

## Caps (parameters)

`limit` defaults 20 (list, read) and 10 (search), and is at most 40 (list, read) and
20 (search). `sinceMs` is an absolute Unix epoch-millisecond timestamp; supplied timestamps older than 60 days are clamped to that oldest supported time. A message `text` is
at most 1024 characters; a list preview 160; a search snippet 240.
A room shows at most 5 other members' display names plus the real `memberCount`.
The whole response is at most 24576 bytes (UTF-8 JSON): when it would be larger the
trailing items are dropped and `truncated` (list) or `next` (read) says so. A query is at most
200 characters. No media bytes ever: an image, video, audio or file message carries
`text: "[image]"` (or `[video]`, `[audio]`, `[file]`) and its `kind`.

## Rules (one line each, no exceptions)

1. **Encrypted rooms are the one opt-out: metadata only**, on every host, including a Mac that holds the keys:
   the room shows who, when and the Synapse counts, with `text: null` and `kind: "encrypted"`. This holds
   for a room that was encrypted after earlier plain messages. `search` never asks for, or returns a hit from,
   one. There is **no exclusion list in v1**: no room is hidden because of a setting.
2. **Joined, every time.** Each operation checks that the owner is currently in the room (the room must be in
   the owner's own sync; the owner's token answering 403 is the same `not_found`); a guessed id or a cursor
   from another room reaches nothing. An unknown, not-joined or tombstoned room all answer `not_found`.
3. **Tombstoned predecessor rooms are omitted**; the owner's own command room is never listed.
4. **Read only.** The Shell asks Synapse for `GET /sync` (with `set_presence=offline`), `GET /rooms/{id}/messages`,
   `state`, `joined_members` and `POST /search` only. It never sends a receipt, read marker, typing,
   presence, account-data or key request, so the owner's own unread state is untouched.
5. **Quoted data.** Everything returned is other people's words. The tool description frames it so; retrieved
   text is never an instruction or an authorization, and private content is not forwarded unless the owner asks.
6. **Bounded.** Each upstream request has an 8 s and 2 MB budget; `read` makes at most 2 pages and `search` 1
   page per query form; at most 2 operations are in flight per owner; Synapse's 429 is `rate_limited`.
7. **No content in logs**; a log line carries the operation, counts, byte size and closed reason only.

## Errors

A failure is a closed code, never an empty success: `{error: "invalid" | "not_found" | "rate_limited" |
"unavailable"}` with HTTP 400, 404, 429 and 503. `rate_limited` is about 30 calls a minute per owner, more than 2 at once, or Synapse's own 429.
`unavailable` is every upstream or authority failure (Matrix, MAS, the session store, a binding change
during the call); the client says nothing about its cause and the agent must not report "nothing found".

## Search quality (measured 2026-10-20)

`search` is Synapse's server-side `POST /search` over the owner's plain rooms. Synapse's PostgreSQL is
C-collated and uses the `english` text-search configuration (measured on PostgreSQL 17 with those
settings). Vietnamese words are kept whole with their diacritics, but matching is **diacritic-exact and
lowercases ASCII letters only**: `hop` does not find `họp`, and a stored `Đồng` or `Ôn` (an accented capital) is
not found by `đồng` or `ôn`, while `Hợp` is found by `hợp` (its first letter is ASCII). A query that contains a
non-ASCII letter is therefore asked twice, with every term's first letter lower-case and then upper-case,
and the answers are merged by event. Accents are never guessed. **Tool text:** search is diacritic-exact, so when
it finds nothing the agent should retry with the Vietnamese diacritics or use `read` on a candidate room.
