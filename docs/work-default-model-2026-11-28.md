# Work and Code session model defaults

The owner asked Work and Code to choose the best connected subscription by default, using the Agents picker. Desktop #148 implements that ranking in `apps/desktop/shared/first-run-pick.ts`. It picks the newest stable model in the first eligible family: Claude Sonnet, ChatGPT Sol, paid Antigravity Gemini Flash, then OpenCode Go DeepSeek Flash.

Previously, Desktop's Work supervisor seeded T3's environment default with the managed Atum model on each launch. Work 0.1.20 exposed that provider's catalog in T3's native picker. The owner could select a different model for a thread.

The paired Work host now reads T3's native provider updates, runs the shared picker against the locally usable plans, and applies the result through T3's existing environment default setting. Atum remains the automatic fallback and stays available in the picker. Project overrides, session choices, and the separate Atum text-generation setting keep their existing precedence. A cloud-only OpenCode Go key stays in cloud custody. Work can select Go when its native OpenCode instance reports Go models.

The companion Work client change refreshes inherited seeds on open, unsent drafts when the environment default changes. This covers startup with a pending provider probe while preserving explicitly selected models and promoted threads. Ship both source changes with the next Work archive and Desktop build.

Focused tests exercise native plan ranking, late discovery, sign-out fallback, and explicit selections. A local smoke test against the installed 0.1.20 executable verified that the owner RPC accepts the patch, persists it, and streams updated settings. The smoke used an isolated data directory and made no model calls.
