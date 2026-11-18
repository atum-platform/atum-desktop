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
