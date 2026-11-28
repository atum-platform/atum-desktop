# Atum Free cloud pilot

The cloud picker reads pilot eligibility and the Free model list from its
usual account subscription status. On first use, Desktop opens OpenRouter
with a one-cent limit prefilled and exchanges the loopback PKCE code in the
main process. The credential goes to the account connection service from main.
Connections displays disconnect and the provider's key management link.

The picker preserves an existing choice if consent is canceled or fails.
Reconnecting a saved Free choice keeps the selected model.
The picker explains the account-level Google restriction. Google connect
offers warn when any assistant has a saved Atum Free choice. For acceptance,
use the designated test account with no Google connection. After the pilot
operator allowlists that account, use one eligible cloud agent to complete consent, check the
one-cent key limit, running a tool turn with the Mac off, and checking both
OpenRouter Activity and Atum's managed usage. The OAuth callback advertises
`localhost` and the listener binds to loopback. Confirm the live OAuth
redirect and OpenRouter's daily-limit response during acceptance.

Focused tests cover the exchange, status parser, destination choice, and
the eligible and ineligible picker paths. The pilot uses loopback directly.
The connect and disconnect controls use the picker and Connections handler patterns.
Saved Free choices use the cloud connection status for availability.
Loopback uses the same Promise API as the existing desktop authorization flow.
The native main IPC handler imports the loopback exchange with its other account routes.
