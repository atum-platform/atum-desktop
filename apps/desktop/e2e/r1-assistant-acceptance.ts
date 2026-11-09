import * as fs from 'node:fs'
import * as path from 'node:path'

export type AcceptanceEvidenceRef = string
export type AssistantPresentationState = 'pending' | 'slow' | 'success' | 'error' | 'cancelled'

export interface R1AssistantAcceptanceTrace {
  schema: 'atum-r1-assistant-acceptance-trace/1'
  candidate_id: string
  source_head_sha: string
  artifact_sha256: string
  journey_id: 'R1-assistant-completion'
  fixture_id: string
  target: {
    os: 'macos' | 'windows' | 'linux'
    os_version: string
    arch: 'arm64' | 'x64'
  }
  execution: {
    mode: 'local' | 'packaged'
    clean_install: boolean
    isolated_profile: boolean
    deployment_credentials_used: false
    github_ruleset_access_used: false
  }
  started_at: string
  completed_at: string
  valid_until: string
  browser: {
    presentations: Array<{
      state: AssistantPresentationState
      pane_opened_automatically: boolean
      technical_detail_available: boolean
      evidence: AcceptanceEvidenceRef[]
    }>
    without_grant: {
      broker_decision: 'denied'
      problem_code: 'CAPABILITY_DENIED' | 'CAPABILITY_REVOKED'
      attempted_effects: number
      authority_ref: null
      evidence: AcceptanceEvidenceRef[]
    }
  }
  computer_control: {
    disclosure: {
      capability: 'computer_control'
      scope: string
      effect: string
      presented_before_decision: boolean
      evidence: AcceptanceEvidenceRef[]
    }
    initial_choices: Array<{
      decision: 'denied' | 'later'
      attempted_effects: number
      authority_ref: null
      evidence: AcceptanceEvidenceRef[]
    }>
    grant: {
      decision: 'granted'
      broker: 'S2'
      authority_ref: string
      scope: string
      evidence: AcceptanceEvidenceRef[]
    }
    active_use: {
      visible: boolean
      capability: 'computer_control'
      authority_ref: string
      attribution: string
      evidence: AcceptanceEvidenceRef[]
    }
    revocations: Array<{
      source: 'live_surface' | 'settings'
      broker: 'S2'
      authority_ref: string
      decision: 'revoked'
      evidence: AcceptanceEvidenceRef[]
    }>
    safe_boundary: {
      use_started: {
        type: 'use_started'
        grantId: string
        operationId: string
        occurredAt: string
        observed_order: number
      }
      revocation: {
        type: 'revoked'
        grantId: string
        safeBoundary: 'partial_effects'
        rendererMessage: string
        occurredAt: string
        observed_order: number
      }
      use_finished: {
        type: 'use_finished'
        grantId: string
        operationId: string
        outcome: 'revoked'
        safeBoundary: 'partial_effects'
        completedOperation: boolean
        rendererMessage: string
        occurredAt: string
        observed_order: number
      }
      problem_code: 'CAPABILITY_REVOKED'
      technical_detail_available: true
      technical_detail: string
      detail_sanitized: true
      evidence: AcceptanceEvidenceRef[]
    }
    subsequent_attempt: {
      broker_decision: 'denied'
      problem_code: 'CAPABILITY_DENIED' | 'CAPABILITY_REVOKED'
      attempted_effects: number
      authority_ref: null
      evidence: AcceptanceEvidenceRef[]
    }
  }
  redaction_check: {
    verifier: string
    corpus_result_ref: string
    result: 'pass'
  }
  evidence_ref: string
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => canonicalize(item))
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, canonicalize(item)])
    )
  }

  return value
}

/**
 * Persist semantic observations from either a local or packaged Playwright run.
 * The caller owns UI selectors and broker adapters; this helper intentionally
 * cannot authorize browser or computer-control capability.
 */
export function writeR1AssistantAcceptanceTrace(
  outputPath: string,
  trace: R1AssistantAcceptanceTrace
): void {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, `${JSON.stringify(canonicalize(trace), null, 2)}\n`, 'utf8')
}
