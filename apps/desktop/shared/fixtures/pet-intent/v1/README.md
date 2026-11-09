# atum.pet-intent/1

## Wire

The decrypted `m.room.message` content of an encrypted private assistant-room
reply may contain:

```json
{
  "msgtype": "m.text",
  "body": "Here is my reply.",
  "io.atum.pet": {
    "v": 1,
    "intents": [{ "action": "go", "place": "left" }, { "action": "wave" }]
  }
}
```

`io.atum.pet` is a mixin, never a separate Matrix event. It is inside the
encrypted content, alongside ordinary reply fields such as `io.atum.result`;
this pack does not change or mirror `atum.agent-turns`. The Matrix server is
blind to it under E2EE, so there is no `packages/protocol` server mirror.

The value is an exact object: `v: 1` and an ordered array of **one to three**
intents. An intent is exactly one of:

| Action | Required fields |
|---|---|
| `go` | `action`, `place`: `left`, `right` or `center` |
| `wave`, `jump`, `sit`, `lounge` | `action` only; `place` must be absent |

No other mixin or intent fields are allowed. Coordinates, arbitrary text, URLs,
pet identity and agent/room identity are forbidden. The room determines the pet
and the receiving stage determines geometry. Hermes accepts `centre`/`middle`
at its tool boundary and normalizes them to `center` before this wire.
Array order is execution order. A producer queues at most three de-duplicated
intents per turn, then attaches them to the completion payload. The persisted
reply outcome retains the same list, so publication retries do not change it.

## Producer and session rules

- Attach only to an assistant's `m.text` reply in its **private assistant room**.
  Never attach to `m.notice`, a shared/group room, or an app room.
- A pet surface means an enabled platform pet binding for that agent at session
  start, not a device currently drawing a sprite. The host declares it.
- Internal host handshake `ATUM_PET_INTENTS`: unset preserves legacy behavior;
  `off` hides the tool and installs no callback; `reply` buffers actions only
  when `pet_surface: true` was declared at session create/resume.
- The handshake and session toolset stay fixed for the conversation. A binding
  change takes effect next session, preserving the cached prompt prefix.
- Reply transport and cloud flags remain off until the desktop intake and
  publishing paths are verified. Any production flip requires owner approval.

These are host/client obligations, not claims that a JSON checker can prove
room type, encryption, sender authority, delivery age or prompt caching.

## Receiving client rules

The receiver may play intents only when **all** of the following hold:

1. The room is a private assistant room and the verified event sender is the
   Matrix user belonging to `room.agentPrincipal`, its own agent.
2. The event was encrypted and has successfully decrypted. It is not the
   owner's event, pending, failed, redacted, or edited.
3. The event arrived live after the room was loaded, rather than in backfill.
4. Its age is at most 60 seconds; tolerate at most 30 seconds of future clock
   skew. The event ID has not been applied before (bounded LRU of 500 IDs).
5. The pet is shown and not hidden; reduced motion is off.
6. At most one intent-bearing message per agent is applied per 20 seconds.

Malformed v1 envelopes are ignored whole, including an envelope containing an
unknown action or place. No partial list is executed. Dropping an unknown
action means ignoring the complete nonconforming mixin, never inventing a
substitute command. Enforce the raw three-intent bound and reject extra fields.
Rejected pet data must never hide or fail the normal text reply. A future wire
shape requires a new frozen contract version.

Older Macs and other Matrix clients ignore the unknown content key. The iPhone
fork must retain/access **raw decrypted JSON** before implementing an intake:
its typed message content may discard unknown keys. The iPhone currently only
needs to display the ordinary reply normally; this pack adds no phone renderer.

## Conformance and pin

`contract.json` is the normative format and enumerates worked accept/reject
fixtures. It checks the mixin independently and also checks its placement in
an `m.text` reply; unrelated reply keys remain extensible. The client-only
rules above require behavioral tests in each consuming client.

```bash
pnpm verify:pet-intent-contract
python3 spec/_tools/contract_pack.py spec/pet-intent/v1
node spec/_tools/contract_pack.mjs spec/pet-intent/v1
node --test spec/_tools/contract_pack.test.mjs
```

Both independently implemented standard-library checkers must pass.
`PINNED-SHA256` covers the sorted `pack_files` with the checker framing rule
(path byte length + path + body byte length + body). Vendor these files and
the pin unchanged into the desktop during PT-11, rather than inventing a
second vocabulary. Once merged, amend by a new version directory.
