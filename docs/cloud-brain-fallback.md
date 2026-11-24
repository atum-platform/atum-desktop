# Cloud Brain migration and local fallback

Keep local ingestion available until managed cloud coverage is complete. After
cutover, the account's cloud-readonly marker refuses ingestion, correction and
coverage writes. Retrieval and privacy withdrawal/fencing remain available.

The awareness transport treats a known readonly refusal as a plain refusal.
It preserves the native provider for privacy operations rather than retiring or
stopping it. Unknown outcomes still retire the exact provider as before.

Verification: local transport and native supervisor suites pass, 41 tests.
The transport regression test refuses ingestion and then successfully withdraws
through the same provider without stopping it. This source change is built, not
installed or activated. Release consumers must advance their verified public
source pin after normal assembly and release checks.
