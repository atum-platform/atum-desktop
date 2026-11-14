# Native managed awareness admission

`bind_cloud_memory` accepts a trusted `admit_managed_google` callback for v2
managed runs. The host must return exactly `True` only after verifying the
current runtime generation, durable account Google latch, and certified
protected inference and publication route. Model arguments and ordinary config
cannot set this callback. Missing, false, exceptional or revoked admission
refuses marked results. Legacy managed consumers remain refused.

After marked recall, admission is sticky and checked by run-authority checks
before subsequent turns and publication. The native provenance ledger stores
the original Google marker alongside evidence IDs and lineage before returning
content. Factory reconstruction checks that ledger, including parent sessions,
so restart and compression cannot remove the requirement. Loss of admission
retires the run through the existing lifecycle callback. Local destinations keep
their existing local-only latch behavior. Prompt text and tool schema stay fixed.

Validation: canonical `scripts/run_tests.sh` on the awareness and v2 provider
suites, plus Ruff on touched Python files. This library port requires a trusted
host implementation; it does not authorize a route or activate a deployment.
