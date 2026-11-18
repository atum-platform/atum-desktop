# ChatGPT relay transport negotiation

The desktop signs the optional `chatGptRelayMaxBytes` field in its existing
`Hello.body`. It is a positive safe integer in bytes. An upgraded desktop can
advertise `{"chatGptRelayMaxBytes":16777216}` once its WebSocket parser, relay
handler, subprocess input/output, and signed frame encoder support that bound.
The field participates in the original Hello signature and challenge hash.
Invalid values reject the Hello. The field grants no authority.

Controller request JSON and response JSON allowances use the lesser of that
advertisement and the 16 MiB authenticated hub memory/transport bound. Response
allowance additionally reserves 4096 bytes and worst-case 2x JSON escaping in
the signed frame. Serialized signed requests must fit the negotiated bound.
Oversize requests return 413 before dispatch, preserving all Mac services.

Absent advertisement means the frozen legacy fixture's 800,000-byte request
and response limits, plus its desktop's 1 MiB signed-frame limit. Response
allowance is consequently at most (1 MiB - 4096)/2. This maintains compatibility
with already released desktops. The frozen vendored pack stays byte-identical.
The runtime schema extends only relay byte limits. Negotiation examples live in
`fixtures/chatgpt-relay-negotiation.json` outside the frozen pack.

Deploy controllers supporting the 16 MiB hub bound first, then the desktop
release. A desktop must support its full advertised byte bound before sending
this field. Legacy and upgraded Macs can coexist. These transport/memory
bounds leave S2's 1,050,000-token context and 200,000-token compression intact.
