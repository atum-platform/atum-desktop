/** Public device-runtime facade over the authenticated srt HTTP/CONNECT proxy. */
export {
  decideEgress,
  DEFAULT_EGRESS_ALLOWLIST,
  type EgressDecision,
  type EgressDecisionInput,
  EgressProxy,
  type EgressProxyDeps,
  hostMatches,
  parseAuthority
} from './guard/egress'
