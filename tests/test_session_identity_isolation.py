"""One test's session identity must not become the next test's.

Concurrent hosts bind the session per asyncio task in ContextVars, but tests
call ``set_session_vars()`` / ``clear_session_vars()`` /
``set_current_session_key()`` in the main thread's context, where the result
outlives the test. ``_isolate_session_identity`` in ``tests/conftest.py``
restores that state after every test; these tests pin the behaviour down.
"""

import gateway.session_context as sc
import tools.approval as approval
from tools import approval_context
from gateway.session_context import clear_session_vars, get_session_env, set_session_vars
from tests.conftest import _restore_session_state, _snapshot_session_state


class TestSessionIdentityDoesNotLeakAcrossTests:
    """Replays the ``test_async_delegation.py`` -> ``test_command_guards.py`` cascade.

    The two tests run in definition order: the first leaves the main context
    the way ``test_delegate_task_background_uses_live_tui_agent_session_id``
    did, the second is what ``test_command_guards.py`` then observed.
    """

    def test_1_bind_then_clear_session_vars(self):
        tokens = set_session_vars(source="tui", session_key="pre-compress-parent")
        clear_session_vars(tokens)

        # clear_session_vars sets "" on purpose, so no fallback to the default.
        assert approval.get_current_session_key() == ""
        assert sc._session_context_engaged is True

    def test_2_next_test_resolves_the_default_session(self):
        assert approval.get_current_session_key() == "default"
        assert get_session_env("HERMES_SESSION_KEY", "default") == "default"


class TestSessionStateRestore:
    def test_restore_undoes_cleared_vars_latch_and_approval_key(self):
        session_key_before = sc._SESSION_KEY.get()
        engaged_before = sc._session_context_engaged
        resolved_before = approval.get_current_session_key()
        snapshot = _snapshot_session_state()

        tokens = set_session_vars(source="tui", session_key="leaky")
        clear_session_vars(tokens)
        approval_context.set_current_session_key("leaky-approval")  # never reset
        assert approval.get_current_session_key() == "leaky-approval"

        _restore_session_state(snapshot)

        assert sc._SESSION_KEY.get() is session_key_before
        assert sc._session_context_engaged is engaged_before
        assert approval.get_current_session_key() == resolved_before

    def test_module_missing_from_snapshot_returns_to_import_time_state(self):
        """A module first imported mid-test is reset to its declared defaults."""
        snapshot = {
            key: value
            for key, value in _snapshot_session_state().items()
            if key[0] != "gateway.session_context"
        }
        set_session_vars(source="tui", session_key="imported-mid-test")

        _restore_session_state(snapshot)

        assert sc._SESSION_KEY.get() is sc._UNSET
        assert sc._SESSION_SOURCE.get() is sc._UNSET
        assert sc._session_context_engaged is False
