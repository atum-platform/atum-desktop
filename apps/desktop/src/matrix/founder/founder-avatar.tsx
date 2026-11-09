import { cn } from '@/lib/utils'

import ravenOnBoneSmall from './assets/founder-raven-on-bone-small.svg'
import ravenOnBone from './assets/founder-raven-on-bone.svg'
import ravenSmall from './assets/founder-raven-small.svg'
import raven from './assets/founder-raven.svg'

/**
 * The Founder's raven (assets/README.md): the small drawing at 48 px and below, the full one
 * above; the on-bone variant on dark surfaces, where the dark ring would disappear. Drawn as a
 * square image, never recoloured or stretched. Decorative: the name beside it says who it is.
 */
export function FounderAvatar({ className, size }: { className?: string; size: number }) {
  const small = size <= 48

  return (
    <span
      aria-hidden
      className={cn('relative inline-block shrink-0', className)}
      data-founder-avatar
      style={{ width: size, height: size }}
    >
      <img alt="" className="block size-full dark:hidden" draggable={false} src={small ? ravenSmall : raven} />
      <img
        alt=""
        className="hidden size-full dark:block"
        draggable={false}
        src={small ? ravenOnBoneSmall : ravenOnBone}
      />
    </span>
  )
}
