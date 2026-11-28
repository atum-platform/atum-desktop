# 2026-11-28 · Work plan detection: migrate re-enabled `/usr/bin/false` stubs

**Symptom.** On one Mac, Work never detected the installed and signed-in Codex and Claude CLIs. The saved Work settings held `{"driver": "codex"|"claudeAgent", "enabled": true, "config": {"binaryPath": "/usr/bin/false"}}`.

**Cause.** `work_provider_instances` in `apps/desktop/electron/work/sidecar/supervisor.py` replaced the legacy placeholder only when it matched exactly, including `enabled: false`. Re-enabling the provider in Settings kept the `/usr/bin/false` binary, so the migration skipped it and every launch ran `false`.

**Fix.** Migrate any Codex or Claude instance with that driver whose config is exactly `{"binaryPath": "/usr/bin/false"}`, whatever its `enabled` value. Real custom configs, other drivers and the disabled OpenCode stub are unchanged.

**Verified.** `npx vitest run electron/work/sidecar/process-settings.test.ts` fails on the old code and passes with the fix. The affected Mac was repaired by hand (settings backup kept) and Work restarted with the defaults.
