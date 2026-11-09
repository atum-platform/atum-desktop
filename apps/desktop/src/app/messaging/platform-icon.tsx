import {
  SiApple,
  SiBilibili,
  SiDiscord,
  SiGmail,
  SiHomeassistant,
  SiMatrix,
  SiMattermost,
  SiQq,
  SiSignal,
  SiTelegram,
  SiWechat,
  SiWhatsapp
} from '@icons-pack/react-simple-icons'
import type { ComponentPropsWithoutRef, ComponentType, SVGProps } from 'react'
import { forwardRef } from 'react'

import { BrandTile, type BrandTileSize } from '@/components/brand/brand-tile'
import { Globe, Link as LinkIcon, MessageSquareText } from '@/lib/icons'

// We render simpleicons.org brand glyphs for platforms whose owners publish a
// usable mark (telegram, discord, matrix, ...). A few brands — Slack, Dingtalk,
// Feishu, WeCom — have been removed from Simple Icons at the brand owner's
// request, so they get a letter monogram. Every mark draws in ink inside the
// shared BrandTile: no per-brand colour wash (Atum icon system).
interface PlatformIconSpec {
  Icon?: ComponentType<SVGProps<SVGSVGElement>>
  monogram?: string
  /** A Tabler outline glyph for platforms that are not a brand. */
  outline?: boolean
}

const PLATFORM_ICONS: Record<string, PlatformIconSpec> = {
  telegram: { Icon: SiTelegram },
  discord: { Icon: SiDiscord },
  // Slack removed from Simple Icons by Salesforce request — letter monogram.
  slack: { monogram: 'S' },
  mattermost: { Icon: SiMattermost },
  matrix: { Icon: SiMatrix },
  signal: { Icon: SiSignal },
  whatsapp: { Icon: SiWhatsapp },
  bluebubbles: { Icon: SiApple },
  homeassistant: { Icon: SiHomeassistant },
  email: { Icon: SiGmail },
  sms: { Icon: MessageSquareText, outline: true },
  webhook: { Icon: LinkIcon, outline: true },
  api_server: { Icon: Globe, outline: true },
  weixin: { Icon: SiWechat },
  qqbot: { Icon: SiQq },
  yuanbao: { Icon: SiBilibili }
}

interface PlatformAvatarProps extends Omit<ComponentPropsWithoutRef<'span'>, 'children'> {
  platformId: string
  platformName: string
  size?: BrandTileSize
}

// forwardRef + spreading ...rest is required so a wrapping <Tip> (Radix
// Tooltip's `asChild`) can actually attach its trigger: asChild clones this
// component and injects a ref plus pointer/focus/aria handlers onto it. A
// plain function component with no ref/rest forwarding drops all of that
// silently — the tooltip renders but never opens (#67500).
export const PlatformAvatar = forwardRef<HTMLSpanElement, PlatformAvatarProps>(function PlatformAvatar(
  { platformId, platformName, ...rest },
  ref
) {
  const spec = PLATFORM_ICONS[platformId]

  return (
    <BrandTile
      glyph={spec?.Icon}
      monogram={spec?.monogram ?? platformName}
      outline={spec?.outline}
      ref={ref}
      {...rest}
    />
  )
})
