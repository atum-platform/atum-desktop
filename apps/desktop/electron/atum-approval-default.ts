import fs from 'node:fs'
import path from 'node:path'

import { load } from 'js-yaml'

/**
 * Atum's first-install approval default.
 *
 * Hermes ships with `approvals.mode: smart`, which auto-decides only flagged
 * terminal commands and escalates everything else (execute_code scripts,
 * plugin consents, undecidable commands) to a card. The Atum assistant is
 * meant to act without asking: hardline blocklist entries and the user's own
 * `approvals.deny` rules still block unconditionally, everything else runs.
 *
 * This is written ONCE into the desktop-owned Hermes home, and only when the
 * config carries no `approvals` block at all. A user who later flips the
 * status-bar zap (which writes `approvals.mode`) or edits the block by hand
 * owns it from then on; we never touch an existing block.
 */

export const ATUM_APPROVALS_DEFAULT_MODE = 'off'

export const ATUM_APPROVALS_DEFAULT_BLOCK = [
  '',
  '# Atum acts without approval prompts by default. Hermes\'s hardline blocklist',
  '# and your approvals.deny rules still apply. Toggle from the status bar, or',
  '# set "manual" / "smart" here to be asked again.',
  'approvals:',
  // Quoted on purpose: a bare `off` is a YAML 1.1 boolean.
  `  mode: "${ATUM_APPROVALS_DEFAULT_MODE}"`,
  ''
].join('\n')

export type AtumApprovalDefaultOutcome = 'created' | 'appended' | 'kept'

export interface AtumApprovalDefaultDeps {
  exists: (target: string) => boolean
  readFile: (target: string) => string
  writeFile: (target: string, contents: string) => void
  mkdirp: (target: string) => void
}

const nodeDeps: AtumApprovalDefaultDeps = {
  exists: target => fs.existsSync(target),
  readFile: target => fs.readFileSync(target, 'utf8'),
  writeFile: (target, contents) => fs.writeFileSync(target, contents, 'utf8'),
  mkdirp: target => fs.mkdirSync(target, { recursive: true })
}

/**
 * Whether a config declares approvals, including quoted keys and YAML merges.
 * Ambiguous/unparseable configs are treated as protected too: we cannot prove
 * that appending a default would preserve the user's approval posture.
 */
export function hasApprovalsBlock(configText: string): boolean {
  try {
    const parsed: unknown = load(configText)

    if (parsed == null) {
      // js-yaml returns null for comments as well as explicit YAML null.
      // Only blank/comment-only input is safe to append to; preserve an
      // explicit null or document marker instead of creating invalid YAML.
      return configText.split(/\r?\n/u).some(line => !/^\s*(?:#.*)?$/u.test(line))
    }

    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      return true
    }

    return Object.hasOwn(parsed, 'approvals')
  } catch {
    return true
  }
}

/**
 * Ensure the desktop-owned Hermes config carries Atum's approval default.
 * Returns what happened so the caller can log it. Never rewrites an existing
 * block; appends only when the key is entirely absent.
 */
export function ensureAtumApprovalDefault(
  configPath: string,
  deps: AtumApprovalDefaultDeps = nodeDeps
): AtumApprovalDefaultOutcome {
  if (!deps.exists(configPath)) {
    deps.mkdirp(path.dirname(configPath))
    deps.writeFile(configPath, `${ATUM_APPROVALS_DEFAULT_BLOCK.trimStart()}`)

    return 'created'
  }

  const current = deps.readFile(configPath)

  if (hasApprovalsBlock(current)) {
    return 'kept'
  }

  const separator = current.length === 0 || current.endsWith('\n') ? '' : '\n'
  deps.writeFile(configPath, `${current}${separator}${ATUM_APPROVALS_DEFAULT_BLOCK}`)

  return 'appended'
}

/**
 * The default applies only to the Hermes home the desktop owns. An explicit
 * `HERMES_HOME` points at a home the user (or a developer) manages elsewhere,
 * typically a CLI home whose approval posture is theirs to set.
 */
export function shouldApplyAtumApprovalDefault(env: NodeJS.ProcessEnv = process.env): boolean {
  return !String(env.HERMES_HOME || '').trim()
}

/**
 * Whether Atum created this agent and may therefore repair its settings.
 *
 * Every named profile lives in the same place, so location proves nothing: a
 * profile somebody made with the CLI sits beside one Atum made. The metadata
 * stamp is the only honest signal, and a profile without it is left alone.
 */
export function isAtumManagedAgent(profileHome: string, deps: AtumApprovalDefaultDeps = nodeDeps): boolean {
  const metadata = path.join(profileHome, 'profile.yaml')

  if (!deps.exists(metadata)) {
    return false
  }

  try {
    // Ownership is a parsed top-level value, not a line that happens to look
    // like one. Duplicate keys, malformed YAML and multi-document input throw
    // and stay untouched; standard YAML merges follow the effective mapping.
    const parsed: unknown = load(deps.readFile(metadata))

    return Boolean(
      parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
      Object.hasOwn(parsed, 'managed_by') &&
      (parsed as Record<string, unknown>).managed_by === 'atum'
    )
  } catch {
    return false
  }
}

/**
 * Give an Atum-created agent the same approval posture as Atum itself.
 *
 * A named profile has its own home and its own config, so the default written
 * into the desktop's home never reaches it and the agent would inherit
 * Hermes's prompting default instead. Runs before that agent's backend starts
 * and is idempotent, so it doubles as a repair. Never touches a profile Atum
 * did not create.
 */
export function ensureAtumAgentApprovalDefault(
  profileHome: string,
  deps: AtumApprovalDefaultDeps = nodeDeps
): AtumApprovalDefaultOutcome | 'not-managed' {
  if (!isAtumManagedAgent(profileHome, deps)) {
    return 'not-managed'
  }

  return ensureAtumApprovalDefault(path.join(profileHome, 'config.yaml'), deps)
}
