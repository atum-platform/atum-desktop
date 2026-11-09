# Private-advisory SQL consumer fixture

`captured.json` is a byte-for-byte retained copy of platform's authoritative
`spec/private-advisory/v1/sql-0096-capture.json`. Platform CI captures raw SQL
from a copied pgTAP transaction, rolls it back, verifies the migration and test
digests, and passes the generated projections through the committed protocol
parser. The desktop consumer test then feeds the same bytes to the actual
`AtumMessagingHttpClient` preflight and owner-context methods.

Refresh the platform capture and its desktop copy only against the disposable
local database, after reviewing the new raw projection:

```bash
ATUM_PLATFORM_ROOT=/path/to/atum-platform \
  node apps/desktop/scripts/capture-private-advisory-sql-fixture.mjs --write
```

Without `--write`, the command runs the platform freshness/protocol check and
fails if the retained desktop copy differs from the platform fixture. Desktop
CI needs no cross-repository checkout: its transport test consumes the retained
raw bytes directly.
