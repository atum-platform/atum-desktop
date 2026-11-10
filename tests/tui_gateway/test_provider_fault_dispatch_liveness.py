"""Real stdio dispatcher during provider faults, without Linux-only orphan scanning."""
import uuid

import pytest

from tests.e2e.core.chaos._helpers import chaos_base_env, hermetic_env, write_chaos_home
from tests.e2e.core.chaos._tui_rpc import Heartbeat, TuiGatewayProcess, env_for_gateway, gateway_cwd
from tests.e2e.core.chaos.test_tui_gateway_turn_liveness import _answered_turn, responder
from tests.fakes.fake_llm_provider import FakeLLMServer


@pytest.mark.platforms("posix")
@pytest.mark.parametrize("fault", ["err500", "drop"])
def test_provider_fault_does_not_block_dispatcher(tmp_path, fault):
    # Compose the base env on the test thread before any worker starts (see chaos_base_env).
    base_env = chaos_base_env()
    with FakeLLMServer(responder) as provider:
        home, hermes_home = write_chaos_home(tmp_path, provider.base_url)
        work = gateway_cwd(tmp_path)
        env = env_for_gateway(hermetic_env(home, hermes_home, uuid.uuid4().hex, base_env=base_env), work)
        assert env["HERMES_DISABLE_LAZY_INSTALLS"] == "1"
        gateway = TuiGatewayProcess(env, work, tmp_path / "gateway.log")
        try:
            assert gateway.wait_event(lambda e: e.get("type") == "gateway.ready", timeout=60)
            sid = gateway.call("session.create", {})["session_id"]
            _answered_turn(gateway, sid, uuid.uuid4().hex[:10], "warm-up", 120)
            gateway.dump_threads()
            assert gateway.call("ping")["pong"] is True
            assert "tui_gateway/entry.py" in gateway.tail(30_000)
            start = gateway.event_count()
            with Heartbeat(gateway, [("ping", {}), ("session.status", {"session_id": sid})]) as heartbeat:
                gateway.call("prompt.submit", {
                    "session_id": sid, "text": f"work [[chaos:{fault}:{uuid.uuid4().hex[:10]}]]"})
                assert gateway.wait_event(lambda e: e.get("type") == "message.complete"
                                          and e.get("session_id") == sid, timeout=90, start=start)
            assert not heartbeat.failures, heartbeat.failures
            print(fault, list(zip(heartbeat.answered_methods, heartbeat.latencies)))
            assert heartbeat.answered_methods
            assert max(heartbeat.latencies) < 3, gateway.tail(30_000)
        finally:
            gateway.close_stdin_and_wait(30)
            gateway.kill()
