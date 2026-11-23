# Managed ACP profiles

Use `self-work.yaml` as the base for a dedicated gateway profile. Overlay
`delegated.yaml` in a second profile for editor sessions started by remote
assistants. Merge the YAML mappings and supply the model, gateway settings and
credentials during provisioning. Use a separate, application-owned
`HERMES_HOME` and gateway for each profile. In both profiles the editor uses
`hermes-acp` without connection management or computer use. Terminal approvals
are manual and auxiliary title generation is off.

Launch the prepared runtime with `python -P -B -X utf8 -m acp_adapter.managed`
and the trusted runtime source on `PYTHONPATH`. The managed viewer answers ACP
initialize without opening the provider or starting a gateway. Before accepting
session requests, the application should bring up the profile's gateway from
its own environment. The viewer only attaches to that gateway. Run the general
`hermes acp` launcher for interactive setup and unmanaged use.

The owner profile's `editor_mcp_tools` mapping pairs each allowed ACP server
name with its exact tool names. When configured, omitted servers and empty
lists are excluded before the editor transport opens. Prompt and resource
utilities are also excluded. When the entire setting is absent, editor MCP
discovery retains its usual behavior. Provision the policy before starting the
profile. The terminal denies direct calls to the editor bridge, the whole `t3` command
line (thread tools, auth and pairing, environment links, server control), the
plan makers' clients and Codex's login store through normal Hermes approval
checks; the rules are a floor under every approvals mode, yolo included.
`tests/acp_adapter/test_delegated_containment.py` calls them. The policy
governs Hermes tools. A process running as the same OS user retains that user's
OS authority: the file tools can still read any path that user can read, which
is listed as a gap in `docs/work-subscriptions.md`.
