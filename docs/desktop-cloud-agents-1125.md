# Desktop cloud-agent cutover

The Matrix desktop now sends assistant messages through the owner's Matrix session. The cloud roster supplies assistant identities and model choices. The desktop no longer places an assistant on a Mac, watches assistant rooms to execute local turns, or runs the local follow-up and awareness engines. Work remains the supported way to run tasks on a Mac.

The production build starts at `matrix.html`, `matrix-pages.html`, `matrix-pet.html`, `src/matrix/sdk-entry.ts`, and `electron/matrix/main.ts` plus its preloads. The baseline Vite and esbuild manifests excluded the playground. The playground entry and browser proofs tied to it were removed. Fixture data used by independent renderer tests lives under `src/matrix/__fixtures__`.

Device enrollment and the device bridge remain available to cloud agents. The owner still approves device actions with the existing cards and Touch ID. Browser import, Drive, Team Space, pets and Work remain in this build. The Matrix preloads omit the retired settings and voice routes that required an assistant running on the Mac. Older executor records still participate in account and device revocation. Their presence does not start a local executor. The cloud persona and roster client remains in `agent-definition.ts`, which is also the Work relay's snapshot contract.

Runtime packaging removal waits on a Work sidecar follow-up. The Work supervisor is launched through the packaged Python and its managed ACP providers import Hermes from the same resources. The build keeps that runtime and its package verification until Work can start without it. Pet rendering and legacy account maintenance also use bounded helper calls from that runtime. This slice stops staging the separate local-brain payload.

The cutover removes the offline assistant path. Operations that depend on an assistant reply require the cloud assistant to be reachable. A rollback uses the previous desktop build. This change leaves existing assistant profile directories in place.

Local production builds reduced the generated `dist-matrix` tree from 175,736 KiB to about 168,600 KiB, including source maps. The main bundle went from 9,572 KiB to 7,492 KiB. These are build-tree measurements. The installed app and its data were left alone, so launch time and final packaged size were not measured.

The focused cloud-send, lifecycle, account, owner-device repair, loopback proxy, and package-hook run passed 355 tests. The prepush adapter's pinned public-client workflow digest predates the workflow in this branch's unmodified base.

The roster and assistant-card tests cover the cloud-only presentation. The preload tests cover the removed Mac assistant routes alongside the preserved profile, assistant editor, routine, and device contracts.

The relocated Team Space fixture uses one member key across its mock directory, channel owners, and conversation participants. Its public Matrix identifiers are synthetic and the fixture stays outside the production module graph.

The first full Vitest run reported 80 failed tests and two failed suite loads on an earlier checkout state. Its log includes retired runtime contracts, an intermediate roster error, and timeouts. Follow-up coverage checks owner SDK startup while the cloud roster is pending, the retained utility runtime's development configuration, the Agent Desk with an older snapshot, and the cloud routine destination. All 89 tests in those four files passed.
