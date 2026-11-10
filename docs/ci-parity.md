# Public CI parity checkpoint

Built locally, not activated. No pushes, dispatches, settings changes or uploads.
Keep previous checks until replacements pass on the exact public head. Standard
hosted runners only; GitHub-owned actions pinned by SHA; no secrets or release authority.

## Adopted mechanisms

Extends the existing public workflow, canonical `scripts/run_tests.sh` file-isolated
runner and existing desktop import-closure checker. Raw git blob/mode validation
extends the approved snapshot mechanism to multi-commit history; gitleaks supplies
secret rules. No private source files, fixtures or manifests were copied.

## Parity table

| Previous job/lane | Public job / disposition | Coverage and limits |
| --- | --- | --- |
| tests.yml generate + test (8 slices) | hermes (8 slices) | All retained tests, canonical runner, deterministic I/8 slicing, two workers. Public lock/interpreter 3.14 vs previous explicit 3.11: interpreter parity remains to verify. |
| tests.yml e2e | Python E2E | The non-upgrade inventory runs from a full-history checkout with the same per-file isolation, explicit messaging/provider extras, tmux assertion and empty API credentials. |
| tests.yml e2e-upgrade | Python upgrade E2E (core/git/handoff/hosts/network/pm) | Full-history checkout and one standard hosted runner per inventory-derived shard, each with a 180-minute limit. The public repository has a deliberate sanitized root, so the workflow fetches upstream stable tags and supplies the newest stable tag as the explicit upgrade base instead of pretending it is merged into public history. |
| lint.yml ruff-blocking | python-lint | Same pinned ruff check. |
| lint.yml windows-footguns | python-lint | Same static checker over all public files. |
| lint.yml lint-diff | stays private initially | Advisory ty/ruff diff report not reproduced. Blocking lint remains public. |
| OSV lock scan | Public dependency OSV scan | The checksum-pinned scanner checks the public Python and npm locks. The private repository keeps a path-filtered scan for its distinct private lock graph. |
| js-tests desktop check:lint | client | Typecheck, lint, private-absent import closure compilation. |
| js-tests desktop platforms / UI | client | All vitest projects, required Python seam and locked real Python environment. |
| js-tests desktop upstream-watch | client | Same retained Node test command. |
| js-tests desktop local-brain | stays private | Public package has no proof check; no copying excluded proof inputs. |
| js-tests desktop all native package/install | stays private | Packaging/release inputs excluded; renderer E2E is not installed-app verification. |
| js-tests shared, atum-kit, browser-client, device-protocol, model-client, ui-tui, hermes-ink, web | workspaces matrix | Each public package's complete check command. |
| js-tests controller/sandbox/private web/bootstrap/tests-js | stays private | Excluded source/seams. |
| e2e-desktop Linux | desktop-e2e | Full public suite, same pinned Playwright image, Electron/Xvfb, real Python. Screenshot update mode proves harness; trusted baseline comparison/evidence publishing remains uncovered. No artifact uploads. |
| ci aggregate/classifier, release/signing/provenance, private integration | stays private | Coordinator adjusts only after exact-head public proof. |
| mobile resources | mobile resources/client | Selected public importer/push checks; full resource suite depends on excluded inputs. |
| mobile swift package | mobile swift | Full public package tests on standard macos-26. |
| mobile ios-app, SDK custody/Apple/phone | stays private | Xcode 27 project and private SDK evidence not reproduced. |

## Outbound guard and bootstrap

Run `bash scripts/pre-push-public <reviewed-public-base-sha> <candidate-head-sha>`
from the candidate repo, using a trusted reviewed helper/policy, before any push.
Install gitleaks 8.30.1; CI also validates the release archive checksum. Full public
history is mandatory. Check every ref being pushed; never implicitly push tags.

The policy is a deny list, derived from the approved export boundary and its
exclusion rules. New ordinary files (including desktop components and tests) need
no policy edit. It blocks private controller/sandbox and web/bootstrap seams,
operations/internal docs/evidence, restricted productivity skills, release/signing/
publish automation, credential/generated directories and `.env*`. Symlinks and
submodules are denied; new or changed blobs have a 10 MiB size limit (including
binaries). Unchanged approved baseline blobs are grandfathered; every new commit is checked,
including intermediate files later deleted. Full-history/root checks remain.

Pinned gitleaks scans every newly reachable commit plus commit metadata with the
default rules and no candidate ignore/config/inline allowances. Secrets cannot be
adjudicated. Identifier checks cover personal paths, non-role email addresses,
tailnet/internal hosts and AWS/Supabase identifiers. Exact reviewed blob SHA256
entries adjudicate identifiers only; the tiny list records checker/test regexes
and any pinned workflow bytes that need review. Trusted policy bytes are likewise
exempt from identifier review only, never from secret scanning.

The public PR guard runs the base commit's script/policy on the exact candidate
head. When the base has no checker, the installation PR runs the candidate checker
in explicitly labelled REPORT ONLY mode; findings do not fail installation and
require coordinator manual review. Local bootstrap preflight still enforces the
candidate checker. Once installed, both CI and `pre-push-public` execute the base's
checker/policy: candidate policy edits cannot loosen their own checks. Repository
rules must protect the workflow itself; settings remain coordinator-owned.

Generic public identifier classes supplement the private exact customer/owner marker,
fingerprint and rights scans. Private marker values/manifests are not published.
Coordinator must still run private stage-1 scans and review public author identities
before each push. This public guard cannot certify every private identifier/rights
issue. Helpers do not install hooks, modify refs or push.

## Local evidence and next gates

- Round 2: 20 contract tests cover ordinary new components
  and tests, role addresses, private paths (including an intermediate deleted file),
  symlinks, submodules, size limits, personal/internal/tailnet identifiers, a fake
  AWS key, secrets despite identifier adjudication, commit metadata, unrelated roots,
  trusted-base policy/checker enforcement, and report-only installation bootstrap.
  Temporary repositories are removed.
- Canonical Python sample: 67 passed, zero failed, one platform skip in
  tests/agent/test_prompt_builder.py. Eight-slice generation exercised locally.
- New Python files: pinned ruff; helper shell syntax and YAML parsed locally.
- Mobile full Swift package: 500 tests, zero failures, local macOS 26 / Swift 6.4.
- No npm tree installed under constrained disk budget. Direct boundary command
  reported missing TypeScript dependency; no source-level conclusion from that run.
- Full Python suite, JS/lint and Linux GUI execution remain exact-head coordinator
  gates. Full Python run not attempted under local disk/time constraints.
- Removed the per-file path manifest; each policy now contains only deny rules,
  public ancestry anchors, the size limit and a tiny identifier adjudication map.

Do not retire duplicate private checks based solely on this checkpoint.

Identifier adjudication is limited to two exact checker/test blobs containing
public regex and synthetic test source. Role email addresses are allowed as a
class. Workflow action SHAs are ordinary public identifiers, requiring no special
adjudication. No private owner/customer/infrastructure values were introduced.

Final local outbound preflight: PASS for the complete new commit range in both
repositories (raw objects/modes, paths, ancestry, identifiers, pinned gitleaks and
metadata). Stage-1 gitleaks scan over all newly authored bytes: zero findings.
Round 2 guard contract tests: 20 passed in each repository. No remote actions.
Generated Swift build output and checkout-local test/bytecode caches were removed;
no npm tree was installed. Peak combined checkout footprint was below one GiB.

Round 2 local checkpoint (2026-11-10): replaced exact-path approval with deny-only
policy, retained all CI parity lanes, added base-trusted local preflight and
report-only CI installation bootstrap. Full new-commit outbound preflight and
focused guard tests pass on both amended heads. Built locally; no push, PR,
settings changes, CI execution or spending. Coordinator owns publication/review.

## Public lane repair (2026-11-10)

Local implementation only; publication and exact-head hosted validation remain with
coordination. This checkpoint repairs public-only inputs for the public CI
cutover; all four lanes stay public. No push, PR, settings, dispatch, deployment, upload or spending occurred.

- `python-lint`: the 12 footguns were in the new public guard and its tests,
  not exported private fixtures. Ten missing encodings and two BOM-intolerant
  reads are fixed with `utf-8-sig` reads and `utf-8` writes. Added a real git/scanner
  contract test for a BOM-prefixed policy; no checker suppression.
- `device-protocol`: no files were missing. Export sanitization changed UUIDs,
  Matrix identities, public keys and a lease token while leaving signatures and
  hashes from their previous bytes. Rebuild the public vectors with
  `npx tsx test/rebuild-public-vectors.mts` from the package directory. The script
  uses only public inputs and fresh Ed25519/P-256 keys held in memory; it exports
  no private keys. Original declared decisions and negative signature verdicts
  remain in force. Dependent command/approval/lease hashes and the existing pack
  digest are rebound. `vendored.json` explicitly marks this pack as a public
  derivative, not an identical upstream crypto corpus.
- `web`: the only failing test was the insecure-origin UUID fallback assertion.
  Export rewrote its deterministic expected UUID. Restored the UUID produced by
  the stub's `0xab` bytes, including version/variant bits. The “disk full” message
  is an intentional failed-upload test, and ChatSidebar socket tests passed.
- `desktop-e2e`: failure occurred in pip before npm, Python sync, Xvfb or tests.
  The setup-python interpreter could not import SSL inside the pinned Noble
  image. Install Noble's `libssl3t64` before setup-python/pip. The image and
  Playwright both use 1.58.2; no evidence supported changing either or dropping
  the public lane.

Local evidence: Node 22 and 24 each pass the complete device-protocol check
(764 tests) and web check (449 tests, typecheck and lint; 28 existing lint warnings).
Python 3.14 via uv passes pinned ruff 0.15.10, the complete Windows-footguns scan
and 21 real git/gitleaks guard tests. Desktop `build:e2e` passes on macOS/Node 24;
Playwright collection is checked separately. Linux container/Xvfb execution is
not reproduced locally: Docker reports it cannot connect to its daemon. The
host Python 3.14 imports SSL successfully; that is not proof of the container fix.
The coordinator must validate the repaired Linux lane on the exact public head.

Temporary npm/build outputs are removed before handoff. No private fixture,
private key or excluded source was restored. Changed public bytes receive the
stage-1 identifier/fingerprint rules and pinned secret scan, followed by the
full outbound preflight against the fetched public main revision.

Outbound scan result: the stage-1 rules find no new private identifier or restricted
fingerprint. The sole new UUID is the deterministic `0xab` fallback expectation.
Pinned gitleaks reports 106 generic-api-key candidates: 45 fresh public P-256 SPKI
literals (`identityKey`/`approvalKey`) and 61 occurrences of the recomputed
`leaseTokenHash`. These are public verification material and a digest, not private
keys or access tokens. The outbound guard does not permit secret-scan adjudication;
no exclusion or policy weakening was added. The required full-history preflight reports all 106 candidates after its
path/ancestry/identifier checks pass; publication remains blocked. Coordinator must resolve
that guard limitation before publication, independently of the green local lanes.
Desktop collection: 62 tests in 32 files. Temporary dependency/build footprint
stayed below 2.5 GiB; Linux GUI execution remains unverified locally.

Preflight correction: preserve the original exact reviewed checker/test blob pins.
The range includes their installation commit, so replacing those pins would reject
that historical commit before secret scanning. Encoding/BOM edits introduce no new
identifier literals; their incremental identifier comparison needs no new exemption.

Secret-scan findings are accepted only inside files whose exact bytes the coordinator reviewed and recorded in `reviewed_secret_blobs` of the base-branch policy (2026-11-10: 81 device-protocol fixture files; 106 findings = 61 one-way `leaseTokenHash` digests + 45 public P-256 SPKI keys; no private keys). Any finding elsewhere, or in changed bytes, fails.

## Follow-up lane repairs (2026-11-10)

Local commits on the existing parity branch only; no publication or hosted runs.

- Client crypto: the public-vector rebuilder repaired the vector table but omitted
  standalone Hello/Execute signatures. Copy their already valid, identical-body,
  identical-key vector signatures into the standalone frames and rehash the pack.
  The rebuilder now signs those standalone frames too. No keys are regenerated in
  this checkpoint; cross-algorithm rejection assertions remain unchanged.
- Client launcher: the failing case previously carried a reaped PID through async
  launcher setup. The fixture now publishes a live fake app and reaps it while
  its opener stays alive, exercising the actual started-to-dead transition. Fake
  started markers use atomic rename, matching production store.ts. The rollback
  call and less-than-six-second assertion remain. The original hosted timeout's
  exact cause is not established locally; PID reuse/setup delay is a suspected
  fixture risk. Matrix network logs belong to unrelated tests and explain neither
  the waiter's assertion nor its timeout. Exact-head Linux confirmation is required.
- Hermes slice 3: the sole failing file was
  tests/scripts/desktop_update/test_desktop_update_posix_handoff_protocol.py.
  Sanitized leading-zero cases compared different decimal timestamps; repaired
  only the inconsistent inputs. The real shell implementation is unchanged.
  Make the canonical 300-second per-file budget explicit in the sliced workflow;
  main's former 120-second cap is too short for the real hatch pipeline benchmark.
  All benchmark assertions and all eight slices remain enabled.
- Python lint: the coordinator's scanner-report JSON read needed utf-8-sig, like
  the guard's other BOM-tolerant reads. No suppression or policy edit.
- Desktop E2E: the log still fails at pip with Python SSL unavailable, despite
  successfully installing libssl3t64. Tests, Xvfb and Playwright never start.
  Bootstrap pinned uv in a venv from Noble's own Python and let uv select managed
  portable Python 3.14; avoid the host toolcache Python/OpenSSL ABI dependency.
  Docker's daemon is unavailable locally, so the Linux GUI lane is not certified.
  This is a bootstrap repair, with no evidence that hosted GUI coverage must be
  moved private. All four lanes remain public.

Local verification results are recorded below before handoff. The coordinator
owns exact-head Linux proof and any new secret finding in changed fixture bytes;
reviewed_secret_blobs is unchanged.

Follow-up local evidence (Node 24, macOS arm64): device-protocol complete check
passes (13 files, 764 tests); desktop crypto/launcher focused check passes (25
tests), and the final launcher fixture passes all nine tests under both /bin/sh
and /bin/dash. Desktop complete typecheck and lint exit zero (4,690 existing
lint warnings). Pinned ruff and the full Windows-footguns check pass. Guard
contracts: 21 tests plus 13 subtests pass. All ten timestamp environment cases
pass against the real marker.sh; the complete Linux process suite skips on
macOS. Workflow YAML parses. Full client, all Hermes slices, and Linux GUI were
not run locally. No private fixture bytes or policy adjudications were changed.

Final follow-up evidence: the real hatch benchmark (all four tests) plus the
three timeout-scaling tests pass: 7 passed in 104.83 seconds. The small local
Python tool environment initially lacked cryptography; installing the dependency
resolved those import failures without source changes. This was a local focused
run, not a complete locked CI environment or a hosted run.

Outbound guard against fetched origin/main
0a9b1b140569584b8d912e48c04ee2c5a40b0a8a passes for the repair commit range:
raw objects, paths, ancestry, identifiers, pinned gitleaks and commit metadata.
Gitleaks emits 116 existing/reviewed candidates; the guard accepts them under the
existing exact-byte policy. No new unreviewed fixture finding and no policy
change. Temporary npm dependencies and task-generated test files are removed
before handoff. Publication and exact-head hosted validation remain coordinator
work; this checkpoint makes no claim that release 0.20.46 is live.
