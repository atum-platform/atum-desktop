# atum.company-private-cos/2 — native private member CoS

Frozen new major over /1.3. Select Atum-Company-Wire: 2 explicitly. Capability
schemaVersion 5 and dispatch schemaVersion 2 are distinct from prior messages;
never accept a native dispatch through the old restricted-profile decoder.
Retain /1.x decoders only for compatible provisioning/old journal recovery;
new runs require /2, company-agent/1 and company-funding/2.2, otherwise 426.
No runtime/current advertisement is silently changed by this contract commit.

Keep plain io.atum.assistant DM, locale-aware greeting version 2, lazy creation,
company-wallet funding, 30-day purge and no user export. Upgrade native homes
in place: company/member/incarnation/room/home identity is preserved; a new
prompt/tool epoch does not erase memory. Retired incarnations never restore.
A private native home is isolated from every other member and all channel homes.
Purge stops/withdraws authority before deleting every private version, executor
cache, DB/file/MCP/browser state, ingress, journals, pointers and Matrix crypto,
then witnesses byte deletion. Shared company disclosures are excluded by S0.D.

Native full peer tools/rounds, persisted MCP and applicable device/computer
resources use the common cloud-agent path, never a personal owner's identity,
wallet, token or Store entitlement. Resource absence is typed and remains an
open parity gap. Scheduling, delegation and later domain writes require current
company/member-destination authority; this is not an unrestricted company-service
posting credential. S0.D defines member-delegate provenance/company retention.

Common peer funded-slice, effects/check recovery, independent home lease/CAS,
exact private-DM progress/interim/final, byte-stable conversation snapshot and
Stop/deadline rules are normative. No private/member-specific hardcoded reduced
allowance, approval tier, renewable segments or delta streaming. Verify real
native tool and second-turn resume, unknown mutation receipt, lease loss,
crash/deploy, private pair isolation and full erasure before activation.
