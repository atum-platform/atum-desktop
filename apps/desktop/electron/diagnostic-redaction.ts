// Shared with SSH/local logs. Automatic reports never include arbitrary text:
// regex redaction cannot recognize user content. These patterns are secondary
// protection for explicit feedback and existing local diagnostics.
import { PROCESS_GONE_REASONS, PROCESS_SIGNALS } from './process-exit'

const REDACTIONS: Array<[RegExp, string]> = [
  [/(HERMES_DASHBOARD_SESSION_TOKEN=)(\S+)/g, '$1<redacted>'],
  [/(X-Hermes-Session-Token["']?\s*[:=]\s*["']?)([^\s"'&]+)/gi, '$1<redacted>'],
  [/(Authorization["']?\s*:\s*Bearer\s+)(\S+)/gi, '$1<redacted>'],
  [/([?&](?:token|ticket)=)([^\s&"']+)/gi, '$1<redacted>'],
  [/\b(?:sk|phx|ghp|gho)_[a-zA-Z0-9_-]{16,}\b/g, '<redacted>'],
  [/\bsk-[a-zA-Z0-9_-]{16,}\b/g, '<redacted>']
]

export function redactSecrets(text: unknown): string {
  return REDACTIONS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), String(text ?? ''))
}

export { diagnosticFrames } from '../shared/diagnostic-frames'

const DIAGNOSTIC_KINDS = new Set<string>([
  'Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'EvalError',
  ...PROCESS_GONE_REASONS, ...PROCESS_SIGNALS, 'exit', 'signal'
])

export function diagnosticKind(value: unknown): string {
  const kind = typeof value === 'string' ? value : ''

  return DIAGNOSTIC_KINDS.has(kind) ? kind : 'Error'
}
