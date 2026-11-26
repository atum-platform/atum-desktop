# Cloud agent plan selection after restart

The native composer could show the managed default after a restart and refuse a switch from Claude Opus 5.5 to GPT-6.2-Astra. The old Work sync page omitted saved selections for unannounced agents. When the in-memory selection disappeared, the picker sent a revision that did not match the native selection row.

The picker now reads the selection and revision through the owner-scoped `work_selection_read` operation on device-services. Native main reads the current revision before saving and retries a revision conflict once if a fresh read shows that the revision advanced. The composer uses the saved model returned by the server and ignores stale reads started before a successful save.

The Matrix destination snapshot has its own revision counter and omits the native plan selection. The owner read uses the same row as the native write and applies the same agent ownership check. The direct ChatGPT plan row for a cloud agent with a connected Mac continues through `work_selection_set`. The existing cloud subscription write remains available to its own rows.

Status is built locally. Platform migration 0552 and the corresponding device-services handler need to be available before this desktop build is released. Installed-app acceptance by the coordinator remains open.

The focused Vitest suites cover restart with an empty ledger, a stale read arriving after a successful switch, direct GPT-6.2-Astra routing, and one retry after a revision conflict.
