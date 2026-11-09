# S6 `atum.cloud-data/1` app-history fixtures

The Moon fixture is the canonical app-history sync example from
`atum-platform@0b7fcd8beea18feba25ab00310e4bcb7d94b1668` under
`spec/cloud-data/v1/fixtures/`; that contract pack is pinned as
`a60db7e4645fd795d1b97e3f8deb580ecb4bdb42dd38b054e9182f72accfec67`.
The invalidation fixture is the pack's same-app-thread `memory_fact` control
record. S6 accepts that content-free invalidation/tombstone shape so a mixed
sync envelope cannot wedge, but still rejects `memory_fact` upserts or content;
retrieval remains S7-owned. Synthetic Orbit fixtures exercise artifact and app
event records without Moon-specific logic. The forged fixture adds
client-authored authority/origin fields that the strict main-process parser must
reject.

These fixtures create no endpoint, storage behavior, provider mutation, or
production claim. S7 remains the contract owner; incompatible v1 bytes require
an additive contract version.
