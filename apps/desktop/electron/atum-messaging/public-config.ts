import { readFileSync, statSync } from 'node:fs'

import {
  type AtumObservabilityConfig,
  parseHttpsUpdateFeedUrl,
  parseObservabilityConfig
} from '../desktop-services-config'

import { type AtumAccountConfig, type AtumAccountConfigInput, resolveAtumAccountConfig } from './account-auth'

export { type AtumObservabilityConfig, parseObservabilityConfig }

const MAX_PUBLIC_CONFIG_BYTES = 32 * 1024

export interface AtumPublicConfigSources {
  environment: AtumAccountConfigInput
  packagedPath?: string | null
}

/**
 * Runtime override for the pinned product default model. Mirrors the
 * build-time `ATUM_PUBLIC_DEFAULT_MODEL` baked into the packaged config —
 * the names differ on purpose (build-time vs runtime), exactly like
 * ATUM_PUBLIC_HOSTED_BASE_URL vs ATUM_PLATFORM_URL.
 */
export const ATUM_DEFAULT_MODEL_RUNTIME_ENV = 'ATUM_DEFAULT_MODEL'

function parsePackagedPublicConfig(path: string): AtumAccountConfigInput & {
  defaultModel: null | string
  updateFeedUrl: null | string
  observability: unknown
} {
  const stat = statSync(path)

  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_PUBLIC_CONFIG_BYTES || (stat.mode & 0o002) !== 0) {
    throw new Error('atum_public_config_file_invalid')
  }

  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('atum_public_config_invalid')
  }

  const record = parsed as Record<string, unknown>

  const allowed = new Set([
    'schemaVersion',
    'hostedBaseUrl',
    'supabaseUrl',
    'supabaseAnonKey',
    'defaultModel',
    'updateFeedUrl',
    'providers',
    'observability'
  ])

  if (Object.keys(record).some(key => !allowed.has(key))) {
    throw new Error('atum_public_config_contains_unknown_field')
  }

  if (record.schemaVersion !== 1) {
    throw new Error('atum_public_config_schema_unsupported')
  }

  const providers = record.providers && typeof record.providers === 'object' && !Array.isArray(record.providers)
    ? (record.providers as Record<string, unknown>)
    : null

  if (
    !providers ||
    Object.keys(providers).some(key => key !== 'google' && key !== 'password') ||
    typeof providers.google !== 'boolean' ||
    typeof providers.password !== 'boolean'
  ) {
    throw new Error('atum_public_config_providers_invalid')
  }

  // Optional: a config written before the product pin existed still parses.
  // But present-and-blank is a packing bug, not "no preference" — reject it
  // rather than quietly falling back to the engine's silent default.
  if ('defaultModel' in record && (typeof record.defaultModel !== 'string' || !record.defaultModel.trim())) {
    throw new Error('atum_public_config_default_model_invalid')
  }


  if ('updateFeedUrl' in record) {
    parseHttpsUpdateFeedUrl(record.updateFeedUrl, 'atum_public_config_update_feed_invalid')
  }

  return {
    hostedBaseUrl: typeof record.hostedBaseUrl === 'string' ? record.hostedBaseUrl : null,
    supabaseUrl: typeof record.supabaseUrl === 'string' ? record.supabaseUrl : null,
    supabaseAnonKey: typeof record.supabaseAnonKey === 'string' ? record.supabaseAnonKey : null,
    defaultModel: typeof record.defaultModel === 'string' ? record.defaultModel.trim() : null,
    updateFeedUrl: typeof record.updateFeedUrl === 'string' ? record.updateFeedUrl.trim() : null,
    observability: record.observability ?? null,
    providers: { google: providers.google, password: providers.password }
  }
}

export function resolveAtumUpdateFeedUrl(packagedPath?: null | string): null | string {
  if (!packagedPath) {return null}

  return parsePackagedPublicConfig(packagedPath).updateFeedUrl
}

/** Environment wins as a complete dev override; packages fall back to Resources JSON. */
export function resolveAtumPublicAccountConfig(sources: AtumPublicConfigSources): AtumAccountConfig | null {
  const fromEnvironment = resolveAtumAccountConfig(sources.environment)

  if (fromEnvironment) {return fromEnvironment}

  if (!sources.packagedPath) {return null}

  return resolveAtumAccountConfig(parsePackagedPublicConfig(sources.packagedPath))
}

/**
 * The Atum product default model, or null when this build carries no pin
 * (source checkouts, `npm run dev`) — in which case the renderer keeps the
 * engine's own recommendation, unchanged.
 *
 * This is a DEFAULT, never an enforcement: it is consulted only where the app
 * has to choose a model on the user's behalf. An explicit pick in the model
 * pill is stored by the engine and this value is never consulted again.
 */
export function resolveAtumProductDefaultModel(sources: {
  environment?: NodeJS.ProcessEnv
  packagedPath?: null | string
}): null | string {
  const override = sources.environment?.[ATUM_DEFAULT_MODEL_RUNTIME_ENV]

  if (typeof override === 'string' && override.trim()) {return override.trim()}

  if (!sources.packagedPath) {return null}

  return parsePackagedPublicConfig(sources.packagedPath).defaultModel
}

export { MAX_PUBLIC_CONFIG_BYTES, parsePackagedPublicConfig }

export function resolveAtumObservabilityConfig(packagedPath: string): AtumObservabilityConfig | null {
  return parseObservabilityConfig(parsePackagedPublicConfig(packagedPath).observability, 'atum_reporting_config_invalid')
}
