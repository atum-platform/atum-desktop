# First-run greeting language

The browser sign-in callback supplies the language preference used for initial
provisioning. The desktop sends a supported language through the existing
owner-language headers and retries on the roster read until the server
acknowledges the stored value. The acknowledged version belongs to the
signed-in account. Until one is available, the greeting uses the UI language.
The greeting protocol still supports English and Vietnamese.

The Electron tests exercise the callback, provisioning request and roster
acknowledgement. The welcome tests cover a Vietnamese greeting in an English UI
and the UI-language fallback when the account preference is absent.
The desktop typecheck, lint on touched files and outbound public guard cover
the source and release boundary.
