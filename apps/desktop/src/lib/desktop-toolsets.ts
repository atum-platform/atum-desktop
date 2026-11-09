import { asText } from '@/lib/text'
import type { ToolsetInfo } from '@/types/hermes'

// Curation for the desktop "Skills & Tools → Toolsets" list.
//
// `GET /api/tools/toolsets` returns the full CONFIGURABLE_TOOLSETS set with no
// desktop-specific filter — so it surfaces entries that don't belong in a flat
// per-user toggle list on the desktop: platform-coupled toolsets (which
// `hermes tools` already platform-restricts on the CLI) and internal plumbing
// that isn't a user-facing capability. Mirror the curation approach used for
// slash commands (`desktop-slash-commands.ts`): one documented block-list, one
// predicate. Hiding a toolset only removes its row — its enabled state and
// runtime gating are untouched.
const DESKTOP_HIDDEN_TOOLSETS = new Set([
  // Platform-coupled — only meaningful when that platform is the active
  // adapter; `hermes tools` restricts these off the CLI too.
  'discord',
  'discord_admin',
  'yuanbao',
  // Internal plumbing, not a user capability toggle.
  'context_engine',
  'moa'
])

export function isDesktopToolsetVisible(name: string): boolean {
  return !DESKTOP_HIDDEN_TOOLSETS.has(name)
}

/** Pure presentation shared by Settings, Skills and the native Matrix pages. */
export const stripToolsetLabel = (label: string): string =>
  label.replace(/^[\p{Emoji}\p{Extended_Pictographic}\s]+/u, '').trim() || label

export const toolsetDisplayLabel = (toolset: Pick<ToolsetInfo, 'label' | 'name'>): string => {
  const label = asText(toolset.label || toolset.name)
  return label.replace(/^[\p{Emoji}\p{Extended_Pictographic}\s]+/u, '').trim() || toolset.name
}

export const toolNames = (toolset: ToolsetInfo): string[] =>
  Array.isArray(toolset.tools) ? toolset.tools.map(asText).filter(Boolean) : []
