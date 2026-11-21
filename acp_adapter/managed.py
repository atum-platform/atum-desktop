"""ACP stdio for applications that provision and own the profile gateway.

This entry point runs from a prepared Python runtime. It skips CLI startup,
dotenv and provider resolution; the gateway owns those operations. An ACP
initialize can therefore run before activation, including with a read-only
profile. Session methods only attach to an already-running gateway.
"""
import asyncio
import logging
import sys

import acp

from acp_adapter.gateway_server import GatewayACPAgent
from agent.redact import RedactingFormatter


def main() -> None:
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(RedactingFormatter("%(levelname)s %(name)s: %(message)s"))
    logging.getLogger().addHandler(handler)

    async def serve():
        agent = GatewayACPAgent(managed=True)
        try:
            await acp.run_agent(agent, use_unstable_protocol=True)
        finally:
            await agent.aclose()

    asyncio.run(serve())


if __name__ == "__main__":
    main()
