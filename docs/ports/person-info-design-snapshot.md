# Person and group info design snapshot

The reviewed mobile snapshot now includes the 16 person-info copy entries and
four block/unblock entries consumed by the side-panel client, in all five
locales. Member count includes exact zero/one branches and a numeric argument;
started takes a string argument. Copy wording comes from the design producer.

Only the catalog, copy contract, source inventory and their manifest hashes
change. Existing snapshot members and all other resource bytes are preserved;
previously excluded resources remain excluded. README and archive attributes
are unchanged. No producer implementation is included in this repository.

Validation: inspected every changed resource diff; checked that the 22 added
catalog entries match generated producer output, existing entries are unchanged,
and the manifest retains exactly its prior resource membership with valid hashes.
The mobile importer consumes this snapshot through an immutable commit pin.
Publication and the real mobile pin update are separate coordinator steps.
