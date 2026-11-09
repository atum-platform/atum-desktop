import { readFileSync, statSync } from 'node:fs'

const MAX_DESKTOP_SERVICES_CONFIG_BYTES = 32 * 1024

export interface AtumObservabilityConfig {
  posthogKey: string
  posthogHost: string
  sentryDsn: string
  environment: 'production' | 'test'
}

export interface DesktopServicesConfig {
  observability: AtumObservabilityConfig | null
  updateFeedUrl: string | null
}

function invalid(errorCode: string): never {
  throw new Error(errorCode)
}

/** Validates the public, HTTPS-only updater feed without changing its URL. */
export function parseHttpsUpdateFeedUrl(
  input: unknown,
  errorCode = 'atum_desktop_services_config_update_feed_invalid'
): string {
  if (typeof input !== 'string' || !input.trim()) {
    return invalid(errorCode)
  }

  const value = input.trim()
  let feed: URL

  try {
    feed = new URL(value)
  } catch {
    return invalid(errorCode)
  }

  if (feed.protocol !== 'https:' || feed.username || feed.password) {
    return invalid(errorCode)
  }

  return value
}

/**
 * Only public ingestion configuration belongs in a distributed application.
 * In particular, PostHog capture keys and public Sentry DSNs are accepted;
 * project credentials, secret keys, and alternate ingestion hosts are not.
 */
export function parseObservabilityConfig(
  input: unknown,
  errorCode = 'atum_desktop_services_config_observability_invalid'
): AtumObservabilityConfig | null {
  if (input == null) {
    return null
  }

  if (typeof input !== 'object' || Array.isArray(input)) {
    return invalid(errorCode)
  }

  const r = input as Record<string, unknown>

  if (
    Object.keys(r).some(k => !['posthogKey', 'posthogHost', 'sentryDsn', 'environment'].includes(k)) ||
    typeof r.posthogKey !== 'string' ||
    !/^phc_[a-zA-Z0-9_-]{8,200}$/.test(r.posthogKey) ||
    typeof r.posthogHost !== 'string' ||
    typeof r.sentryDsn !== 'string' ||
    !['production', 'test'].includes(String(r.environment))
  ) {
    return invalid(errorCode)
  }

  let host: URL
  let dsn: URL

  try {
    host = new URL(r.posthogHost)
    dsn = new URL(r.sentryDsn)
  } catch {
    return invalid(errorCode)
  }

  if (
    host.protocol !== 'https:' ||
    host.username ||
    host.password ||
    host.search ||
    host.hash ||
    !['us.i.posthog.com', 'eu.i.posthog.com'].includes(host.hostname) ||
    dsn.protocol !== 'https:' ||
    !dsn.hostname.endsWith('.sentry.io') ||
    !dsn.username ||
    dsn.password ||
    dsn.search ||
    dsn.hash ||
    !/^\/\d+$/.test(dsn.pathname)
  ) {
    return invalid(errorCode)
  }

  return {
    posthogKey: r.posthogKey,
    posthogHost: host.origin,
    sentryDsn: dsn.href,
    environment: r.environment as AtumObservabilityConfig['environment']
  }
}

/**
 * Reads the reporting/update-only config bundled in Matrix Resources. A missing
 * file is the intentional disabled state for source and development builds.
 * A present file is authoritative and must pass the complete schema.
 */
export function readDesktopServicesConfig(packagedPath: string): DesktopServicesConfig {
  try {
    const stat = statSync(packagedPath)

    if (
      !stat.isFile() ||
      stat.size <= 0 ||
      stat.size > MAX_DESKTOP_SERVICES_CONFIG_BYTES ||
      (stat.mode & 0o022) !== 0
    ) {
      return invalid('atum_desktop_services_config_file_invalid')
    }

    const parsed = JSON.parse(readFileSync(packagedPath, 'utf8')) as unknown

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return invalid('atum_desktop_services_config_invalid')
    }

    const record = parsed as Record<string, unknown>
    const allowed = new Set(['schemaVersion', 'observability', 'updateFeedUrl'])

    if (Object.keys(record).some(key => !allowed.has(key))) {
      return invalid('atum_desktop_services_config_contains_unknown_field')
    }

    if (record.schemaVersion !== 1) {
      return invalid('atum_desktop_services_config_schema_unsupported')
    }

    return {
      observability: parseObservabilityConfig(record.observability ?? null),
      updateFeedUrl: 'updateFeedUrl' in record ? parseHttpsUpdateFeedUrl(record.updateFeedUrl) : null
    }
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return { observability: null, updateFeedUrl: null }
    }

    throw error
  }
}

export { MAX_DESKTOP_SERVICES_CONFIG_BYTES }
