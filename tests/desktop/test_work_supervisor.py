"""Work's packaged Python supervisor migrates exact retired provider IDs."""
import importlib.util
from pathlib import Path


def test_work_provider_merge_drops_only_retired_ids():
    source = Path(__file__).resolve().parents[2] / "apps/desktop/electron/work/sidecar/supervisor.py"
    spec = importlib.util.spec_from_file_location("work_supervisor", source)
    supervisor = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(supervisor)

    defaults = {driver: {"driver": driver, "enabled": True}
                for driver in ("codex", "claudeAgent", "antigravity", "opencode")}
    disabled = {"driver": "opencode", "enabled": False}
    custom = {"driver": "acpRegistry", "config": {"commandArgs": ["-m", "other"]}}
    managed = {"driver": "acpRegistry", "displayName": "Atum"}
    saved = {
        "atum-managed-delegated": {"showInPicker": True},
        "atum-relay-codex": {"showInPicker": True},
        "atum-relay-codex-custom": custom,
        "atum-managed": {"enabled": False},
        "opencode": disabled,
    }
    result = supervisor.work_provider_instances(saved, defaults, {"atum-managed": managed})

    assert result == {**defaults, "opencode": disabled, "atum-relay-codex-custom": custom, "atum-managed": managed}
    assert "atum-relay-codex" in saved
