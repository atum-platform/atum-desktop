import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const DESKTOP_SERVICES_CONFIG_FIELDS = {
  updateFeedUrl: 'ATUM_PUBLIC_UPDATE_FEED_URL'
}

const REPORTING_FIELDS = {
  posthogKey: 'ATUM_PUBLIC_POSTHOG_KEY',
  posthogHost: 'ATUM_PUBLIC_POSTHOG_HOST',
  sentryDsn: 'ATUM_PUBLIC_SENTRY_DSN',
  environment: 'ATUM_PUBLIC_REPORTING_ENVIRONMENT'
}

function validateUpdateFeedUrl(value) {
  let feed

  try {
    feed = new URL(value)
  } catch {
    throw new Error('Invalid update feed URL')
  }

  if (feed.protocol !== 'https:' || feed.username || feed.password) {
    throw new Error('Invalid update feed URL')
  }

  return value
}

function validateReportingConfig(reporting) {
  if (!/^phc_[a-zA-Z0-9_-]{8,200}$/.test(reporting.posthogKey)) {
    throw new Error('Invalid public PostHog capture key')
  }

  let host
  let dsn

  try {
    host = new URL(reporting.posthogHost)
    dsn = new URL(reporting.sentryDsn)
  } catch {
    throw new Error('Invalid public reporting endpoint')
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
    throw new Error('Invalid public reporting endpoint')
  }

  return { ...reporting, posthogHost: host.origin, sentryDsn: dsn.href }
}

export function desktopServicesConfigFromEnvironment(environment) {
  const config = { schemaVersion: 1 }
  const updateFeedUrl = environment[DESKTOP_SERVICES_CONFIG_FIELDS.updateFeedUrl]

  if (typeof updateFeedUrl === 'string' && updateFeedUrl.trim()) {
    config.updateFeedUrl = validateUpdateFeedUrl(updateFeedUrl.trim())
  }

  const reporting = Object.fromEntries(
    Object.entries(REPORTING_FIELDS).map(([field, variable]) => [field, environment[variable]])
  )

  if (Object.values(reporting).some(Boolean)) {
    if (Object.values(reporting).some(value => typeof value !== 'string' || !value.trim())) {
      throw new Error('All four ATUM_PUBLIC reporting fields are required together')
    }

    for (const key of Object.keys(reporting)) reporting[key] = reporting[key].trim()
    if (!['production', 'test'].includes(reporting.environment)) {
      throw new Error('Invalid reporting environment')
    }
    config.observability = validateReportingConfig(reporting)
  }

  return config
}

export function writeDesktopServicesConfig({ environment = process.env, outputPath }) {
  const config = desktopServicesConfigFromEnvironment(environment)

  mkdirSync(path.dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, `${JSON.stringify(config)}\n`, { mode: 0o644 })
  return outputPath
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invoked) {
  const outputPath = process.argv[2]

  if (!outputPath) throw new Error('Usage: write-desktop-services-config.mjs <output-path>')
  writeDesktopServicesConfig({ outputPath })
}
