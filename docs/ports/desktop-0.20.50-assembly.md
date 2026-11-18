# Desktop 0.20.50 assembly

Source integration in progress; this document does not claim release or activation.

The release includes the existing Google-write/video-consent cards and relay capacity changes, current main runtime fixes, chat presentation, provider-scoped picker, runtime install retention, and native Mac setup. Native SSH setup uses the authenticated canonical hostname. Cloud behavior activation remains a separate server rollout.

Preserve native-backed UI and integrations. Do not fold the independent Electron major upgrade or incomplete lifecycle/recovery replacements into this release. Legacy transport removal requires proven replacement coverage.

## Integration record

- Merge current public main into the existing release outcome; preserve consent card and relay capacity changes.
- Integrate provider picker and transcript marker (a5914602f); focused combined verification follows.
- Integrate chat actions, in-bubble times and Matrix display (1b035c601); focused combined verification follows.
- Integrate runtime install retention (c96ec9e534); focused combined verification follows.
- Integrate certified relay protection (3006c72f); focused combined verification follows.
- Integrate native in-channel cron (80cf1a4e0b); focused combined verification follows.
- Integrate cloud check-in guard (988d40954f); focused combined verification follows.
- Integrate native SSH and canonical hostname f52f945f5; resolve chat conflict preserving deleted-message metadata and native approval cards, retain video-consent activation. Align Unix socket and compiled Swift helper complete-envelope bound with existing 16 MiB relay contract; real helper/socket test now sends and receives payloads exceeding old 800 KB limit.
- Restore Atum-owned app icon and image assets from #35 (57bdc29f), preserving original commits and license provenance. No third-party branding substitutions.
- Combined checks: 79 relay/native SSH tests pass, including compiled Swift helper and >800KB bidirectional payload; 19 native approval/Mac UI tests pass, 51 supporting chat/setup/display tests pass; renderer and Electron TypeScript pass. Selected ESLint: 0 errors, existing style warnings retained. Full app test result follows.
- Hosted client check on 29fea378b rejected an inline import type in cloud-agent.ts. Replace it with the standard type-only import; runtime behavior is unchanged. Verify the full desktop lint command before the corrective push.
- Pre-ship review confirmed the signed release builder omitted the relay helper from ASAR unpacking. Align it with the candidate builder and verify both configs unpack every executable produced by the real staging hook; update the staging test to simulate Swift compilation as well as archive extraction.
- Hosted Hermes slice6 exposed incomplete miniature source fixtures after runtime-GC integration. Reproduced the two doctor launcher failures locally. Include the real cleanup dependencies in doctor/source-publication/recovery/Windows-launcher fixtures; retain actual production startup/cleanup behavior.
- Full client CI also exposed a missing optional nativeMacSsh binding in the VM-based main lifecycle harness. Declare the absent external service in that sandbox, leaving real sign-out/enrollment code and assertions intact. Launcher verification:55pass16platformskips; dashboard case passed separately with declared FastAPI/multipart dependencies; touched Python Ruff passes.
