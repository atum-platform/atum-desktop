# Remote brain profile enrollment

`python -m hermes_cli.remote_brain --home PROFILE --endpoint HTTPS_MCP_URL`
installs the existing native MCP search/get_page tools before conversations start.
Use native interactive MCP login once, or supply a protected `--client-file`
with client_id and client_secret for unattended machine authorization. The MCP
SDK owns token acquisition and renewal. Credentials live in native protected
storage and never in config.yaml. Repeat --home for additional profiles.

Optional `--local-brain-root` installs an account-specific ingestion freeze. The
native desktop supervisor rejects ingest, correction and new coverage writes;
recall and privacy fencing/withdrawal remain available. Native index recovery
still needs filesystem writes. This does not export or migrate old knowledge.
The profile skill asks for cloud-first recall and historical local evidence only
on outage, preserving existing awareness suppression and custody contracts.

The machine OAuth adapter uses the SDK ClientCredentialsOAuthProvider. It uses the repository-pinned SDK 2.3 machine grant, binds the credential to
the endpoint issuer, and seeds cached token expiry on process restart. It introduces no OAuth server or token timer.

Verification: focused native supervisor tests include ingestion freeze, recall
and privacy removals. The private assembly's real-engine fixture proves native
machine credential reissuance after expiry with cited retrieval. Production
activation, physical migration and installed-client acceptance are separate.

Local verification: 15 native supervisor tests passed (exit 0). Private assembly
verification with the pinned MCP 2.3/httpx2 stack passed 116 focused Python tests
and the real GBrain renewal/citation fixture. No installed user profile or data
was accessed; no physical migration, push, PR, CI or deployment was performed.
