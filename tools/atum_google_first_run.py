"""Compatibility marker for the isolated first-learning routine.

New runtimes set ``atum_first_learning``; rollback images may still set
``atum_first_run_google``. The session receives comprehensive read-only sources and memory through
``atum_first_learning`` (tui_gateway/server.py). Google reads still use the same task-bound broker
as the full-power skill (tools/atum_google_tool.py); no Google credential enters the sandbox.
"""


def enabled():
    from hermes_cli.config import load_config
    config = load_config()
    return config.get("atum_first_learning") is True or config.get("atum_first_run_google") is True
