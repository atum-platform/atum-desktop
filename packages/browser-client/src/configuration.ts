import { parseConfig, BrowserFailure } from './record'
import { parseDomainConfig } from './domain-record'

export function runtimeConfiguration(value: unknown, origin: string) {
  const raw = value as { mode?: unknown; domain?: unknown } | null
  const matrix = parseConfig(value, origin)
  if (raw?.mode !== undefined && !['proof', 'launch'].includes(raw.mode as string)) throw new BrowserFailure('configuration_required')
  const domain = parseDomainConfig(raw?.domain, matrix)
  const launch = raw?.mode === 'launch'
  if (launch && (!domain || new URL(origin).protocol !== 'https:' || new URL(domain.apiBaseUrl).protocol !== 'https:' ||
      new URL(matrix.baseUrl).protocol !== 'https:')) throw new BrowserFailure('configuration_required')
  return { matrix, domain, launch }
}
