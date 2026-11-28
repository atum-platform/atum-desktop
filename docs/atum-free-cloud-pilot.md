# Atum Free cloud pilot

The cloud picker reads pilot eligibility and the Free model list from its
usual account subscription status. On first use, Desktop opens OpenRouter
with a one-cent limit prefilled and exchanges the loopback PKCE code in the
main process. The credential goes to the account connection service from main.
Connections displays disconnect and the provider's key management link.

The picker preserves an existing choice if consent is canceled or fails.
Reconnecting a saved Free choice keeps the selected model.
Ineligible agents show a reason in the Free list. The owner can accept the
pilot on one eligible cloud agent by completing consent, checking the
one-cent key limit, running a tool turn with the Mac off, and checking both
OpenRouter Activity and Atum's managed usage.

Focused tests cover the exchange, status parser, destination choice, and
the eligible and ineligible picker paths. The pilot uses loopback directly.
The connect and disconnect controls use the picker and Connections handler patterns.
