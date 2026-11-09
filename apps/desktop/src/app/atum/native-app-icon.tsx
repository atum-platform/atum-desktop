import { AppWindow } from '@/lib/icons'

import type { NativeAppEntry } from '../../../shared/skills-launcher'

/** Finder artwork, shared by the legacy and Matrix launcher presentations. macOS artwork carries its
 * own margin, so 48 px draws a ~40 px tile, the size the Atum Kit side panel board uses; `small`
 * draws the ~20 px glyph a menu row carries. */
export function NativeAppIcon({ app, small = false }: { app: NativeAppEntry; small?: boolean }) {
  return app.icon ? (
    <img
      alt=""
      className={
        small
          ? 'size-6 shrink-0 object-contain'
          : 'size-12 object-contain drop-shadow-[0_1px_2px_rgba(23,25,31,0.14)]'
      }
      draggable={false}
      src={app.icon}
    />
  ) : small ? (
    <span className="grid size-6 shrink-0 place-items-center text-(--ak-ink-2)">
      <AppWindow className="size-4" />
    </span>
  ) : (
    <span className="grid size-10 place-items-center rounded-[0.625rem] bg-(--atum-sunk) text-(--atum-ink-soft)">
      <AppWindow className="size-5" />
    </span>
  )
}
