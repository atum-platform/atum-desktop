// Defaults must run before bundled modules resolve paths or feature flags.
// Match scripts/releases/bundle_env.py and the channel request decoder.
const ALLOWED_KEYS = new Set([
  'HERMES_HOME', 'HERMES_DATA_DIR_SUFFIX', 'HERMES_DESKTOP_USER_DATA_DIR',
  'HERMES_SHARED_AUTH_DIR', 'HERMES_PREVIEW_FULL_CONNECTORS'
])

/** @param {unknown} values @returns {Record<string, string|null>} */
export function validateBundleEnvironment(values) {
  if (!values || Array.isArray(values) || typeof values !== 'object') {
    throw new Error('Bundle environment must be a JSON object')
  }
  for (const [key, value] of Object.entries(values)) {
    if (!ALLOWED_KEYS.has(key) || (value !== null && (typeof value !== 'string' || value.includes('\0')))) {
      throw new Error('Bundle environment requires permitted desktop keys and string values without NUL, or null to clear')
    }
  }
  return /** @type {Record<string, string|null>} */ (values)
}

/**
 * Apply bundle defaults/clears without mutating the caller's environment.
 * @param {Record<string, string|undefined>} env
 * @param {Record<string, string|null>} values
 */
export function applyBundleEnvironment(env, values) {
  const result = { ...env }
  for (const [key, value] of Object.entries(values)) {
    if (value === null) result[key] = ''
    else if (result[key] == null) result[key] = value
  }
  return result
}

/** @param {string} raw @returns {string} */
export function environmentDefaultsBanner(raw) {
  const values = validateBundleEnvironment(JSON.parse(raw))

  return `\nfor (const [key, value] of ${JSON.stringify(Object.entries(values))}) { if (value === null) process.env[key] = ''; else process.env[key] ??= value; }\n`
}
