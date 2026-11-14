# Automatic ChatGPT custody transfer

The desktop main process asks the authenticated carry endpoint for status before
opening its account auth home. A pending transfer uses `hermes_cli.chatgpt_carry`
through private subprocess pipes, with the account home explicitly supplied.
Never log that helper's stdout: begin returns credentials for the private import.

The native auth transaction moves the singleton and pool into a paused escrow
in the existing 0600 auth store, removing them from active provider resolution.
Native refresh takes that same account lock. An in-flight refresh finishes first;
a later cached refresh is refused. Stale pool saves retain the escrow/tombstone
and cannot resurrect the pair. The desktop drains assistant and relay consumers
before submitting the pair to the cloud.

A successful import replaces escrow with a credential-free `carried` tombstone,
then drains cached consumers again. The local relay is marked carried and cannot
be enabled by a later status refresh. Explicit validation rejection or an import
returning busy/no-relay/not-imported restores the Mac pair under lock and resumes
its assistants and previously selected local relay. A timeout or lost
response retains paused escrow; later readiness checks reconcile the cloud marker
and either retry the import or finalize carried state. Never restore ownership
merely because an HTTP response was lost. Account changes leave the original
home recoverable without delivering its credentials to the new account.

Multiple independent refresh chains are refused rather than selecting a random
subscription. Paused credentials are retained for recovery until cloud success;
carried stores contain neither access nor refresh tokens for this provider.

Offline verification covers custody recovery, stale-save suppression, in-flight
rotation serialization and refresh refusal, plus desktop state transitions.
These tests do not certify the cloud model-serving or Google-ingestion path.

Carried relay admission is checked before interpreting any device identifier;
tests use a non-identifier sentinel for that refusal path.
