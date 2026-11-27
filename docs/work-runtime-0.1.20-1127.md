# Work runtime 0.1.20 (2026-11-27)

Pins the Work runtime built from atum-work `6ae403613e` (atum-work PR #8, merged into `feat/work-runtime-0.1.16`), archive run 45987900327.

- Atum layout consistency in the Work view (search, plus menu, gear right; Work-mode rows, banner lane, neutral notices).
- Real model names: Atum as a native provider (GPT-6 Luna, GPT-6.1 Terra), using T3's provider order, Show more, search and favourites.
- Default orientation (`agentInstructions`) for every provider session, including delegated children: Atum-branded, no personal paths, and which model family suits which job.
- The thread-MCP proxy forwards `Mcp-Name`, so agent tool calls are accepted by modern MCP servers.

Archive `atum-work-0.1.20-darwin-arm64.tar.gz`, sha256 `0e94432f992395a866532e41f176f7c1516f4d25918645bff9c6a4ef99f80220` (checked against the run's SHA256SUMS). The "Native fingerprint diff" check on #8 was still queued for a macOS runner when it merged; the archive built and passed on macOS from the same head.
