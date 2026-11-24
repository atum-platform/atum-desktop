# Atum Kit on T3, step 3: overlays, capsules and the decided layout pieces (2026-11-24)

Owner decisions 2026-11-24: option B (T3's design system is the Kit base, Phosphor icons kept) and the layout
spec (owner evidence `layout-language-1124/r2/LAYOUT.md`, round 1 `../LAYOUT.md`). Follows
`docs/kit-t3-foundation-1124.md` (steps 1 and 2).

## What changed

- **Pet chat on the T3 composer.** `matrix/pet/chat-box.tsx` uses `ComposerSurface recipe="t3"` and the 32 px round
  send. The legacy Hermes chat (`src/app/chat/composer`) is **not** moved: it is not in the Atum build (the Matrix
  window's entry is `matrix.html` → `src/matrix/entry.tsx`, which never imports it), and its composer carries popout,
  drag and inline modes with no user-visible gain. It retires with the legacy app.
- **Overlays on T3 glass (step 3).** The sync now also vendors T3's `popover.tsx`, `dialog-styles.ts`, `tooltip.tsx`
  and `toast.tsx` (`packages/atum-kit/scripts/sync-t3-design.mjs`, `t3/PIN.json`). `styles.css` "T3 overlays" paints
  Atum's Radix menus, popovers, selects, dialogs, tooltips and toasts with T3's recipes on T3's variables:
  `dropdown-glass` menus at 8 px with 28 px rows and 14 px text, `dialog-glass` dialogs at 16 px with 24 px padding
  and T3's blurred backdrop, glass tooltips at 6 px and 12 px text, glass toasts. Radix stays underneath (T3 ships
  Base UI); behaviour, focus handling and the app-view overlay hold are unchanged.
- **Capsules gone outside the Kit.** The shared Button (`.atum-shell [data-slot='button']`) and its icon sizes take
  the 8 px control radius instead of a capsule. 31 hand-written `rounded-full` buttons and the two pill search
  fields (roster, group picker) take `rounded-(--control-radius)`. Kept round on purpose: reactions, avatar stacks,
  badges and chips, the composer send.
- **New is a plus menu (Chat).** `MatrixStartChatButton` opens a T3 menu: New chat ⌘N, New group, Add a friend,
  then New assistant where the account can make one. Each item opens the existing flow (`MatrixRosterCreate`).
  ⌘N still runs New chat directly.
- **Store's "+" dropped** (r2 §5): it was Chat's New button reused; with nothing to create in the Store it goes,
  with the "open New message after leaving the Store" hand-off it needed.
- **Chat's left-panel foot**: Add a friend and the settings gear (`data-atum-roster-foot`, `.atum-panel-foot`).
- **Rail badges** (`matrix/rail-badges.ts`, `AtumNavSwitchSurface badges`): Chat shows a red count of the personal
  conversations waiting for you (a mention or a notifying unread, one per conversation) plus each assistant that
  asks for you, else an ink dot for quieter unread; Drive shows a red dot for a sync problem only you can fix
  (`error`, `reauthenticate`, `cleanup_failed`, a folder problem, conflicts/errors/signed-out issues). Drive's
  badge listens to what Drive publishes and never calls `read()` (which would activate Drive). Team Space keeps its
  badge, now drawn by the same mark.
- **"Mac is full" alert removed**: a low or critical disk is no longer an attention item (no bell entry, no
  snooze). A full disk that blocks chats still says so in the composer (`chats-disk-full`).
- **The bell**: the quiet bell is gone (nothing is drawn while nothing needs you), and an assistant's ask now also
  counts on Chat's rail badge. The bell still appears while it holds an item, because its list is the only place
  that acts on some of them: another device asking for approval, a sign-in elsewhere, this Mac's device damaged,
  and the exact room an assistant's listening stopped in. See the owner question below.
- **atum-work sync**: `feat/kit-t3-sync-1124` (from `feat/work-runtime-0.1.15`, 38ace137e5) copies
  `model-picker-spec.json` and `model-picker-digests.json` byte for byte; labels were already identical.

## Work's frame

Real 0.1.15 runtime (decoy HOME, `T3CODE_TELEMETRY_ENABLED=false`, `OTEL_SDK_DISABLED=true`, Atum theme set with
`t3 theme set`): Work is stock T3 in Atum's colours, flat: no gaps around its panels. The spec (r1 "Work: who owns
what", r2 `work-neutral`) has Atum owning the panel frames, drawn as three cards with gaps. **Not consistent.**
It cannot come back through the theme file (T3 themes are colours only) or Atum's host chrome alone (Work is one
native view; the host can inset and round it, but cannot cut gaps between T3's own panels). T3's own Sidebar already
ships the shadcn `variant="inset"`/`"floating"` layout (sidebar on the chrome ground, main card `m-2 rounded-xl`),
but T3 never selects it. Recommended fix, next round: in atum-work, select `variant="inset"` under the Atum build
flag (`VITE_ATUM_WORK_BUILD`), and let the host place the view on the frame ground with the panel radius
(`electron-view.ts` already supports `setBorderRadius`). No 35 KB CSS comes back.

## Owner questions

1. **Where do the bell's items live once it is fully gone?** The spec re-homes assistants' asks (rail count, the
   roster row), but not "another device asks to sign in", "new sign-in elsewhere", "this Mac's device is damaged",
   recovery/sign-in/Protons problems, or the jump to the room where an assistant's listening stopped. Several are
   security and access notices, so this round keeps the bell **only while it holds an item**. Options: open the
   list from the rail's red count, a band in the left panel's foot, or keep the bell as that exception.

## Not done this round (decided, still to build)

- Title-bar ← → at the left panel's edge: Atum has no navigation history yet (a history model over destinations,
  rooms, Store shelves and Drive folders, plus Work's bridge). Its own slice.
- Plus menus on Team Space (New channel, New message, New task, Add people), Drive (New folder, New document,
  Upload) and Work (T3's pencil via the bridge).
- Work's rail badge (threads waiting for approval / finished), Store's "purchase arrived" dot.
- Feet for Store (Top up + gear), Team Space (company switcher, Add people, gear), Drive (storage meter + gear).
- Work's frame (above).

## Verification

See the commit message and `kit-t3-1124/step3/` (owner evidence): before/after playground shots, light and dark,
and the real Work runtime.
