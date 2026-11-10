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
| tests.yml e2e | python-e2e | Entire retained tests/e2e via isolated runner. |
| lint.yml ruff-blocking | python-lint | Same pinned ruff check. |
| lint.yml windows-footguns | python-lint | Same static checker over all public files. |
| lint.yml lint-diff | stays private initially | Advisory ty/ruff diff report not reproduced. Blocking lint remains public. |
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
