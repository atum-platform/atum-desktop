# `atum.pet-chat/1`: a pet is its own companion

- **Row:** Pets as their own companions (owner decision 2026-10-27: "a pet should be its own 'agent' –
  just not shown in the roster, only accessible via the pet itself"). Authored on the platform's
  `feat/pet-chat` branch; migration `0331_pet_companions.sql`.
- **Status:** frozen when merged; never edited after. An amendment is a new version directory.
- **Boundary:** contract and synthetic fixtures only. The Shell routes
  `/api/matrix/v1/pets/chat` and `/api/matrix/v1/pets/chat/history`, the managed
  alias `pet`, and the desktop transport are separate files.
- **Checked by** `pnpm verify:pet-chat-contract` (both `spec/_tools/contract_pack.*` checkers) and the
  `@atum/protocol` mirror (`test/pet-chat.test.ts`).

## What it is

One pet, one short chat turn. The pet is **not** an assistant: it has no principal, Matrix room,
profile, roster entry, agent definition, tools, or access to the owner's data, other chats, agents or
accounts. It is a companion record under the owner's account: a personality, a rolling eight-turn
memory, one short summary, and a quiet daily count.

| Route | Request | Answer |
|---|---|---|
| `POST /api/matrix/v1/pets/chat` | `{ref, message_id, message, locale}` | `{v, reply, action, recent, messages_today, daily_cap}` |
| `POST /api/matrix/v1/pets/chat/history` | `{ref}` | `{v, pet_key, display_name, personality, memory_summary, recent, messages_today, daily_cap}` |

`ref` is exactly one of `{"kind":"bundled","slug":"gigi|cookie|mochi|bailey"}` or
`{"kind":"personal","pet_id":"<uuid>"}`. Personal pets are the owner's hatched pets from
`atum_private.account_pets`; a soft-deleted, unknown or another owner's pet is `not_found`. The
signed-in Matrix owner is the pet's `owner_principal`, so a pet visible in the Matrix pet list chats
without a separate account link; a legacy account-owned pet stays readable by that account.
`message_id` is a UUID and is the managed request identity: a lost response replays the same
reservation, conversation turns and charge instead of repeating them. A replayed `message_id` returns
the reply and action recorded with that turn.

## Personality and memory

House pets use curated personas compiled into the Shell (`Gigi`, `Cookie`, `Mochi`, `Bailey`). A
hatched pet's personality is generated lazily on its first chat from its display name and
description, stored on the companion row, and editable by the owner afterwards. Chat never
overwrites an explicit personality.

The rolling window stores the newest eight turns (user and pet). One short summary is replaced only
when the model supplies one. Memory is owner-private and scoped by the owner and `pet_key`; deleting
or soft-deleting a personal pet removes its companion row.

## The prompt

The model call contains exactly: the persona, the pet's own memory and the owner's message. It has
no tools and never receives an assistant name, room id, account/owner identifier, agent memory or a
previous agent message. The owner's text is passed as delimited data. Unknown or malformed actions
are dropped server-side while the reply is kept.

## Actions

One action at most, from the fixed sprite vocabulary:

```json
{"action":"sit" | "lounge" | "sleep" | "jump" | "wave"}
{"action":"go","place":"center"}
```

The model names `come`; the server maps it to `{action:"go",place:"center"}`. `spin`, `follow`, an
unknown name, extra keys or a wrong place are dropped (not an error).

## Limits and the quiet day

- `message` 1–500 characters; replies are capped at 240 characters in the owner's language.
- A pet keeps the newest 8 turns; the summary is at most 600 characters; a personality is at most
  4,000 characters.
- `daily_cap` is 200 messages per pet per Saigon day. When it is reached the pet **naps**: the route
  returns a short in-character reply with the `sleep` action, never an error text and never a model
  call. The count resets at the next `Asia/Ho_Chi_Minh` date.
- `messages_today` is the effective count for today; `daily_cap` is always 200.

## Model and money

Every chat is one managed provider call on the closed alias `pet`: Gemini 2.5 Flash on
`google-vertex/global`, 4,000 input / 160 output token ceiling, no tools, no streaming. The one
Proton allowance pool pays for it: the standard worst-case hold is 10,000 micro-USD (405 Protons at
the standard rate) on the signed-in owner's Proton ledger, refunded to the actual cost on settle; a
typical chat settles around 20–30 Protons. `insufficient_protons` is the only funding error the
client sees. Provider failures and internal errors return a short in-character fallback; the daily
limit is the nap above.

## Errors

`pet.error` is the existing desktop envelope:

```json
{"error":{"code":"insufficient_protons","message_key":"messaging.error.insufficient_protons","retryable":false,"request_id":"req_..."}}
```

Codes on this route: `invalid_request` (400), `not_found` (404), `insufficient_protons` (402),
`forbidden` (403, the signed-in owner is no longer an active human principal), `rate_limited` (429,
the reservation limiter), `temporarily_unavailable` (503). The daily limit is never an error.
