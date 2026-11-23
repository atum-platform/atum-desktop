# Mac setup with cloud-runtime agents

S2 agents publish `runtime: hermes` on the owner roster. This is a cloud route even when the legacy `answering` field still says `local`. Desktop must not create a local agent executor, start an agent Hermes process, or acquire a legacy answering lease for these agents. Saved controller-era failover policies cannot make an S2 agent a Mac answering/standby runtime.

The existing cloud-only readiness path skips local assistant, Hermes, model and lease checks, preserving the owner sign-in check. The sidebar therefore does not offer local assistant setup for an S2 agent. Older controller agents retain their existing local/legacy-cloud behavior.

Work runs on the Mac independently. Its account binding requires the signed-in account scope, the verified platform owner principal from `/me`, and this Mac's device enrollment. It must not obtain the principal from a local agent executor enrollment. The owner read is coalesced and retained only for its account generation; late answers after an account switch are discarded. Identity refusal leaves Work absent until a later activation succeeds. Runtime staging, model access, wallet access and consent remain separate prerequisites.

The existing device-service enrollment activates the Mac transport. Work's gate uses the device-service Work enrollment and route facts; it does not enroll a local agent. Mac-source reach-down also resolves its owner through `/me`, retaining grant-owner matching and rechecking account scope, cancellation and consent after the read. Terminal/file/computer reach-down continues through the existing device grants and transport.

## Platform boundary

No SQL change is required. `matrix_local_executor_begin` is a real agent enrollment: an unnamed request resolves the owner's default agent. It is not a device-only registration endpoint. The runtime fence in migration 0455 correctly rejects those claims for S2 agents and must remain intact.

The device registry and Work route already provide the required independent boundary: device-service enrollment plus the Work facts, edge routing and subscriptions introduced in migrations 0523, 0528 and 0529. Work remains unavailable if those actual route prerequisites are missing.

Legacy local agents and controller-era standby runtimes still consume local-hermes enrollment for SDK hosts, model/profile setup, answering leases and local turns. App executors enroll through their app proxy endpoint. Current Work owner sessions, delegated Work gate/relay, Work model credentials and S2 reach-down require no local-hermes agent executor.

## Verification and rollout

Focused behavior tests cover a cloud Hermes roster with stale `answering: local`, readiness without local enrollment, Work visibility, identity refusal/retry, account-switch races, existing enrollment refusals and Mac-source identity refusal/scope changes. Eight focused Vitest files passed (158 tests). Electron TypeScript and targeted ESLint passed. The public guard is run against the committed change.

This source change requires a desktop release; it is not an installed-app proof. Verify an installed restart without local-hermes enrollment, the Work rail and owner session, and an approved agent reach-down action. No platform migration needs to precede that release.
