# Cloud agents reaching the owner's Mac (Hermes-native route)

Atum's cloud host gives each agent a `mac` delegation profile (a Hermes profile whose terminal backend is SSH to the
owner's Mac). Two things in this tree make that route usable by the model:

## The "Where you run" section

`agent/prompt_builder.py` renders one section per place. A managed (`agent.atum_instructions`) agent that has the
device-bridge tool (`device_send_file`) keeps `ATUM_CLOUD_PLACE` (`device="<Mac name>"` routing, unchanged). A managed
agent **without** the bridge, which is the Hermes-native cloud host, gets `ATUM_CLOUD_PLACE_NATIVE`: terminal and file
tools run in the cloud; for the owner's Mac, call `delegate_task` with a task whose `profile` is `mac` (a bare `profile=`
argument is not a `delegate_task` parameter and would run a cloud helper); if no `mac` profile is offered, say so. The
text is identical whether or not a Mac is connected, so connecting one never changes a conversation's prompt bytes. A
stored conversation built with the other text is rebuilt once at its next turn boundary (managed agents:
`_stored_prompt_matches_instructions`).

## SSH ControlMaster socket path

`tools/environments/ssh.py::_control_dir()` keeps `<tmp>/hermes-ssh` while the socket path fits the AF_UNIX limit
(103 usable bytes including SSH's 17-byte suffix). Hermes points `TMPDIR` at `<home>/cache/scratch`, which under a deep
home (for example `/computer/agents/<uuid>/private`) overflows it and SSH fails with "ControlPath too long"; then the
existing `hermes_constants.socket_safe_tmpdir()` root is used in a private per-user directory (`hermes-ssh-<uid>`, 0700).
Shallow homes and the normal macOS `TMPDIR` are unchanged.
