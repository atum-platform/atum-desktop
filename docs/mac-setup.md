# Mac setup and cloud assistants

A cloud assistant appears in the authenticated roster and can answer without
creating a local executor on this Mac. Local setup and device enrollment grant
no authority to execute as that assistant.

Mac access setup requests shell keys only. Compatibility responses can contain
other key purposes; these are ignored rather than installed. Invalid shell keys
still fail validation. The status says **Set up** after configuration; this does
not assert that an authorized remote connection has succeeded.

An authentication rejection refreshes device registration once. Reconnection
requires changed registration facts or **Repair this Mac**. Ordinary network
loss retains its reconnect backoff. Repairing Mac access does not restart cloud
chat.

Work stays in navigation while its optional local model proxy is unavailable.
Starting the runtime still requires its account and model checks. Builds without
the staged Work runtime do not display Work.

Behavior checks cover cloud-root readiness, enrollment bypass, mixed key rows,
bounded authentication recovery, the repair action, setup status, and Work
visibility when the local model proxy is down.
