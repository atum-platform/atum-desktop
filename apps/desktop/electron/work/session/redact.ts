/**
 * The pairing token is a one-time administrative grant. Nothing in this lane
 * logs a URL, an argv or a command's output; this is the belt for anything
 * that might still be forwarded (an error message, a driver note).
 */
const PAIRING_TOKEN = /(token=)[A-Za-z0-9_-]+/giu
const PAIRING_LINE = /pairingUrl:\s*\S+/giu
const LONG_SECRET = /\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{8,}\b/gu

export function redactPairingSecrets(text: string): string {
  return text
    .replace(PAIRING_LINE, 'pairingUrl: [redacted]')
    .replace(PAIRING_TOKEN, '$1[redacted]')
    .replace(LONG_SECRET, '[redacted]')
}

/** An Error that carries a stable code and no free text from a child process. */
export class WorkSessionError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'WorkSessionError'
  }
}
