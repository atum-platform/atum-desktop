# Cron MCP allowlist backport (2026-11-16)

Security backport from upstream Hermes Agent ahead of the broader upstream
integration. Two upstream commits are cherry-picked unchanged, with their
original authorship and `cherry picked from commit` trailers:

- `11cebb30dafd478c7f30818715ba248f24e44212`: a per-job MCP allowlist must not
  widen into every enabled server.
- `7c8810dc215733d5e420c36c83ec761f43b77c0f`: a configured but disabled MCP
  server must not widen the job either (it moves the tests into
  `tests/cron/test_scheduler.py::TestPerJobToolsetMcpMerge`).

## Defect

`cron/scheduler.py::_merge_mcp_into_per_job_toolsets` treats a job's
`enabled_toolsets` as an MCP allowlist only when it already names an MCP server.
It compared the job's list against bare server names only. A job that named a
server by its toolset spelling (`mcp-<server>`), or named a server that is
configured but disabled, never matched. The fallback then unioned every enabled
MCP server into the job: with filesystem, github and slack enabled,
`["mcp-filesystem"]` resolved to `["mcp-filesystem", "filesystem", "github",
"slack"]`. An unattended job could therefore run with MCP servers its owner did
not select.

## Behavior after the backport

- Bare aliases and `mcp-<server>` spellings both name the same server and keep
  the job's allowlist narrow.
- A listed server that is configured but disabled still counts as the job's
  selection: it stays off and nothing else is added. This matches the
  interactive resolver (`hermes_cli.tools_config._merge_mcp_servers`).
- Unchanged: a list that names no MCP server still merges every enabled server,
  and the `no_mcp` sentinel still means none.

The public code at the backport base matched the upstream parent of these
commits, so both applied without adaptation. The wider upstream v0.23.1
integration remains a separate, later outcome.

## Verification

- `python -m pytest tests/cron/test_scheduler.py -k 'PerJobToolsetMcpMerge or toolset'`
  — **9 passed**, including the three upstream cases (toolset spelling, toolset
  spelling alongside a native toolset, configured-but-disabled server, bare and
  prefixed).
- `ruff check cron/scheduler.py tests/cron/test_scheduler.py` — **passed**.
- The full cron and Hermes suites run in the public `hermes` CI job; the local
  environment available for this change did not match the locked project
  environment, so those results come from CI on the pull request head.
