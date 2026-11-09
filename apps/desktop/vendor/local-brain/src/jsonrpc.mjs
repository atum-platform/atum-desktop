// Newline-delimited JSON-RPC 2.0 over a pair of streams. The same peer speaks MCP to the
// GBrain child (as a client) and serves the local brain's API on the service's own
// stdin/stdout (as a server). One message per line; nothing else is ever written to the
// output stream, so logs go to stderr.

export class JsonRpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

export const ERRORS = Object.freeze({
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  unavailable: -32001,
  timeout: -32002,
  closed: -32003,
});

export class JsonRpcPeer {
  #output;
  #pending = new Map();
  #nextId = 1;
  #buffer = '';
  #closed = false;
  #onRequest;
  #onNotification;
  #maxLineBytes;
  #closedWaiters = [];

  constructor({ input, output, onRequest, onNotification, maxLineBytes = 64 * 1024 * 1024 }) {
    this.#output = output;
    this.#onRequest = onRequest;
    this.#onNotification = onNotification;
    this.#maxLineBytes = maxLineBytes;
    input.setEncoding?.('utf8');
    input.on('data', (chunk) => this.#receive(chunk));
    input.on('end', () => this.close(new JsonRpcError(ERRORS.closed, 'the peer closed its stream')));
    input.on('error', (error) => this.close(new JsonRpcError(ERRORS.closed, `stream error: ${error.message}`)));
    output.on?.('error', (error) => this.close(new JsonRpcError(ERRORS.closed, `stream error: ${error.message}`)));
  }

  get closed() {
    return this.#closed;
  }

  whenClosed() {
    if (this.#closed) return Promise.resolve();
    return new Promise((resolve) => this.#closedWaiters.push(resolve));
  }

  #receive(chunk) {
    this.#buffer += chunk;
    let newline;
    while ((newline = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line) this.#dispatch(line);
    }
    if (Buffer.byteLength(this.#buffer) > this.#maxLineBytes) {
      this.#buffer = '';
      this.close(new JsonRpcError(ERRORS.parse, 'a message exceeded the line limit'));
    }
  }

  #dispatch(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.#send({ jsonrpc: '2.0', id: null, error: { code: ERRORS.parse, message: 'parse error' } });
      return;
    }
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      this.#send({ jsonrpc: '2.0', id: null, error: { code: ERRORS.invalidRequest, message: 'invalid request' } });
      return;
    }
    if (typeof message.method === 'string') {
      if (message.id === undefined) {
        try {
          this.#onNotification?.(message.method, message.params);
        } catch {
          /* notifications have no reply */
        }
        return;
      }
      this.#answer(message);
      return;
    }
    const waiter = this.#pending.get(message.id);
    if (!waiter) return;
    this.#pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new JsonRpcError(message.error.code, message.error.message, message.error.data));
    else waiter.resolve(message.result);
  }

  async #answer(message) {
    if (!this.#onRequest) {
      this.#send({ jsonrpc: '2.0', id: message.id, error: { code: ERRORS.methodNotFound, message: 'no methods' } });
      return;
    }
    try {
      const result = await this.#onRequest(message.method, message.params);
      this.#send({ jsonrpc: '2.0', id: message.id, result: result ?? null });
    } catch (error) {
      const code = Number.isInteger(error?.code) ? error.code : ERRORS.internal;
      const payload = { code, message: error instanceof JsonRpcError ? error.message : String(error?.message ?? error) };
      if (error?.data !== undefined) payload.data = error.data;
      this.#send({ jsonrpc: '2.0', id: message.id, error: payload });
    }
  }

  #send(message) {
    if (this.#closed) return;
    this.#output.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params, { timeoutMs = 30_000 } = {}) {
    if (this.#closed) return Promise.reject(new JsonRpcError(ERRORS.closed, 'the peer is closed'));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
          this.#pending.delete(id);
          reject(new JsonRpcError(ERRORS.timeout, `${method} timed out after ${timeoutMs} ms`));
        }, timeoutMs)
        : undefined;
      this.#pending.set(id, { resolve, reject, timer });
      this.#send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params) {
    this.#send({ jsonrpc: '2.0', method, params });
  }

  close(reason = new JsonRpcError(ERRORS.closed, 'closed')) {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(reason);
    }
    this.#pending.clear();
    for (const resolve of this.#closedWaiters) resolve();
    this.#closedWaiters = [];
  }
}
