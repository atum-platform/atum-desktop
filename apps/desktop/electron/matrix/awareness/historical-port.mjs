// Native-only read port for the already-owned Mac supervisor. Unix socket
// custody replaces a bearer secret: private directory + socket, same OS user.
// current() MUST return the host's reconciled managed authority, not a UI view.
import { isDeepStrictEqual } from 'node:util';
import { createServer } from 'node:http';
import { chmod, lstat, unlink } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';

export async function startHistoricalPort({ socketPath, brain, owner, binding, current }) {
  const frozen = structuredClone({ owner, binding });
  if (!isAbsolute(socketPath) || binding?.owner?.kind !== 'personal' || binding?.control?.state !== 'on') {
    throw new Error('historical_binding_invalid');
  }
  const parent = await lstat(dirname(socketPath));
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid() || (parent.mode & 0o077)) {
    throw new Error('historical_directory_not_private');
  }
  const same = isDeepStrictEqual;
  const admitted = () => {
    try { return same(current(), frozen) && brain.ready(frozen.owner); } catch { return false; }
  };
  const server = createServer(async (req, res) => {
    const fail = () => { if (!res.writableEnded) { res.writeHead(403); res.end(); } };
    if (req.method !== 'POST' || req.url !== '/retrieve' || !admitted()) { fail(); return; }
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 16384) { fail(); return; }
        chunks.push(chunk);
      }
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (request.agentPrincipal !== frozen.binding.agentPrincipal ||
          !same(request.audience, { class: frozen.binding.audience.class }) || !admitted()) { fail(); return; }
      // Existing provider validates the complete v1 request and applies current
      // suppression/fence policy. No write method is exposed by this server.
      const response = await brain.call(frozen.owner, 'brain.retrieve', request);
      if (!admitted()) { fail(); return; }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ binding: frozen.binding, response }));
    } catch { fail(); }
  });
  server.requestTimeout = 2000;
  server.headersTimeout = 2000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve); // EADDRINUSE is a refusal, never takeover.
  });
  await chmod(socketPath, 0o600);
  return { socketPath, async close() {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await unlink(socketPath).catch(() => {});
  } };
}
