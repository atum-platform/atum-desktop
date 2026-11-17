# Managed Google and owner-chat MCP sources

An operator can classify a first-party MCP server in the existing managed
`config.yaml` entry:

```yaml
mcp_servers:
  workspace:
    command: workspace-server
    atum_source: google
  owner_history:
    command: owner-history-server
    atum_source: owner_chats
```

Only the exact values `google` and `owner_chats` are accepted. Missing or invalid
values retain the ordinary MCP policy. This is a security classification: use it
only for operator-controlled first-party sources. Server tool metadata, results,
and portable plugin declarations cannot grant it.

Both classifications permit calls while the execution holds Google data.
Successful Google results latch the execution and use the native Google
prompt-injection screening, including its warning and turn taint. Error results
do not latch. Owner-chat calls follow the existing native `atum_chats` policy,
including on a tainted turn; their results do not latch or invoke Google screening.
The existing injection policy still refuses Google MCP calls on a tainted turn.

The marker is carried on each scoped registry entry for live tools, cached tools,
and resource/prompt utilities. Registration uses the consuming config rather than
server schemas or cached metadata. Shared-connection identity includes this classification so registrations with
different source policies are not silently reused. Reload or restart MCP
registration after changing or removing the marker.

Regression coverage in `TestAtumSourceFence` in `tests/tools/test_mcp_tool.py`
uses real config parsing, registration, dispatch, the fence and native screening,
with transport responses stubbed. It covers the hosted launch latch, late Google
reads, invalid markers, metadata spoofing, owner-chat parity, scope isolation,
marker removal, errors, clean content and multimodal warnings.
