from unittest.mock import AsyncMock, MagicMock, patch

from gateway.config import Platform
from gateway.platforms.event import MessageEvent
from gateway.session import SessionSource


def make_event(text="/btw", platform=Platform.TELEGRAM):
    return MessageEvent(text=text, source=SessionSource(
        platform=platform, user_id="12345", chat_id="67890", user_name="testuser"))


def make_runner():
    from gateway.run import GatewayRunner
    runner = object.__new__(GatewayRunner)
    runner.adapters = {}
    runner._voice_mode = {}
    runner._session_db = None
    runner._reasoning_config = None
    runner._provider_routing = {}
    runner._fallback_model = None
    runner._running_agents = {}
    runner._background_tasks = set()
    runner.session_store = MagicMock()
    runner.session_store.get_model_override.return_value = None
    from gateway.hooks import HookRegistry
    runner.hooks = HookRegistry()
    return runner


async def run_successful_task():
    runner = make_runner()
    adapter = AsyncMock()
    adapter.extract_media = MagicMock(return_value=([], "done"))
    adapter.extract_images = MagicMock(return_value=([], "done"))
    runner.adapters[Platform.TELEGRAM] = adapter
    agent = MagicMock()
    agent.run_conversation.return_value = {"final_response": "done", "messages": []}
    with patch("gateway.run._resolve_runtime_agent_kwargs", return_value={"api_key": "k"}), \
         patch("gateway.run._load_gateway_config", return_value={}), \
         patch("run_agent.AIAgent", return_value=agent):
        await runner._run_background_task("work", make_event().source, "bg-test")
    adapter.send.assert_called_once()
