"""Child environments must outlive pytest's per-test ambient-env restoration."""
from concurrent.futures import ThreadPoolExecutor
import os
import threading

from pm.environments import activation_environment
from tests.e2e.core.chaos._helpers import chaos_base_env, hermetic_env


def test_explicit_activation_base_avoids_live_environment(tmp_path, monkeypatch):
    """Explicit activation must survive the owner deleting live environment keys."""
    inherited = os.environ.copy()
    inherited["THREAD_ENV_CANARY"] = "owner"
    ready = threading.Event()
    mutated = threading.Event()
    original_keys = os._Environ.keys
    original_items = os._Environ.items

    def no_worker_read(method):
        def checked(env):
            assert threading.current_thread() is threading.main_thread(), "worker read live environ"
            return method(env)
        return checked

    monkeypatch.setattr(os._Environ, "keys", no_worker_read(original_keys))
    monkeypatch.setattr(os._Environ, "items", no_worker_read(original_items))

    def activate():
        ready.set()
        assert mutated.wait(5)
        return activation_environment(tmp_path, base_env=inherited)

    with ThreadPoolExecutor(1) as pool:
        future = pool.submit(activate)
        assert ready.wait(5)
        monkeypatch.delenv("HERMES_HONCHO_HOST", raising=False)
        monkeypatch.setenv("THREAD_ENV_CANARY", "later-test")
        mutated.set()
        result = future.result(timeout=5)
    assert result["THREAD_ENV_CANARY"] == "owner"
    assert inherited["THREAD_ENV_CANARY"] == "owner"


def test_chaos_workers_use_owner_snapshot(tmp_path, monkeypatch):
    monkeypatch.setenv("THREAD_ENV_CANARY", "owner")
    monkeypatch.setenv("OPENAI_API_KEY", "must-not-inherit")
    base = chaos_base_env()
    monkeypatch.setenv("THREAD_ENV_CANARY", "later-test")

    def child(i):
        env = hermetic_env(tmp_path / str(i), tmp_path / str(i) / ".hermes", str(i), base_env=base)
        assert env["THREAD_ENV_CANARY"] == "owner"
        assert env["OPENAI_API_KEY"] == "sk-fake-chaos"
        assert env["CHAOS_TAG"] == str(i)
        env["THREAD_ENV_CANARY"] = "child"

    with ThreadPoolExecutor(6) as pool:
        list(pool.map(child, range(60)))
    assert base["THREAD_ENV_CANARY"] == "owner"
    assert "OPENAI_API_KEY" not in base
