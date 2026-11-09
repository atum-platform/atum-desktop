# Mac reach-down guard (A-GUARD / SP-5)

`seatbelt.ts` and `egress-proxy.ts` remain public facades. The profile adapter
uses **@anthropic-ai/sandbox-runtime 0.0.78** through its Mac-specific deep
imports. It decodes the wrapper's quoted argv without executing it, verifies
the version and expected profile sections, and fails closed on drift.

srt supplies the deny-default process, IPC and network foundation. Atum replaces
its write section with canonical literal roots and HOME-anchored trust-handoff
denies. This avoids caller-path glob interpretation (#576), cwd-dependent policy,
and `/tmp` versus `/private/tmp` ambiguity (#596). The typed Atum adapter rejects
unknown keys (#434); it never loads an srt settings file from an Execute body.
Credential denies, their ancestor rename protections, and permanent app-launch
denies follow the granted allows. An own-working-copy carve-out excludes only
its enclosing Drive write deny, and cannot reopen another credential deny.

The proxy uses srt's HTTP/CONNECT parser. It requires an ephemeral main-process
session token, a live grant, and a permitted destination. DNS answers are checked
and dialed without a second resolution. Loopback, host interfaces, metadata,
link-local, multicast, private IPv4/IPv6 and CGNAT addresses are refused by the
proxy even if the hostname or literal was always-allowed. Stop closes client
sockets and invalidates in-flight approvals and lookups; a later grant can use
the same service again. The token is never included in audit records.

## Required runtime wiring

The device host requires the wiring below. Standalone tests exercise the interfaces; installed-application boundary checks require a separate validation run.

1. Add exact `"@anthropic-ai/sandbox-runtime": "0.0.78"` to desktop dependencies
   and regenerate the root npm lock. Use the lock-resolved dependency version.
   Record Apache-2.0 for srt, MIT for zod/commander/socks5-server, and select
   **BSD-3-Clause** for node-forge's dual-license alternative in the license catalog.
2. Pass `egress.authToken` from runtime to host options. Construct proxy URLs as
   `http://srt:<token>@127.0.0.1:<port>` in `constrainedHostEnv`. Keep them in
   main/host memory and command environments, out of renderer IPC and logging.
3. Use the system `/usr/bin/ssh` and `sshProxyCommand('/usr/bin/python3', port)` from this directory to construct
   `GIT_SSH_COMMAND` and any supported plain-SSH wrapper. Set
   `ATUM_DEVICE_PROXY_TOKEN` from the trusted host environment and copy that
   variable in Python's `forced_command_env`. The helper reads the token from
   the environment and sends authenticated CONNECT. Stock macOS `nc -X connect`
   cannot supply this proxy password noninteractively.
   The proof exercises the installed system OpenSSH (10.3p1 on the proof Mac),
   including hostile CLI/HostName expansion canaries. Run it on each supported validation host;
   do not substitute an unverified older SSH executable from PATH.
4. Force Git's proxy authentication method with trusted environment config:
   `GIT_CONFIG_COUNT=1`, `GIT_CONFIG_KEY_0=http.proxyAuthMethod`,
   `GIT_CONFIG_VALUE_0=basic`, copied into `forced_command_env`. The system Git's
   challenge-first CONNECT otherwise aborts against the authenticated srt proxy.
   These environment values must replace untrusted equivalents.
5. Create a trusted empty `GIT_TEMPLATE_DIR` and force it for command execution.
   Clone/init write `.git/config`, so they require the existing **persistence**
   approval; read-only remote queries need none. Never open `.git/config` merely
   because a command requests it in `args` or `needs`.
6. Set `SeatbeltRuntime.sshAgentSocket` from the host's trusted `sshAuthSock`
   getter. The socket is opened by an exact canonical `path-literal` only when
   `ssh_agent` is approved. mDNSResponder and direct port 22 are also opened
   under that grant; arbitrary Unix sockets remain closed.
7. Stage the disclaim launcher for dev builds using the existing staging module.
   The proof script stages it and routes the legacy G0 command probes through it.

The proof checks actual public git/npm/pip traffic and OpenSSH transport
negotiation, using no owner SSH key. GitHub refuses authentication as expected
after completing the SSH handshake. It separately checks an approved SSH agent
connection through the exact trusted socket.

## Residuals / release gates

- Per the coordinator decision, ordinary loopback TCP and local binding remain
  available. Docker TCP 2375/2376 and debugger 9222/9229/9230 are denied, but an
  arbitrary local proxy or debugger on another port can still provide a relay.
- Trust-handoff regexes are anchored at HOME. Repositories in writable temp
  directories or a working copy outside HOME are not covered by that list.
- srt's read foundation remains broad, narrowed by Atum's named credential and
  secret-store denies. This is an owner-Mac command sandbox, not a multi-user
  file-isolation policy.
- **A2-12 launchd submission is closed:** `job-creation` is denied, launchd XPC
  lookup is denied, and a renamed/ad-hoc-signed launchctl cannot submit a canary
  job. File mounts remain denied even with all grants.
- **A2-12 RunAsNode fuse remains a release residual.** Local-brain still needs
  `ELECTRON_RUN_AS_NODE`; converting it to `utilityProcess.fork` and flipping
  the fuse belongs to A-APP. Exec and LaunchServices compensation is tested
  against the installed candidate, copied bundle, helpers and symlink. This
  residual is restricted to the owner's two Macs and must close before C1;
  the guard does not disable a working local-brain silently.

## Proof

From the repo root with Node 24, a real exact dependency install, the installed
candidate and a live SSH agent:

```sh
scripts/s1-acceptance/seatbelt-proof.sh
```

Override `ATUM_SEATBELT_APP` for a different installed candidate executable, and
`ATUM_SEATBELT_REPORT` for the JSON report location. The script refuses missing
prerequisites, runs strict Mac positive/negative controls, and rejects any skip.
It uses canaries and cleans temporary mounts/jobs/files; no production, owner
credentials, signing identity or model calls are involved. The fake LSEnvironment
app and copied launchctl get temporary ad-hoc signatures solely for viable
positive controls.
