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

Eight focused regressions also passed for cloud messaging, Stop, model selection, subscription settings, Drive attachment, and Chief of Staff routing. The Settings navigation test passed after it was updated to check the surviving Connections sections and the absence of the retired Mac source controls.

## Public client CI repair

Rebased onto `e94c8944`, which includes the direct T3 relay from #129. The rebase applied cleanly. The production relay code remains present. The six slice commits removed the retired playground relay proof alongside the other playground assets.

Cloud replies reuse the SDK's standard rich-reply path through the guarded owner post. The roster keeps a newly created room selectable until sync verifies it or the room is left or forgotten. The pointer is scoped to the account and agent. A previously linked document can be unlinked within that account and selected room without changing the saved file or reopening the local file picker. The starter allowance uses cloud roster readiness for a cloud primary.

Hosted client run `45586945208` reported 64 failures in two renderer files. The numbers follow the failure order in the job log. Parameterized variants share one decision.

| Failure | Hosted test | Decision |
| --- | --- | --- |
| 1–5 | keeps secondary controls behind localized dialogs and menus in en, vi, zh, zh-hant and ja without dispatching anything | Updated. Keep localized Advanced settings, the conversation menu and the message actions menu. Assert that Reply settings is absent and opening controls dispatches no mutations. |
| 6 | opens promoted Main from the single Atum primary row and reuses it from New message | Updated. Promoted Main still opens from one primary row and New message reuses it. Assert two selects, no create, and no local connect. |
| 7 | keeps warnings in the conversation while healthy listening is one switch in reply settings | Removed. The warnings and switch in this test belong to the retired Mac listening settings. |
| 8 | says nothing in the conversation about paused listening; its switch in reply settings stays on | Removed. Paused Mac listening and its switch are retired. |
| 9 | says a Stop this Mac could not save in reply settings, where the switch presses Stop again | Removed. Stop this Mac and its save retry are retired. Cloud Stop keeps its separate coverage. |
| 10–14 | notes in vi, en, ja, zh and zh-hant reply settings, and only there, that this Mac keeps handing the assistant over | Removed. The lease handover explanation in local Reply settings is retired. |
| 15 | keeps document pending state and failure until room controls can safely close | Updated. Keep pending, failure and retry coverage for removing a legacy document. The control lives on the document status row after Reply settings is retired. |
| 16 | opens the start sheet from Cmd+N in a compact window, and a pick leaves the drawer shut | Updated. Keep compact Cmd+N, both People and Assistants selection, and the closed drawer. Assert cloud room selection without a local connect. |
| 17 | retries a pending assistant room, then uses the one permitted first-contact route | Fixed. Retain the pending room until sync verifies membership. Verify one creation and reuse through both the primary shortcut and New message during partial sync. |
| 18 | retires the pre-sync assistant retry pointer so a left room cannot trap the shortcut | Fixed. Retire the pending room on leave or ban. Retest a replacement create and assert the left room is never selected. |
| 19 | does not reuse a pre-sync creation retry after the enrolled assistant changes | Updated. Keep the pending pointer scoped to the current assistant. Assert a fresh create after the assistant identity changes and no selection of the prior room. |
| 20 | offers an explicit saved-document link, disables listening, and keeps late failures in their original room | Removed. The saved-file picker that granted a local assistant access and its listening interlock are retired. Existing links retain a preview and scoped removal. |
| 21 | isolates a pending document failure across users in the same room and hides an unreadable name | Updated. Keep the original same-room account boundary. Reject an in-flight removal after an account switch and assert neither the prior filename nor its error appears. |
| 22 | explicitly listens in one room, stops it from that room's switch, and never says it in a chat | Removed. The temporary Mac listening switch and its chat suppression are retired. |
| 23–24 | enables continuous listening only for the default and named agent selected rooms | Removed. Continuous listening was scoped to a local agent executor. Neither the default nor the named cloud agent uses this switch. |
| 25–26 | runs only an explicit own-message action (file=false and file=true), reports cancellation, and exposes stop while running | Removed. Explicit local invocation, cancellation and Stop from Reply settings are retired. Cloud Stop remains covered by its own tests. |
| 27 | holds the window on the real step until the assistant and its model are ready, then lands in its chat | Updated. Keep the startup step and resulting room creation assertions. The room opens without a local assistant connect. |
| 28 | opens automatically during a setup cooldown while assistant sending remains paused | Removed. Local assistant setup cooldown no longer controls cloud composer readiness. |
| 29 | shows a valid unseen starter allowance only in the settled default assistant chat | Fixed. Gate the default chat's allowance on the cloud roster's readiness. Keep the seen marker and verify the first cloud send clears the notice. |
| 30 | says a start after launch only in the message box, however slow, never as lines in its chat | Removed. Post-launch Mac runtime progress in the composer is retired. The cloud quiet-launch test verifies a usable composer. |
| 31 | offers the latest Atum, not a retry that cannot help, when the install itself is damaged | Removed. The local assistant runtime repair download is retired. Desktop update tests cover app updates separately. |
| 32 | says running out of Protons once, in the indicator, and tops up from there | Removed. The out-of-Protons reason in this fixture came from the local model executor. The independent Store top-up and cloud-account access tests cover the available server-backed signals. |
| 33 | pauses sending when Protons run out mid-chat, with the top-up and a model of their own | Removed. The runtime's mid-turn Proton preflight no longer pauses cloud sending. Existing tests cover the cloud model and subscriptions routes and the Store top-up. |
| 34 | keeps preparation behind loading until ready and never reads 100 before completion | Fixed. Keep startup behind the pending cloud roster even without local readiness. Assert the progress remains below 100 until the roster resolves. The post-launch Mac runtime placeholder is retired. |
| 35 | sends straight to this Mac: no assistant server path, no dialog | Removed. Direct send to an executor on this Mac is retired. Owner Matrix send is covered by the native IPC and composer tests. |
| 36 | shows your message the moment you press Send, before this Mac has even kept it, then never twice | Updated. Keep the instantaneous echo, sending status and deduplication. Resolve the owner Matrix send with an event ID and reconcile against the synced event. |
| 37 | keeps the words of a send this Mac could not take in the box, says why in one line, and Try again sends them | Updated. Keep refusal copy, draft restore, no duplicate echo, Retry and a cleared draft after success. Trigger refusal on the cloud send bridge. |
| 38 | names an assistant whose setup is failing on this Mac, and keeps the words | Removed. Local runtime setup failure no longer blocks an assistant send. |
| 39 | says busy only when the assistant really is busy | Removed. The removed local executor refused admission when busy. Cloud sends post via Matrix and cloud replies use cloud Stop and no-reply status. |
| 40 | clears the box once a send went out | Updated. Keep draft clearing after a successful cloud post. |
| 41 | Try again sends what the box holds now, and a second failure gives those words back | Updated. Keep Retry's use of the current draft and restore it after a second cloud refusal. |
| 42 | sends a long message, and keeps one too long for a single message in the box with the reason (FR20) | Updated. Keep long-message success, byte-limit refusal and the oversized draft. Check the cloud send bridge receives only the valid message. |
| 43 | keeps the listening room on the local path too (the composer branch is gone) | Removed. Listening and routing through the local composer are retired. |
| 44 | pauses the composer while degraded, with a banner, and keeps the draft | Fixed. Keep a useful pause, notice and draft for a chat with a legacy local link. Test removal failure and retry, then send the same draft once the link clears. |
| 45 | offers Try again on an interrupted turn | Removed. The local interrupted-turn projection and retry queue are retired. Cloud no-reply retry and cloud reply status have separate coverage. |
| 46 | keeps human sends and a healthy named agent usable after a cold withdrawn-default launch | Updated. Keep human sends and a healthy named cloud agent's sends usable while a legacy primary is withdrawn. |
| 47 | answers in another agent's room with that agent's own state: one broken agent never blocks another | Updated. Verify both cloud sends go to the named agent when the default has different Mac readiness states. The named agent's local readiness pause is retired. |
| 48 | shows an agent content failure without disabling its healthy composer or changing row navigation | Updated. Keep row navigation, menu isolation and a working named-agent composer despite a content metadata error. |
| 49–50 | keeps other agents usable while a blocked or degraded withdrawn selected agent explains its stopped permission | Removed. Blocked and degraded Mac authority explanations and their send gate are retired. The cloud isolation case verifies a different agent's postings independently. |
| 51 | draws an answer like a normal chat message: no row under it, the toolbar on hover (owner 11-18) | Fixed. Keep the answer toolbar's Reply and all normal message rendering assertions with cloud data. |
| 52 | asks an answer's question again and copies it from the answer's menu | Updated. Keep answer Retry, clipboard copy and no unrelated commands. Retry posts the original question through the cloud send bridge. |
| 53 | edits your newest question for real, then asks it again as the next turn | Updated. Keep the Matrix edit, append-only reask, restored draft and closed edit bar. The reask posts through the cloud send bridge. |
| 54 | never drops a send that still reaches the box while the assistant is paused | Updated. Keep Send and Retry disabled, preserve the draft even on a submitted form, then send it after the actual cloud link pause clears. |
| 55 | keeps an edit that asks again in its bar while the assistant is paused, saving nothing | Updated. Keep the edit and draft while the cloud link pauses sending. Assert neither edit nor send was dispatched. |
| 56 | logs an automatic existing-room refresh failure without raising the window band | Removed. There is no automatic local-host refresh on opening a cloud room. |
| 57 | opens New message (the start sheet) from Cmd+N and returns to the assistant’s existing conversation | Updated. Keep Cmd+N reopening the existing assistant conversation without creation or local connect. |
| 58 | moves to the main when the open room becomes earlier, with the draft, and the next send goes there | Updated. Keep the automatic move to Main, its migrated draft and a single cloud send to Main. |
| 59 | replies to your assistant's answer with the answer's words as context | Fixed. Restore Reply on a cloud assistant answer. Preserve the Matrix rich-reply target through renderer, preload and the guarded owner send. |
| 60 | shows nothing while six assistants check their trust and start, and nothing once they are ready | Updated. Replace the six local trust/start projections with the six-agent cloud roster. Assert quiet launch, an enabled composer and an owner Matrix send. |
| 61 | is one indicator item for a cause every assistant shares, and no amber row | Updated. Replace local Proton readiness aggregation with the supported shared cloud access signal. Assert one account read and one notice in whichever assistant chat is selected. |
| 62 | says a shared runtime_invalid once, in the indicator, and names it in the message box | Removed. The shared local runtime repair state is retired. |
| 63 | says a shared action_required once, in the indicator, and names it in the message box | Removed. The shared local assistant enrollment action is retired. Owner account sign-in and setup still have separate coverage. |
| 64 | says a shared device_replaced once, in the indicator, and names it in the message box | Removed. The local assistant device replacement watch is retired. Owner device sign-in, repair and approval keep separate coverage. |

The full desktop Vitest run on Node 24 with the checkout's Python 3.14 passed 21,281 tests across 1,469 files, with 23 tests skipped. After the final startup and test typing changes, the six affected suites passed all 514 tests. Desktop typecheck, lint and the Git diff whitespace check passed. Lint reported 2,846 warnings and zero errors.
