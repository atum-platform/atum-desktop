# Atum 0.20.52

- Connect ChatGPT, Claude or Antigravity in one Connections pane in Work, so your agents can use your plan.
- Work now uses Atum’s look, with Work and Code modes.
- Chats use one read signal. Disconnect this Mac from Settings.

## Release preparation

Desktop package and workspace lock versions are 0.20.52. Work runtime
0.1.13 is already pinned by runtime-tools.json; this preparation preserves it.
The release coordinator owns the merged public pin, private assembly, signed
and notarized artifacts, update feed and website download.

Local verification: desktop lint passed (warnings retained); cloud-data-v1 Node
and Python validators passed; upstream-watch tests passed. Client import-boundary
scan passed. Typecheck and private-absent compilation could not pass with the
reused dependency installation: react-streamdown is missing. No dependencies
were installed. Full protected client/Hermes/Python/workspace/E2E and dependency
audit workflows remain exact-head coordinator gates; the source-only lane
does not provision their multi-gigabyte dependency/runtime closure.

The coordinator must run the trusted public outbound guard on the exact final
commit before pushing. Guard results are retained in the private release handoff.
