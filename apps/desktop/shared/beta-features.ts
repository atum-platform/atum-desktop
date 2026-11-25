/**
 * Beta features: Team Space, hires and skill purchases (owner, 2026-11-25). Everyone else sees
 * them as "Coming soon" until they work well; beta accounts (the owner, test accounts) keep them.
 *
 * This is the one reader of that fact. The platform names it on the signed-in account's `/me`
 * answer as `betaFeatures: true`; anything else (absent, false, malformed, an older Shell) is
 * "not beta". Presentation only: the platform still decides every request.
 */
export function readBetaFeatures(me: unknown): boolean {
  return Boolean(me) && typeof me === 'object' && (me as { betaFeatures?: unknown }).betaFeatures === true
}
