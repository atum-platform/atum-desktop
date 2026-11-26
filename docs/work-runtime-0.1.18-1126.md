# Work runtime 0.1.18 pin — 2026-11-26

`apps/desktop/runtime-tools.json` pins Work 0.1.18 from atum-work release branch `a783385ab4` (adds a generic `hidden` launch option for MCP-launched threads, atum-work #6, on top of 0.1.17's Work UI land and account connections). Built by the hosted `Atum Work archive` workflow (run 45748575165), archive SHA256 `587905e213f3969419f9b7b0f023cf699597e8bd4eb74b1cd7cfb57c6d16e46c`. Real `stageWorkRuntime` against the downloaded archive verified the digest and arm64 payload and derived pin.json version 0.1.18.

Owner request: Mode B conversation threads should not appear in Work ("it's a conversation, not a work session"). The agent side (atum-app #1073, held as draft) starts launching hidden threads once this runtime is on owner Macs.
