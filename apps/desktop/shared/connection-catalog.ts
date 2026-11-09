/** Atum's offered connection paths. Status applies to this adapter, not every
 * integration a vendor permits. Main owns surface/acknowledgment evidence. */
export type ConnectionKind = 'plan' | 'apiKey' | 'local' | 'custom'
export type ConnectionSurface = 'connections' | 'advanced' | 'hidden'
export type PlanSignIn = 'sanctioned' | 'pending_approval' | 'prohibited' | 'unverified'

export interface ConnectionCatalogEntry {
  readonly provider: string
  readonly kind: ConnectionKind
  readonly flow: 'device_code' | 'provider_login' | 'api_key' | 'local_http' | 'custom_http'
  readonly planSignIn: PlanSignIn | null
  readonly source: string
  readonly reviewedAt: string
  readonly surface: ConnectionSurface
  readonly policyVersion: string
  readonly ownerAcceptance?: Readonly<{ acceptedAt: string; quote: string }>
}

export interface PlanAcknowledgment {
  readonly provider: string
  readonly policyVersion: string
  readonly acknowledgedAt: string
}

export interface PlanStartInput {
  provider: string
  surface: ConnectionSurface
  trustedAcknowledgment?: PlanAcknowledgment
  today: string
}

const REVIEWED_AT = '2026-10-06'
const CHATGPT_REVIEWED_AT = '2026-10-27'

const entry = (
  value: Omit<ConnectionCatalogEntry, 'reviewedAt' | 'policyVersion'>,
  reviewedAt = REVIEWED_AT
): ConnectionCatalogEntry => Object.freeze({
  ...value, reviewedAt, policyVersion: reviewedAt,
  ...(value.ownerAcceptance ? { ownerAcceptance: Object.freeze({ ...value.ownerAcceptance }) } : {})
})

export const CONNECTION_CATALOG: readonly ConnectionCatalogEntry[] = Object.freeze([
  // The owner moved this to Settings › Connections on 2026-10-27: show the plan sign-in
  // where a person looks for subscriptions, not only under For developers.
  entry({ provider: 'openai-codex', kind: 'plan', flow: 'device_code', planSignIn: 'pending_approval', surface: 'connections',
    source: 'https://developers.openai.com/siwc/request-client-id',
    ownerAcceptance: { acceptedAt: '2026-10-27', quote: 'How do I connect chatGPT sub now? Settings seems to no longer show it? Should show in settings and also on the model picker. And I think connecting subs should be account wide - so once I connect, all my agents have access to models from that sub. Add opencode too' } }, CHATGPT_REVIEWED_AT),
  entry({ provider: 'anthropic', kind: 'plan', flow: 'provider_login', planSignIn: 'prohibited', surface: 'hidden', source: 'https://code.claude.com/docs/en/legal-and-compliance' }),
  // This is the current token/client-reuse path. The unmodified vendor binary
  // is a separate documented path, not implemented/sanctioned by this entry.
  entry({ provider: 'claude-code', kind: 'plan', flow: 'provider_login', planSignIn: 'prohibited', surface: 'hidden', source: 'https://code.claude.com/docs/en/legal-and-compliance' }),
  // GitHub's own OAuth App + Copilot SDK is a distinct sanctioned integration;
  // it does not authorize the existing VS Code client-identity reuse adapter.
  entry({ provider: 'copilot', kind: 'plan', flow: 'device_code', planSignIn: 'prohibited', surface: 'hidden', source: 'https://docs.github.com/en/copilot/how-tos/copilot-sdk/setup/github-oauth' }),
  entry({ provider: 'copilot-acp', kind: 'plan', flow: 'provider_login', planSignIn: 'prohibited', surface: 'hidden', source: 'https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/authenticate' }),
  entry({ provider: 'qwen-oauth', kind: 'plan', flow: 'device_code', planSignIn: 'unverified', surface: 'hidden', source: 'https://github.com/QwenLM/qwen-code' }),
  entry({ provider: 'xai-oauth', kind: 'plan', flow: 'device_code', planSignIn: 'unverified', surface: 'hidden', source: 'https://docs.x.ai/' }),
  entry({ provider: 'minimax-oauth', kind: 'plan', flow: 'device_code', planSignIn: 'unverified', surface: 'hidden', source: 'https://platform.minimax.io/docs/' }),
  entry({ provider: 'openai-api', kind: 'apiKey', flow: 'api_key', planSignIn: null, surface: 'connections', source: 'https://developers.openai.com/api/docs/quickstart' }),
  entry({ provider: 'gemini', kind: 'apiKey', flow: 'api_key', planSignIn: null, surface: 'connections', source: 'https://ai.google.dev/gemini-api/docs/api-key' }),
  entry({ provider: 'anthropic', kind: 'apiKey', flow: 'api_key', planSignIn: null, surface: 'connections', source: 'https://platform.claude.com/docs/en/api/overview' }),
  entry({ provider: 'openrouter', kind: 'apiKey', flow: 'api_key', planSignIn: null, surface: 'connections', source: 'https://openrouter.ai/docs/api/reference/authentication' }),
  // OpenCode Go is a subscription API key Hermes reads as OPENCODE_GO_API_KEY, not a plan sign-in.
  entry({ provider: 'opencode-go', kind: 'apiKey', flow: 'api_key', planSignIn: null, surface: 'connections', source: 'https://opencode.ai/docs/zen/' }, CHATGPT_REVIEWED_AT),
  entry({ provider: 'ollama', kind: 'local', flow: 'local_http', planSignIn: null, surface: 'connections', source: 'https://docs.ollama.com/api/introduction' }),
  entry({ provider: 'lmstudio', kind: 'local', flow: 'local_http', planSignIn: null, surface: 'connections', source: 'https://lmstudio.ai/docs/developer' }),
  entry({ provider: 'custom', kind: 'custom', flow: 'custom_http', planSignIn: null, surface: 'advanced', source: 'https://hermes-agent.nousresearch.com/docs/user-guide/features/providers/' })
])

export function connectionCatalogEntry(provider: string, kind: ConnectionKind): ConnectionCatalogEntry | undefined {
  return CONNECTION_CATALOG.find(value => value.provider === provider && value.kind === kind)
}

function date(value: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {return undefined}
  const timestamp = Date.parse(`${value}T00:00:00.000Z`)

  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value ? timestamp : undefined
}

/** Calendar-date freshness: future/invalid dates and rows older than45 days fail. */
export function connectionReviewFresh(value: Pick<ConnectionCatalogEntry, 'reviewedAt'>, today: string): boolean {
  const reviewed = date(value.reviewedAt), now = date(today)

  return reviewed !== undefined && now !== undefined && now >= reviewed && now - reviewed <= 45 * 86_400_000
}

/** Main must supply its pinned page surface and account-scoped stored record,
 * never a renderer-supplied acceptance boolean or acknowledgment object. */
export function planStartDecision({ provider, surface, trustedAcknowledgment, today }: PlanStartInput): 'allowed' | 'provider_terms_blocked' {
  const value = connectionCatalogEntry(provider, 'plan')

  if (!value || value.surface === 'hidden' || surface !== value.surface || !connectionReviewFresh(value, today)) {return 'provider_terms_blocked'}

  if (value.planSignIn === 'sanctioned') {return 'allowed'}
  const accepted = date(value.ownerAcceptance?.acceptedAt ?? '')
  const acknowledged = date(trustedAcknowledgment?.acknowledgedAt ?? '')
  const policy = date(value.policyVersion), now = date(today)

  return value.planSignIn === 'pending_approval' && accepted !== undefined && now !== undefined && accepted <= now &&
    Boolean(value.ownerAcceptance?.quote.trim()) && trustedAcknowledgment?.provider === provider && trustedAcknowledgment.policyVersion === value.policyVersion &&
    acknowledged !== undefined && policy !== undefined && acknowledged >= policy && acknowledged <= now ? 'allowed' : 'provider_terms_blocked'
}

/** Discovery hides new blocked plan starts, while main keeps existing records
 * reachable for disconnect. It must still call planStartDecision on every start. */
export function connectionVisible(value: ConnectionCatalogEntry, connected: boolean): boolean {
  return value.surface !== 'hidden' || value.kind === 'plan' && connected
}
