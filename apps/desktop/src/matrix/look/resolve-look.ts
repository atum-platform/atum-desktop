import type { CSSProperties } from 'react'

import type { AppDescriptor } from '../../../shared/app-catalog'
import {
  DEFAULT_LOOK_ROOM_ACCOUNT_DATA,
  type LookPackChatTokens,
  type LookPackDerivedGround,
  type LookPackGround,
  type LookPackPublished,
  type LookRoomAccountData,
  preferredLookVariant
} from '../../../shared/look-pack'
import type { MatrixRoom, MatrixSnapshot } from '../../../shared/matrix'

export type LookCssProperties = CSSProperties & Record<`--${string}`, string | number | undefined>

export interface ResolvedConversationLook {
  /** The chosen travelling background; identity tokens may come from another pack. */
  pack: LookPackPublished | null
  ground: LookPackGround | null
  tone?: LookPackGround['tone']
  tokens: LookPackChatTokens | null
  hasIdentityColors: boolean
  style: LookCssProperties
  selection: LookRoomAccountData
}

export interface ResolveConversationLookInput {
  snapshot: Pick<MatrixSnapshot, 'apps' | 'identity'>
  room: MatrixRoom
  appearance: 'light' | 'dark'
  accountData?: LookRoomAccountData
}

function position(value: LookPackGround['layers'][number]['position']): string {
  switch (value) {
    case 'top':
      return 'center top'
    case 'bottom':
      return 'center bottom'
    case 'start':
      return 'left center'
    case 'end':
      return 'right center'
    default:
      return 'center'
  }
}

export function appearanceGround(pack: LookPackPublished, appearance: 'light' | 'dark'): LookPackGround | null {
  const backgrounds = pack.chat?.background

  if (!backgrounds) {
    return null
  }

  return appearance === 'dark' ? (backgrounds.dark ?? backgrounds.light) : backgrounds.light
}

export function appearanceDerived(pack: LookPackPublished, appearance: 'light' | 'dark'): LookPackDerivedGround | undefined {
  return appearance === 'dark' ? (pack.derived.dark ?? pack.derived.light) : pack.derived.light
}

export function lookAssetUrl(sha256: string): string {
  return `atum-look://${sha256}`
}

/** Validated descriptor values become custom properties; selectors see no app or pack identity. */
export function groundStyle(
  ground: LookPackGround,
  derived: LookPackDerivedGround | undefined,
  use: 'full' | 'thumb' = 'full'
): LookCssProperties {
  const style: LookCssProperties = {
    '--look-base': ground.base,
    '--atum-ink': derived?.ink ?? (ground.tone === 'dark' ? '#FFFFFFFF' : '#151515FF'),
    '--atum-ink-soft': derived?.ink_soft ?? (ground.tone === 'dark' ? '#FFFFFFF2' : '#151515F2'),
    '--atum-ink-muted': derived?.ink_muted ?? (ground.tone === 'dark' ? '#FFFFFFE6' : '#151515E6'),
    '--atum-ink-faint': derived?.ink_faint ?? (ground.tone === 'dark' ? '#FFFFFFB3' : '#151515B3'),
    '--atum-line': derived?.line ?? (ground.tone === 'dark' ? '#FFFFFFA6' : '#151515A6'),
    '--look-scrim': derived?.scrim ?? ground.base,
    '--look-band-ink': ground.tone === 'dark' ? '#FFFFFFFF' : '#151515FF'
  }

  for (const [index, layer] of ground.layers.entries()) {
    const slot = index + 1
    const variant = preferredLookVariant(layer.asset, use)
    style[`--look-l${slot}-image`] = variant ? `url("${lookAssetUrl(variant.sha256)}")` : 'none'
    style[`--look-l${slot}-size`] = layer.fit === 'tile' ? `${layer.tile_px}px ${layer.tile_px}px` : layer.fit
    style[`--look-l${slot}-position`] = position(layer.position)
    style[`--look-l${slot}-repeat`] = layer.fit === 'tile' ? 'repeat' : 'no-repeat'
    style[`--look-l${slot}-opacity`] = layer.opacity
  }

  return style
}

/**
 * Frozen v1 packs may still carry fonts, radii and composer presentation.
 * They remain decoded for wire compatibility, but only identity colours cross
 * into the renderer. Atum owns every shape, type role and material.
 */
function identityColorStyle(tokens: LookPackChatTokens | null, accent: string | null): LookCssProperties {
  const style: LookCssProperties = {}

  if (tokens) {
    const ownerHover = `color-mix(in srgb, ${tokens.colors.owner_bubble} 88%, ${tokens.colors.bubble_foreground})`

    style['--ak-bubble-own'] = tokens.colors.owner_bubble
    style['--ak-bubble-own-hover'] = ownerHover
    style['--ak-on-bubble-own'] = tokens.colors.bubble_foreground
    style['--atum-user-bubble'] = tokens.colors.owner_bubble
    style['--atum-user-bubble-hover'] = ownerHover
    style['--atum-user-bubble-ink'] = tokens.colors.bubble_foreground
    style['--look-app-bubble'] = tokens.colors.app_bubble
    style['--look-bubble-ink'] = tokens.colors.bubble_foreground
    style['--look-bubble-border'] = tokens.colors.border
  }

  if (accent) {
    style['--look-accent'] = accent
  }

  return style
}

function directApp(snapshot: Pick<MatrixSnapshot, 'apps' | 'identity'>, room: MatrixRoom): AppDescriptor | undefined {
  if (!room.direct || room.membership !== 'join' || !snapshot.identity) {
    return undefined
  }

  const members =
    room.participants?.filter(member => member.membership === 'join' || member.membership === 'invite') ?? []

  return snapshot.apps?.apps.find(
    app =>
      app.bot &&
      members.some(member => member.userId === snapshot.identity!.userId) &&
      members.some(member => member.userId === app.bot!.user_id) &&
      members.every(member => member.userId === snapshot.identity!.userId || member.userId === app.bot!.user_id)
  )
}

export function availableLookPacks(snapshot: Pick<MatrixSnapshot, 'apps'>): LookPackPublished[] {
  const seen = new Set<string>()

  return [
    ...(snapshot.apps?.gallery ?? []),
    ...(snapshot.apps?.apps.flatMap(app => (app.look ? [app.look] : [])) ?? [])
  ]
    .filter(pack => Boolean(pack.chat?.background))
    .filter(pack => {
      if (seen.has(pack.pack_id)) {
        return false
      }

      seen.add(pack.pack_id)
      return true
    })
}

export function resolveConversationLook({
  snapshot,
  room,
  appearance,
  accountData = room.look ?? DEFAULT_LOOK_ROOM_ACCOUNT_DATA
}: ResolveConversationLookInput): ResolvedConversationLook {
  const identityApp = directApp(snapshot, room)
  const identityPack = identityApp?.look ?? null
  const offered = availableLookPacks(snapshot)

  let pack: LookPackPublished | null

  if (accountData.background.kind === 'none') {
    pack = null
  } else if (accountData.background.kind === 'pack') {
    const packId = accountData.background.pack_id
    pack = offered.find(candidate => candidate.pack_id === packId) ?? identityPack
  } else {
    pack = identityPack
  }

  if (!pack?.chat?.background) {
    pack = null
  }

  const ground = pack ? appearanceGround(pack, appearance) : null
  const tokens = identityPack?.chat?.tokens ?? null
  const accent = identityPack?.accent
    ? appearance === 'dark'
      ? (identityPack.accent.dark ?? identityPack.accent.light)
      : identityPack.accent.light
    : null

  return {
    pack,
    ground,
    tone: ground?.tone,
    tokens,
    hasIdentityColors: Boolean(tokens || accent),
    style: {
      ...(ground ? groundStyle(ground, appearanceDerived(pack!, appearance)) : {}),
      ...identityColorStyle(tokens, accent)
    },
    selection: accountData
  }
}

export interface ResolvedStartCardLook {
  ground: LookPackGround | null
  tone?: LookPackGround['tone']
  style: LookCssProperties
}

export function resolveStartCardLook(
  pack: LookPackPublished | null | undefined,
  appearance: 'light' | 'dark'
): ResolvedStartCardLook {
  if (!pack) {
    return { ground: null, style: {} }
  }

  const ground = pack.start_card?.band ?? appearanceGround(pack, appearance)

  if (ground) {
    return {
      ground,
      tone: ground.tone,
      style: groundStyle(ground, appearanceDerived(pack, appearance))
    }
  }

  const accent = appearance === 'dark' ? (pack.accent?.dark ?? pack.accent?.light) : pack.accent?.light

  return {
    ground: null,
    style: accent ? { '--look-base': accent, '--look-scrim': accent, '--look-band-ink': '#FFFFFFFF' } : {}
  }
}
