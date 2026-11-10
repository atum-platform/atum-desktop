# device-service/1.2 — frozen C1/CX contract

Canonical home: `atum-platform/spec/device-service/v1.2`.
The draft digest was dd510a9fd24bea14db1cb884afe10060484901b5d05d847806fb981f345c82d4.
Freeze changes status and declares the real advisory source shapes (L6).
All fixture bytes are retained. Envelope v and signing domain remain 1.

Additive over 1.1: Hello optionally carries sourceProtocol=1 and sources
(messages/browser/location/folders: ready, needs_permission, off). Receivers
ignore malformed optional Hello source metadata as one unit, validating the
core independently; authenticate and hash the original bytes. The corpus rejects
malformed metadata as a declared shape; runtime tests prove receiver tolerance.
Ready echoes sourceProtocol=1 only for a valid sources advertisement.
Capabilities remain unchanged. Workspace negotiation remains independent.

mac_source uses files scope and existing Execute/grant/ledger/cancel authority.
Arguments use mac_source_args: read request <=65536 canonical UTF-8 bytes;
scan operation allowlist and cursor <=16384 characters. Result JSON is <=262144
canonical UTF-8 bytes. CX refuses execution until X1.

Deploy CX before D1. Retry only a 4400 pre-Challenge rejection, first without
source metadata, then without workspace if necessary. Reprobe after five minutes
or when advertised facts change.

Check both reference implementations:
`node spec/_tools/contract_pack.mjs spec/device-service/v1.2`
`python3 spec/_tools/contract_pack.py spec/device-service/v1.2`.
Never edit a frozen pack after publication; amend in a new version directory.
