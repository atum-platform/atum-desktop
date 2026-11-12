"""Same-user, leased Matrix batch barrier. No durable pause survives a crash."""
import asyncio
import json
import os
import socket
import struct
from pathlib import Path


class IntakeHold:
    def __init__(self, store, *, timeout=2):
        self.store = store
        self.timeout = float(timeout)
        if not 0 < self.timeout <= 2:
            raise ValueError('snapshot_hold_seconds must be in (0, 2]')
        self.path = str(store.path) + '.hold'
        self.lock = asyncio.Lock()
        self.server = None
        self.clients = set()

    async def start(self):
        path = Path(self.path)
        # The adapter already owns the account lock; a leftover endpoint is stale.
        path.unlink(missing_ok=True)
        self.server = await asyncio.start_unix_server(self._client, path=self.path)
        path.chmod(0o600)

    async def _client(self, reader, writer):
        task = asyncio.current_task()
        self.clients.add(task)
        acquired = False
        try:
            sock = writer.get_extra_info('socket')
            if hasattr(socket, 'SO_PEERCRED'):
                _, uid, _ = struct.unpack('3i', sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            else:
                peer = socket.fromfd(sock.fileno(), socket.AF_UNIX, socket.SOCK_STREAM)
                try:
                    uid, _ = peer.getpeereid()
                finally:
                    peer.close()
            if uid != os.getuid():
                raise PermissionError('snapshot control requires the gateway uid')
            async with asyncio.timeout(self.timeout):
                if await reader.readline() != b'hold\n':
                    return
                await self.lock.acquire()
                acquired = True
                held = self.store.get('pending') is None
                writer.write(json.dumps({'held': held, 'timeout_seconds': self.timeout}).encode() + b'\n')
                await writer.drain()
                if held:
                    await reader.readline()  # release or EOF; lease expiry is unconditional
        except (TimeoutError, ConnectionError):
            pass
        finally:
            if acquired:
                self.lock.release()
            writer.close()
            await writer.wait_closed()
            self.clients.discard(task)

    async def close(self):
        if self.server:
            self.server.close()
            await self.server.wait_closed()
        clients = list(self.clients)
        for task in clients:
            task.cancel()
        await asyncio.gather(*clients, return_exceptions=True)
        Path(self.path).unlink(missing_ok=True)
