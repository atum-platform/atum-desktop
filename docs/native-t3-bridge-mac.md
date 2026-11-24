# Native Work bridge

The Matrix desktop composition owns one private loopback connector per signed-in
account. `/ask` keeps its existing Matrix route. `/tools`, `/native-register`,
and `/native-consent` go to the selected agent's S2 profile through the owner's
existing Shell transport. The host selects from the current account's active
agent roster; a model cannot provide a URL, owner bearer, or another Mac identity.

Shell contract: `POST /api/host/native-t3`, header
`X-Atum-Host-Bridge-Contract: atum.s2.host-bridge/1.0.0`, JSON
`{agent, path, method, body}`. Allowed paths include the consent `phase=prepare`
and `phase=callback` hops. The existing consent sheet's tap sends
`{agent, mac, plan, alsoWhenScheduled, connectUrl}` to each agent. Connect URL
comes from Work's authenticated `/api/connect/link-state`, using its environment
hostname. The cloud derives the model, consent revision and Assistants project.

Work receives the local Mac identity, forward snapshot path, reverse binding path
and connector URL only through its internal startup channel. The startup secret
uses the existing private FD. These values never enter the managed provider
gateways. Consent checks refresh each agent independently; an unavailable profile
cannot route another agent's calls. Disabled client membership survives restart.

The renewal card uses the existing consent sheet and renews every named assistant
on this Mac. Sign-out and connector retirement disable snapshots synchronously.
No owner credentials, inference calls or live account data are used in tests.

Verification: focused connector, surface, Matrix composition, process and connection
sheet/store tests: 103 passed. Final host typecheck, boundary guard and integrated
cloud proof are recorded at the assembly checkpoint.
