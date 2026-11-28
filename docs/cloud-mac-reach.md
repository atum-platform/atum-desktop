# Cloud agents reaching the owner's Mac (Hermes-native route)

The original cloud host gave each owner agent one `mac` delegation profile
whose terminal backend was SSH. The coordinated cloud-side named-Mac rollout
adds `terminal(device="list")` to check reachability and
`terminal(device="<Mac name>", command=...)` to select a Mac. Both native and
relayed turns use the owner agent's terminal through the same SSH route.
Environment pairing is unavailable in Atum chat.

## Desktop reconciliation checkpoint (2026-11-28)

The enrolled desktop starts reconciliation on launch and retries once a minute.
If a saved token has missing or invalid metadata, the app stops the old job
and asks the registry to prepare a fresh route under the signed-in owner and
current device. A registry `not_prepared` refusal also triggers re-prepare on
the next tick. Successful setup, pending enrollment, an unavailable port 22,
and a saved Disconnect are distinguishable in the log.

On installed 0.20.55 the native connector was observed running after relaunch.
The enrolled route answered a read-only Cloudflare SSH command with its
registered host key pinned. Focused tests cover the new legacy-state retry,
registry refusal recovery and preserved Disconnect behavior.

## SSH ControlMaster socket path

`tools/environments/ssh.py::_control_dir()` keeps `<tmp>/hermes-ssh` while the socket path fits the AF_UNIX limit
(103 usable bytes including SSH's 17-byte suffix). Hermes points `TMPDIR` at `<home>/cache/scratch`, which under a deep
home (for example `/computer/agents/<uuid>/private`) overflows it and SSH fails with "ControlPath too long"; then the
existing `hermes_constants.socket_safe_tmpdir()` root is used in a private per-user directory (`hermes-ssh-<uid>`, 0700).
Shallow homes and the normal macOS `TMPDIR` are unchanged.
