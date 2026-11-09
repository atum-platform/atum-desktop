# Model client

Shared Node transport for the desktop Mac job path and private controller: HTTP broker, bounded gateway/SSE transport, digest-keyed grant admission/revocation and opaque bearer tokens. The package has no controller process, device hub, cloud lifecycle, AWS, provisioning, filesystem persistence or orchestration dependency. It uses the existing device-protocol canonical JSON helper.

Consumers currently import source modules by relative path, following the repository workspace convention. The controller broker/grant entry points re-export these modules for compatibility. Google attachment route identity lives here so the transport does not import desktop code.

Run `npm run check --workspace packages/model-client`. Broker/grant/digest/gateway tests moved here with their implementation; private subscription/relay and Google/controller integration tests stay in cloud-controller.

The desktop boundary guard runs as part of its typecheck. To compile renderer and Electron while denying filesystem access to both private server packages, run `node apps/desktop/scripts/check-client-boundary.mjs --typecheck-without-controller`. This emits no build output and never renames or removes private directories.
