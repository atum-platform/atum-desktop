/**
 * atum-product-defaults.mjs
 *
 * Build-time product defaults for packaged Atum. Canonical source for values
 * that are a PRODUCT decision rather than an engine decision.
 *
 * These include the managed model Atum lands on when the user has never picked
 * one and the public production control-plane coordinates used by packaging
 * and installed-app verification.
 *
 * Why this lives here and not in the engine
 * -----------------------------------------
 * The Hermes engine has its own silent default (`z-ai/glm-5.2`, see
 * `hermes_cli/models.py` PREFERRED_SILENT_DEFAULT_MODEL) and honours a user's
 * `~/.hermes/config.yaml` `model.default`. Both stay untouched: Atum is a
 * product built on the engine, not a fork of it, and rewriting a user's CLI
 * config at runtime would be a side effect on files Atum does not own.
 *
 * Instead the pin travels the way every other Atum product constant travels —
 * baked into `atum-public-config.json` at pack time (see
 * write-atum-public-config.mjs, wired from after-pack.mjs). The desktop reads
 * it back, and uses it ONLY as the default for "user has not chosen yet".
 * Switching models in the pill overwrites it like any other choice; the pin
 * never re-asserts itself over an explicit selection.
 *
 * Env name asymmetry (deliberate, mirrors the rest of the public config):
 *   - ATUM_PUBLIC_DEFAULT_MODEL — BUILD time. Read by the packer, baked in.
 *   - ATUM_DEFAULT_MODEL        — RUN time. Dev override, no rebuild needed.
 * See scripts/pack-prod.mjs for the same split on the hosted/Supabase values.
 */

/**
 * The pinned Atum managed alias. Electron routes it through the founder-scoped
 * hosted edge, which keeps the concrete provider credential server-side.
 */
export const ATUM_PINNED_DEFAULT_MODEL = 'binh-minh'

/** Public production settings that every production package must bake. */
export const ATUM_PROD_PLANE = Object.freeze({
  ATUM_PUBLIC_GOOGLE_AUTH_ENABLED: 'true',
  ATUM_PUBLIC_HOSTED_BASE_URL: 'https://api.atumplatform.com',
  ATUM_PUBLIC_SUPABASE_URL: 'https://public-config.example.invalid'
})

/**
 * Every hosted origin that IS the production plane: the canonical API
 * hostname plus the historical Vercel alias that builds packed before
 * 2026-09-12 still bake. Packaging treats any of them as production, so the
 * Google-auth policy and the mixed-plane refusal cannot be dodged by packing
 * against the old name.
 */
export const ATUM_PROD_HOSTED_ORIGINS = Object.freeze(new Set([
  ATUM_PROD_PLANE.ATUM_PUBLIC_HOSTED_BASE_URL,
  'https://deployment.example.invalid'
]))

/** Supabase project whose publishable anon key belongs in production builds. */
export const ATUM_PROD_SUPABASE_PROJECT_REF = 'example-project-ref'

/** Build-time override variable baked into the packaged public config. */
export const ATUM_DEFAULT_MODEL_BUILD_ENV = 'ATUM_PUBLIC_DEFAULT_MODEL'

/** Runtime override variable read by the packaged app on every launch. */
export const ATUM_DEFAULT_MODEL_RUNTIME_ENV = 'ATUM_DEFAULT_MODEL'

/**
 * The model id to bake into `atum-public-config.json`.
 *
 * Unlike the hosted/Supabase fields this is NOT fail-closed: a build that
 * forgets the variable must still ship a defined product default, and the
 * whole point of the pin is that the default is a constant we control.
 */
export function resolveAtumBuildDefaultModel(environment = process.env) {
  const override = environment?.[ATUM_DEFAULT_MODEL_BUILD_ENV]

  if (typeof override === 'string' && override.trim()) {
    return override.trim()
  }

  return ATUM_PINNED_DEFAULT_MODEL
}
