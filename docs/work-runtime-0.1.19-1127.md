# Work runtime 0.1.19 pin — 2026-11-27

`apps/desktop/runtime-tools.json` pins Work 0.1.19 from atum-work release branch `a7e44d458c` (atum-work #7):
- relay-supplied per-thread MCP servers, bound to the launching OAuth session;
- Claude/ACP progress as `commentary` items, used for multi-step answers in relayed turns;
- 2 h tool timeouts with disconnect propagation;
- host account tools withheld on relay-attached threads.

Built by the hosted `Atum Work archive` workflow (run 45877132236; earlier attempts were not acquired during GitHub's macOS arm64 capacity constraint). Archive SHA256 `454e10816127ea5134e096b1d7e39a77374dc492a50dbfc67009e462e2f78fce`. Real `stageWorkRuntime` against the downloaded archive verified the digest and arm64 payload, and derived pin.json version 0.1.19.

Owner requests: option A (the agent's own tools inside Mode B sessions) and "I did not see the multi step answer behavior". The relay attachment stays inert until the agent host is enrolled and the desktop allowlists the tunnel origin (#144).
