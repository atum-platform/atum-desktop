# Shard setup repair

The fifth Hermes shard failed before collection. Automatic activation generated
a PM workspace and ran `uv lock`; fetching optional KittenTTS wheel metadata from
GitHub exhausted three connection retries. This was a setup failure, not a Drive
assertion failure.

Prepare the shard environment with the existing client job's locked sync command
and export its Python through the test runner's supported HERMES_PYTHON entry.
The runner still executes the same shard, isolation and completion checks. No
optional provider was removed and the lock was not changed.

The public outbound guard passed with exit 0 after fetching full public history.
No push, rerun, release or deployment was performed. Full hosted shard execution
remains pending the coordinating session's push.

Superseded by ci-hermes-shard-recovery.md: the in-tree environment bypassed PM tools and interpreter semantics. Restore canonical activation and increase the forwarded metadata timeout instead.
