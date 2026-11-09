import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveAtumBuildDefaultModel } from './atum-product-defaults.mjs'

export const PUBLIC_CONFIG_FIELDS = {
  hostedBaseUrl: 'ATUM_PUBLIC_HOSTED_BASE_URL',
  supabaseUrl: 'ATUM_PUBLIC_SUPABASE_URL',
  supabaseAnonKey: 'ATUM_PUBLIC_SUPABASE_ANON_KEY'
}

export const OPTIONAL_PUBLIC_CONFIG_FIELDS = {
  updateFeedUrl: 'ATUM_PUBLIC_UPDATE_FEED_URL'
}

export function publicConfigFromEnvironment(environment) {
  const config = {
    schemaVersion: 1,
    // Product pin, not an engine setting: the model the packaged app lands on
    // when the user has never chosen one. Always defined (see
    // atum-product-defaults.mjs) so the packaged config can't ship a hole.
    defaultModel: resolveAtumBuildDefaultModel(environment),
    providers: {
      google: environment.ATUM_PUBLIC_GOOGLE_AUTH_ENABLED === 'true',
      password: environment.ATUM_PUBLIC_PASSWORD_AUTH_ENABLED !== 'false'
    }
  }

  for (const [field, variable] of Object.entries(PUBLIC_CONFIG_FIELDS)) {
    const value = environment[variable]

    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`Missing build-time public config variable ${variable}`)
    }

    config[field] = value.trim()
  }


  for (const [field, variable] of Object.entries(OPTIONAL_PUBLIC_CONFIG_FIELDS)) {
    const value = environment[variable]

    if (typeof value === 'string' && value.trim()) config[field] = value.trim()
  }

  const reporting = {
    posthogKey: environment.ATUM_PUBLIC_POSTHOG_KEY,
    posthogHost: environment.ATUM_PUBLIC_POSTHOG_HOST,
    sentryDsn: environment.ATUM_PUBLIC_SENTRY_DSN,
    environment: environment.ATUM_PUBLIC_REPORTING_ENVIRONMENT
  }
  if (Object.values(reporting).some(Boolean)) {
    if (Object.values(reporting).some(value => typeof value !== 'string' || !value.trim())) {
      throw new Error('All four ATUM_PUBLIC reporting fields are required together')
    }
    for (const key of Object.keys(reporting)) reporting[key] = reporting[key].trim()
    if (!['production', 'test'].includes(reporting.environment)) throw new Error('Invalid reporting environment')
    config.observability = reporting
  }
  return config
}

export function writeAtumPublicConfig({ environment = process.env, outputPath }) {
  const config = publicConfigFromEnvironment(environment)
  mkdirSync(path.dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, `${JSON.stringify(config)}\n`, { mode: 0o644 })
  return outputPath
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invoked) {
  const outputPath = process.argv[2]

  if (!outputPath) throw new Error('Usage: write-atum-public-config.mjs <output-path>')
  writeAtumPublicConfig({ outputPath })
}
