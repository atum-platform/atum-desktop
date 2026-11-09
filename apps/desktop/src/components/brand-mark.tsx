import { cn } from '@/lib/utils'

const assetPath = (path: string) => `${import.meta.env.BASE_URL}${path.replace(/^\/+/, '')}`

// Brand badge: the Atum mark on its own full-bleed dark tile. The old white
// wrapper made the mark look like a small icon pasted into a generic app-icon
// container — especially obvious in Launchpad and the full-window auth gate.
// Size via className (default size-14).
//
// `inset` is the avatar cut (the roster's rows): the eclipse sits inside the
// tile with room around it, like an initial in its square, and a hairline
// keeps the tile's edge on a dark panel. Full bleed at avatar sizes read as a
// black disc spilling past its square.
export function BrandMark({ className, inset = false, ...props }: React.ComponentProps<'span'> & { inset?: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-md bg-[#141311]',
        inset && 'shadow-[inset_0_0_0_0.5px_var(--atum-line-strong)]',
        className
      )}
      data-brand-mark={inset ? 'inset' : undefined}
      {...props}
    >
      <img
        alt=""
        className={inset ? 'size-[64%] object-contain' : 'size-full object-cover'}
        src={assetPath('atum-mark.svg')}
      />
    </span>
  )
}
