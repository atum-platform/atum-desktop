# Atum style bible

The one visual and interaction contract for every Atum surface: the Mac app, the
web app and the iPhone app. Read it before you draw, style or word anything a
person sees. Where another document disagrees with this one, this one wins and
the other is a bug to fix in the same change (`apps/desktop/DESIGN.md` is the
desktop's implementation detail under this file; `atum-mobile`'s design notes
are the phone's).

## 1. Who this is for

Atum is for people who are not power users. They say what they want and it
happens; the assistant is proactive and does the work. So every surface is:

- **Calm.** One obvious next step, at most one short muted line under it. No
  explanation walls, no scope lists before a consent screen (owner,
  2026-10-26). Detail goes behind an info affordance.
- **Plain-spoken.** Vietnamese first, everyday words, no jargon, no model or
  vendor vocabulary unless the person chose it.
- **Coherent, absolutely** (owner, 2026-10-28). The cheapest feel is one odd
  banner or control in a different style. If something looks unlike its
  neighbours, it is wrong, however good it looks alone.

## 2. Frame (keep)

The window frame is function, not decoration, and stays (owner, 2026-10-28):

- the **side rail** at the left: Chats, Store, Drive, Team space, then the
  account face at the bottom. The current destination wears its Phosphor
  **Fill** glyph; the others wear **Light**;
- the **title bar melded** into the frame, with each column's header in the
  same 48 px band;
- the **panel split**: rail · roster or sidebar · main · side panel.

**Materials and gaps** (boards, 2026-10-30). The rail and the title band are
one frame (`--atum-frame-bg`, vibrancy-tinted on the Mac). The roster, or
Team space's sidebar, is its own rounded panel (`--atum-r-panel` 14 px,
`--atum-roster-bg`, a 0.5 px rim and a top highlight). The main area is a
rounded opaque card (`--atum-main-bg`, `--atum-main-edge`). Panels sit 8 px
apart and 8 px in from the window's bottom and right edges
(`--atum-panel-gap`, `--atum-panel-inset`); the gaps are frame, never a
hairline seam. With the side panel open, main and the side panel are two
cards 4 px either side of the gap. Every column's content stays inside its
panel.

**The title bar belongs to the page under it** (2026-10-30). Above the roster:
the sidebar toggle and New chat. Above the main card: the page's or chat's name
(headline), its status beside it (Drive: "Up to date"), and at the right that
page's own controls: a chat's search, "…", divider and side-panel toggle; the
Store's Protons balance; Drive's view switch and search. A page puts its
controls there through the title bar's status and action slots, never in a
second header in its body. In Team space too, the channel's name starts over
the main card, never over the sidebar.

The account face carries no status dot. A problem appears where it blocks work
(a composer notice or an Atum ask). Attention is a dot, never a sentence: on
the roster row whose chat needs an answer, and as one quiet dot at the title
bar's right that jumps to that chat, with its sentence in a tooltip
(2026-10-30, delegated design decision).

Everything inside the frame follows the rest of this file.

## 3. Colour

Colour is rare (owner, 2026-10-28: "not over-use colors to avoid feeling
cheap"). Ink carries everything.

| Role          | Token                                                                    | Use                                                               |
| ------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| Grounds       | `--ak-ground`, `--ak-chrome`, `--ak-surface`, `--ak-raised`, `--ak-sunk` | page, frame, content, floating, recessed                          |
| Ink           | `--ak-ink`, `--ak-ink-2`, `--ak-ink-3`                                   | text, strongest to quietest. `--ak-ink-3` is the lowest text tone |
| Icon-only ink | `--ak-ink-4`                                                             | icons and strokes, **never text**                                 |
| On ink        | `--ak-on-ink`                                                            | text on an ink fill (primary button, badge, tooltip)              |
| Your bubble   | `--ak-bubble-own`, `-hover`, `--ak-on-bubble-own`                        | your own chat bubble: ink in light, a raised grey in dark         |
| Lines         | `--ak-line`, `--ak-line-2`                                               | one hairline; the strong one only where a field needs an edge     |
| Fills         | `--ak-fill-quiet`, `-hover`, `-press`, `-selected`                       | quiet surfaces, states                                            |
| Danger        | `--ak-danger`, `-fill`, `-hover`                                         | destructive actions, errors, the mention badge                    |
| Warning       | `--ak-warn`, `-fill`                                                     | a warning **glyph** only; never the text or the band              |
| OK            | `--ak-ok`, `-fill`                                                       | a success glyph or the assistant-ready dot                        |

- Brand colour appears only in **app icons**, **people's photos** and the
  **person's own content** (a photo, a deck's colours).
- No accent colour for links, selection, toggles or focus. Selected is a fill,
  on is ink.
- A notice band is the quiet fill with ink text; only its glyph may take the
  danger colour.
- **Look packs** (an app's own look inside Atum) may change **colour and
  background only** (owner, 2026-10-28). See §3a.

## 3a. App looks (look packs)

An app (Moon, for example) may dress its chat in its own look. Atum keeps the
look inside its own design language, so a themed chat still feels like Atum:
frosted, calm, the same shapes (owner, 2026-10-28). **Atum enforces this in its
renderer**; it does not rely on the app getting it right.

What a pack **may** set, and only these:

- the **ground**: a colour, a gradient or an image layer behind the
  transcript, with its light or dark tone;
- **art** layered on the ground;
- the **tint** of the app's bubbles and your own bubble;
- one **accent** for the send button.

What Atum always draws, whatever the pack says:

- the composer: the kit's glass capsule, tinted from the ground, never
  re-shaped or made opaque;
- every bubble's shape (radius 18, no tails) and the chat type (system font);
- buttons, quick replies, menus, the header and the side panel template;
- text contrast: ink and lines derived from the ground (the pack's `derived`
  ramp), with a scrim when an image is too busy behind text.

The frosted feel comes from Atum's glass sitting over the app's ground: app
bubbles are a translucent tint of the ground (on dark grounds, the app's bubble
colour at 12% with near-white ink and no edge), your own bubble is the light or
dark opposite of the ground, and the composer is `.ak-glass` over it.

**Where the ground goes** (boards, 2026-10-30): only inside the main card, with
the card's radius and a 0.5 px edge. The title bar, the roster and the rail stay
Atum's frame. The chat takes the kit theme of the ground's tone (`.ak-dark` on a
dark ground, `.ak-light` on a light one), so the composer, menus and notices use
that theme's glass and ink; a notice over a ground is strong glass, never a
plain band.

App makers get the same rules as a short publisher guide (what to supply,
sizes, contrast) alongside the look-pack schema; the renderer clamps anything
outside them rather than rejecting the pack.

## 4. Type

Six roles, never a one-off size. Desktop and web use the token; the phone maps
each to a Dynamic Type style (`AtumKit.TypeRole`).

| Role               | Token                               | Size/line | Use                                    |
| ------------------ | ----------------------------------- | --------- | -------------------------------------- |
| Display            | `--ak-t-display`                    | 26/32 600 | full-window page titles (Store, Drive) |
| Title              | `--ak-t-title`                      | 20/26 600 | sheet, dialog and Settings page titles |
| Headline           | `--ak-t-headline`                   | 15/20 600 | header names, section heads in content |
| Chat               | `--ak-t-chat`                       | 15/23 400 | every message, the composer            |
| Body / Body strong | `--ak-t-body`, `--ak-t-body-strong` | 13/18     | interface text, rows, menus, buttons   |
| Callout            | `--ak-t-callout`                    | 12/16     | secondary lines, help                  |
| Caption            | `--ak-t-caption`                    | 11/14 500 | timestamps, small labels               |

Sidebar and menu **section labels** are 12 px semibold in `--ak-ink-3`
(Channels, Direct messages, On this Mac). Never uppercase with letter-spacing
in new work.

Settings sections take the same label (`.ak-section`) above each group, and a
page with one group takes none. Settings is a sheet, so its page titles use
**Title**; **Display** is for full-window pages (Store, Drive)
(2026-10-29, delegated design decision).

## 5. Shape

**Nothing a person taps or recognises is square-ish** (owner, 2026-10-28).

- **People, assistants, agents and groups are circles.** Every avatar, every
  size, every surface.
- **Apps are squircles**: 22.5% corner radius with `corner-shape: squircle`
  (phone: `appIconCornerRatio`). That difference is how a list says "this row is
  an app" at a glance. Store items are app tiles too.
- **Actions are capsules.** Buttons are full-radius pills; icon buttons are
  circles.
- **Containers are rounded rectangles** from the radius scale (`--ak-r-xs` 6 ·
  `sm` 8 · `md` 10 · `lg` 14 · `xl` 20 · `2xl` 26). Nested corners are
  concentric: inner radius = outer radius − padding.

## 6. Space, size and motion

- **Space** on the 4-point grid (`--ak-s1` … `--ak-s12`). No in-between values.
- **Control heights**: 26 (small), 32 (regular), 40 (large) on the Mac; 44
  regular and 50 primary on the phone.
- **Icon sizes**: 16 in dense rows, 18 in buttons, 20 in toolbars, 24 in tab
  bars and the rail.
- **Motion**: ease-out `--ak-ease` for anything arriving; 120 ms for hover,
  press and colour; 200 ms for menus, popovers and switches; 320 ms for sheets,
  panes and page changes. Under Reduce Motion, fades only.
- **The launch** is Atum's one hero motion (2026-10-31; prototype: the "Atum
  Launch Motion" artifact; code: `apps/desktop/src/matrix/launch-eclipse/`).
  The wait is a total eclipse drawn live: a corona that drifts slowly, calm
  for as long as the launch takes. Each passed check breaks through as a bead
  of sunlight on the moon's edge, and the one running shimmers. When all have
  passed they run together into the diamond ring, the moon slides off into the
  mark's crescent, and the mark flies into the chat header, where it dissolves
  into the header's face glyph. Rules:
  - every move is a damped spring, never a typed curve; light saturates like
    film, never clips; the last frame is the brand mark exactly;
  - one line of words under it ("Getting Atum ready"), no percentage or
    checklist; a blocked launch dims and cools the corona and stills it, and
    its explanation takes the line's place;
  - a launch ready within 1.2 s gets the short finale (1.3 s, a 1.1 s
    flight), so a daily launch never waits for the animation;
  - no diamond ring unless every check passed: a window released early fades
    the eclipse where it is;
  - Reduce Motion: the mark is simply there, the corona still, and it fades;
  - where the window cannot draw it (no WebGL), the CSS hero stands in.
- **The first-launch story** (once per install, before sign-in) is the same
  eclipse, scripted (`launch-eclipse/story.ts`, about 10 s): the night alone,
  one spark, the corona blooms around the unseen moon, five beads break
  through, the diamond ring is the first word and "Speak, and it becomes."
  follows it, the moon slides into the mark's crescent, and the night lifts
  as the mark lands on the sign-in screen's mark. In totality the moon is the
  night's own black, never a grey disc. Skip fades it at any point.

## 7. Material

- **Frosted glass is for chrome that floats over content**: the composer,
  menus, popovers, toasts, floating bars (owner, 2026-10-28: "frosted glass
  look the best"). `.ak-glass`: blur 24, saturate 170%, a rim light.
- **Content stays opaque**: the transcript, pages, cards and lists.
- Elevation is `--ak-shadow-1` (resting card), `-2` (menus, popovers), `-3`
  (sheets, dialogs). No other shadows.

## 8. Icons

- **Phosphor, Light weight**, from the kit's pinned set
  (`packages/atum-kit/icons.json`; owner, 2026-10-28). **Fill** marks the
  selected state of the same glyph (the current rail destination, a favourite).
- Desktop code imports icons only through `apps/desktop/src/lib/icons.ts`;
  add a name to `icons.json` first if it is missing.
- Icons are ink. The danger colour for destructive or error glyphs; the warning
  colour for a warning glyph. Nothing else.

## 9. Focus

Keyboard focus follows the Mac convention (owner, 2026-10-28; this replaces the
earlier "no focus ring, ever"):

- A **ring appears only for keyboard focus** (`:focus-visible` after Tab or an
  arrow key): `3px solid var(--ak-focus)`, offset 1 px, following the
  control's own shape.
- **Never for pointer focus**, and never because a surface moved focus by
  script after a click. A dialog or sheet opened by a click focuses itself, not
  its first control, so nothing lights up on open.
- **Text fields** show focus by their own field treatment, not an extra ring.

Desktop status: the kit components and the Atum shell draw this ring; the shell
contract in `apps/desktop/src/app/atum/design-contract.test.ts` keeps the ring
on the shared token and preserves the text-field and self-focused-surface
exceptions.

## 10. Messages

- **Normal chats: everyone talks in bubbles** (owner, 2026-10-28: "AIs and
  humans feel the same"). People, assistants, agents and apps share the same
  quiet bubble (radius 18, chat type) on the left. A bubble hugs its content
  and is at most 78% of the row; code blocks, tables, rules and buttons never
  stretch a short bubble.
- **Faces and names follow the room, not the sender** (owner, 2026-11-05,
  desktop and phone alike; this replaces the 10-30 "face at the top of each
  run"). In a **one-to-one chat** (a person, your assistant, an app) there is
  no face, no face gutter and no name: we know who we are talking to. In a
  **group** the sender's name sits over the first bubble of a run and their
  28 px face beside the last bubble, level with its bottom; the run's other
  bubbles keep an empty gutter of the same width, so the run lines up. The
  gutter sits outside the 78%. Apps keep squircle faces (§5).
- **A run** is consecutive messages from one sender, each at most 5 minutes
  after the one before. A new day, the unread line and the typing row break
  it.
- **Your own messages** are the one strong bubble on the right
  (`--ak-bubble-own` with `--ak-on-bubble-own`): ink in light; a raised grey
  (#3d3f47) with near-white text in dark, because inverted ink glares there
  (2026-10-28). While being edited, a turn returns to the quiet field.
- **Team space channels read like Slack** (owner, 2026-10-25, reconfirmed
  2026-10-28): flat runs, edge to edge, for people and assistants alike. A
  36 px round face, the bold name and the time open a run; later lines show
  their time on hover; your own messages sit on the left with everyone's.
- **Answer actions** (copy, good, bad, retry) are small quiet icon buttons
  under the assistant's run: always visible under the latest answer, on hover
  or focus under earlier ones (2026-10-29, delegated design decision).
- **Delivery** shows only under your last message: "Sent" in caption ink-3,
  replaced by the reader's 14 px face once read (in a group, up to three faces
  and +N). Earlier messages carry no mark
  (2026-10-29, delegated design decision).
- **Atum never writes into a message** (owner, 2026-11-11). No program adds a
  sentence to, or edits, someone's message to report a file or a system
  condition. A file's state is its card's; a blocked turn is Atum's own line
  (below). A file changing state never marks a message edited.
- **Files** in a chat are plain cards (`.ak-file`; 2026-10-29, revised
  2026-11-11): hairline, `--ak-r-xl`, a 40 px sunk tile (`--ak-r-lg`, concentric
  with the card's 6 px padding) with the file's shape glyph, the real name in
  body-strong and one line in callout. The line says where the file is
  ("Documents › Q4", "Company files › Q4", "Uploads"), or "{Kind} · {size}" for a
  file that is not in Drive. Up to the 320 px card width; a file in your own
  message sits under your bubble on the right. The card itself opens the file
  (an in-app preview on the Mac, the Drive preview on the phone); one trailing
  slot shows its state or, on hover or keyboard focus, a "…"
  (`.ak-iconbtn--sm`) whose menu lists only what works now (Open with…, Show in
  Finder when the file is on this Mac, Share). On the phone a long press offers
  Share. A received file that must be fetched keeps a download icon button in
  that slot. Its states, which change by themselves and never by new text:
  - **Saving**: the kit spinner (`.ak-spinner`, an app wait, never the atom) in
    the trailing slot, named "Saving" for screen readers and in its tooltip.
  - **Saved**: the plain card.
  - **Saved as a copy**: the copy's real name, and an info icon button whose
    tooltip says why ("The original changed, so this one sits beside it.").
  - **Not confirmed** (`.ak-file--muted`): the name in body ink-2, the glyph in
    ink-4, the line "Not confirmed". It opens the kept draft while there is one.
    No "save again" action, and never the danger or warning colour: nothing is
    known to have failed.
  - **Expired** (`.ak-file--inert`): no surface or edge, an outlined tile, the line
    "Not confirmed"; nothing to open, and never the word "lost". A viewer who
    no longer has access sees the same inert card without its line.
  - **Reopened later**: a file that has moved since shows a toast ("No longer
    where it was" · Find in Drive). Messages from before cards keep their old
    text and get no card.
- **Atum's own line** (`.ak-chat-note`; owner, 2026-11-11): when Atum itself has
  something to say in a chat (the assistant can't answer: out of Protons,
  today's limit, an outage; a long answer paused), it is one centred callout
  line in ink-3, in Atum's voice, never the assistant's first person, with at
  most one `.ak-btn--sm` that fixes it in place. It sits under the message it
  is about and takes the place of the delivery mark there; when the block
  clears it fades and the assistant answers. Someone who can't fix it (a
  company member who is not an owner or admin) sees the line without the
  button. It fits one phone line, about twelve Vietnamese words. Never a band,
  a bubble or the danger colour.
- **Quick replies** are up to three `.ak-btn--sm` under the message they answer;
  each sends an ordinary message in your name ("Continue", "Send the rest", "Do it in
  the cloud"). They replace words you would otherwise be told to type.
- **The assistant at work** shows the Atum atom, never a generic spinner.
- **A new chat** shows the assistant's face (48), one greeting in Display, one
  muted line, and up to three suggestion buttons (`.ak-btn--sm`); nothing else.
  Welcome or balance lines go in a composer notice, never in the empty state
  (2026-10-29, delegated design decision).

## 11. Composer

- A frosted capsule (`--ak-glass`, radius 20 on the Mac) floating over the
  bottom of the conversation, the same shape everywhere, look packs included.
- Placeholder: "Message {name}" in the person's language.
- Left: the add (+) button. Right: the model chip (Atum chats), dictation, then
  send, a round ink icon button, faint until there is something to send. The
  chip is always there in Atum chats; there is no setting to hide it
  (2026-10-29, delegated design decision; replacing 2026-10-10 "model choice
  off by default"). While the assistant works, the placeholder reads "Add to
  your request…".
- **The phone keeps the larger composer** and the model picker in agent chats
  (owner, 2026-10-28).
- **Team space** adds one quiet "Aa" toggle that opens the formatting row; the
  row is hidden until asked for.

## 12. Models

- The chip shows the model's name without its version.
- The picker is one plain menu headed "Answers with": Nguyệt Thực (suggested,
  good for everyday tasks), Nhật Thực (good for hard tasks; owner,
  2026-10-28 later: no multiplier line), Thái Cực (the most powerful model,
  coming soon, disabled), then "Use a subscription you pay for". People who
  connected another provider get the two-column picker.
- In the two-column picker, Atum's own models carry the same lines as the
  simple menu ("Suggested · Good for everyday tasks", "Good for hard tasks",
  "The most powerful model · Coming soon"), never route words such as Cloud or
  Default. Keyboard shortcuts live in the tooltip
  (2026-10-29, delegated design decision).

## 13. Controls and patterns

Use the kit component; never restyle one at a call site.

| Need                            | Component                                                          | Rules                                                |
| ------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------- |
| Action                          | `.ak-btn` (+ `--primary`, `--plain`, `--danger`, `--glass`, sizes) | capsules; one primary per view                       |
| Icon action                     | `.ak-iconbtn`                                                      | circle; a tooltip names it                           |
| List                            | `.ak-row` in `.ak-group`                                           | hairline starts at the words, not the icon           |
| Field                           | `.ak-field` (+ `--search`, `--error`)                              | label above, help below in callout                   |
| Choice                          | `.ak-switch`, `.ak-seg`, `.ak-radio`, `.ak-check`, `.ak-select`    | switches for on/off settings only                    |
| Menu                            | `.ak-menu`                                                         | glass; danger items last, after a separator          |
| Sheet / dialog                  | `.ak-sheet`, `.ak-dialog`                                          | radius 26, title + one line + actions; Escape closes |
| Notice                          | `.ak-notice` (+ `--warn`, `--danger`)                              | quiet fill, ink words, coloured glyph only           |
| Toast                           | `.ak-toast`                                                        | glass, one line, one optional action                 |
| Empty / error / loading         | `.ak-state`, `.ak-skeleton`, `.ak-spinner`                         | says what this is and offers the next step           |
| Ask (the assistant needs a yes) | `.ak-ask`                                                          | one question, its actions, nothing else              |
| Badges                          | `.ak-badge` (+ `--mention`, `--quiet`)                             | mention is the only red badge                        |
| File in a chat                  | `.ak-file` (+ `--muted`, `--inert`)                                | the card opens it; one trailing slot (§10)           |
| Atum's own line in a chat       | `.ak-chat-note`                                                    | one centred line, at most one `.ak-btn--sm` (§10)    |

- A **dialog** (`.ak-dialog`) is only for a confirmation: title, one line,
  Cancel and the action. Anything with a field, including choosers with a
  search field (Start a chat, Add people, Invite), is a **form sheet**
  (`.ak-sheet`). Rows are kit rows under section labels; the footer holds
  secondary actions as plain buttons, and a primary only when the sheet
  submits something (2026-10-29, delegated design decision).

Every state of every surface (empty, loading, error, offline, signed out,
permission missing) uses these patterns; the canvas's States board lists them.

## 13a. Roster rows and faces

- **A chat row** is the face, the name and one line, with a count badge at the
  end when there are unread messages. No timestamp, no presence or "ready" dot,
  no separate unread dot (boards, 2026-10-30). A working assistant may show
  its state dot; a ready one shows nothing.
- **A group's face** is two stacked round faces (28 px box, 19 px faces with a
  ring in the roster's colour). Team space's sidebar uses the same at 20 px.
- **A person's presence dot** (8 px, its centre on the face's edge at 45°, in a
  notch cut out of the photo; the face never clips it) shows only where you look
  at people: member lists, people pickers, a DM's header and Team space's DM
  rows, the person card. Never on message rows, stacked faces, read receipts,
  activity rows or a roster chat row (owner, 2026-11-06: "broken green circle").
- **Every person's face is the kit monogram** (`.ak-avatar`: white initial on
  `--ak-monogram`) until they set a photo; no per-person colours anywhere. An
  initial is a letter, never "@" or "#".
- **A segmented control's chosen segment** is a raised chip: `--ak-surface`
  with `--ak-shadow-1` in light, `--ak-raised` in dark.

## 14. Destinations

- **Settings**: six pages: You (Account, Assistants, Connections), App
  (General, Help), Support (Advanced), each with its Phosphor glyph in the nav
  (user-circle, sparkle, eye, gear, question, command). Sections inside a page
  take the small `.ak-section` label (caption, 600, ink-3), aligned with the
  rows' text; never a headline. A page folded into another (Privacy & security
  under Account) adds its sections under the same small labels, never a
  second title. Opening a section scrolls to it.
- Connections is account-wide. It opens with the subscriptions the person has connected once
  for every assistant, then lists every shared source as one row: glyph or app icon, name, one
  line, "Forget…" and a switch. Apps the person uses in chats are sources too
  (app squircle, "Used in your chats", a switch). A source this Mac cannot
  offer keeps its row, switched off and disabled, with one line saying so.
  Every Settings, model-picker and connect affordance opens this same page; none selects an
  assistant or requires its local host (owner, 2026-10-31; replacing the earlier Advanced
  placement).
- Account opens with one identity card: face, name, "@handle · email", Edit.
  The handle is edited in the profile sheet, not in its own section; an
  assistant's handle lives on that assistant's page. Then How Atum answers,
  then your devices, then the rest of Privacy & security; Sign out and Delete
  account are always last on the page. Sign out is a neutral button and Delete
  account a plain one that opens a confirm dialog; the page itself carries no
  red (2026-10-29; order 2026-10-30, delegated design decision).
- Help and Advanced have no board yet; until the canvas draws them, they are:
  Help = Updates, Help improve Atum, Contact us, Legal; Advanced = the
  assistant chooser (only with more than one assistant), Model (Use your own model), Repair
  (Repair, Technical details), For developers. Per-assistant Providers, Model & Memory and MCP
  servers remain there; the combined native Hermes Connections page is not the account
  Connections destination. No placement or runtime
  wording on either (2026-10-29, placement updated by owner 2026-10-31).
- **Store**: one calm list per shelf. Each row has a neutral app tile, the name
  and line, and one price at the end. An item opens one sheet with one Get
  button.
- A Store tile is a squircle showing: for skills and assistants, a neutral tile
  with the item's Phosphor glyph; for apps, the app's icon; for pets, the pet's
  portrait. No emoji or stock art. The catalog names glyphs as emoji; the tile
  draws the Phosphor counterpart from one table in `store-card.tsx`, and the
  kind's glyph when the table has none (2026-10-30). A row's one button reads the price as a
  number ("4,000"), "Get" when free, "Open" when owned; the balance sits once,
  in the title bar (2026-10-29, delegated design decision).
- **Drive**: a Finder-calm list; a row's actions show on hover or focus. The
  page is named for where you are ("Recents" in Display) and the places sit on
  the roster panel itself under a small "Drive" label, never in a card of their
  own (2026-10-31).
  Files Drive leaves on this Mac on purpose (private files, `.env`, databases,
  code folders) are a quiet caption beside the status ("7 files only on this
  Mac") whose popover says why and offers Show in Finder; only real problems
  (full, conflicts, couldn't sync, signed out) take a card (owner, 2026-11-06).
- **Store and Drive sidebars**: rows of 40 px straight on the roster panel with
  the kit's hairline between them. A Store item's tile is a raised squircle
  (surface, hairline, `--ak-shadow-1`; the raised grey in dark), not a sunk one.
- **Side panel**: tabs as glass chips with ×, a + launcher. The new tab is
  calm as Codex's (owner, 2026-11-01, replacing the 10-30 "On this Mac" /
  "Your apps in Atum" page): the "Search or type a website" field, then
  **Tools** (quiet rows in at most two columns: Files, which opens Drive; Open
  a file…; Reopen closed document while the chat has one), **Apps** (only the
  Office apps Atum works in, Word, Excel and PowerPoint, as tiles; without
  Office, the Mac apps last opened from Atum), then a **More** tile whose
  popover lists every other Mac app, the person's apps in Atum and the Store,
  with one search field; and **Recent**. Mac app icons are drawn solid, as the
  Mac draws them; what Atum can do in an app is that tile's detail, never a
  faded icon (2026-10-30). Tiles are 40 px on a ~68 px pitch, packed from the
  left. A document reads as a page on the side panel's own card, with a
  hairline round it; no grey desk behind it (2026-10-31).
- **Side panel › an agent's tab** (2026-11-11, side-panel plan P1): in the
  owner's 1:1 chat with an agent the panel opens on that agent's own tab,
  pinned first, its face and name, no ×. Sections are `.ak-section` labels
  over `.ak-group--plain` rows; a section with nothing to show is absent.
  **Now** always says one thing (Free, Working · N min with its steps,
  Waiting for you with the chat's own ask, On your <device>); Stop is a quiet
  `.ak-btn`, never the primary. Your devices rise under Now while one is in
  use. Memory is the assistant card's row at the foot. No money, no settings,
  no second text box: steering is the composer.
- **Connections sources**: one row per source, its glyph in a small sunk tile
  before the name (body-strong) and one line, the switch at the end
  (2026-10-31). Documents read as a page, never as
  code.
- **Team space**: a mode of the shell, not a page. The sidebar is the roster
  panel and pins the company: its app tile, its name in headline, an up/down
  chevron. Channel headers show up to three member faces and the count (the
  people glyph until the room's members load). The composer names a channel
  as its header does ("Message #chung").
- A company's views (Chat, Board, Marketplace; owner 2026-10-27) are a small
  segmented control centred in the 48 px title band. The channel header's
  right side is member faces with count, search, "…", and the side-panel
  toggle; nothing else. A thread summary is Slack's line: repliers' round
  faces, "N replies" (strong ink, never an accent link), "Last reply …" (muted),
  one hover target with "View thread" (owner 2026-11-03, supersedes the
  2026-10-29 "↰ N replies" rule).
  Creating channels is a + on the Channels label; inviting is the pinned
  "Invite teammates" at the sidebar foot
  (2026-10-29, delegated design decision).

- **Sign in**: one centred column: the eclipse on a raised circle, "Welcome to
  Atum", one line under it, Continue with Google as the ink capsule, Continue
  with email as the quiet capsule, then the fine print and the language at the
  foot. Google's button keeps the full-colour "G" (Google's sign-in branding
  requires it; the board's monochrome G is the board's error) and uses
  Google's own dark theme on the light ground and light theme on the dark one.
  The foot keeps one legal line and the language (F1, 2026-10-30); the usage
  switch lives in Settings › Help.

## 15. Words

- Shared copy is written once, on the desktop side, and reaches the phone
  through `packages/mobile-design-exports`. Never fork a string per platform.
- Sentence case. No exclamation marks in interface text. No "please".
- Name things by what they do for the person ("Connections" for account credentials and shared
  sources; "Chats", not "Home").
- When two people in one chat share a name, add the handle after the name in
  ink-3 ("Linh @linh"). Never show a hash, key or device id to tell people apart
  (2026-10-29, delegated design decision).

## 16. How this stays true

A document alone does not keep a product consistent; these do:

1. **Tokens are the only source of values.** Change a value in
   `tokens.json` (and `approved-0.1.css` with the owner's approval), never at a
   call site. `npm run check -w packages/atum-kit` fails on drift.
2. **Mockup first.** A new or changed screen is drawn on the canvas and
   approved before code. Code matches the board.
3. **Contract tests.** `apps/desktop/src/app/atum/design-contract.test.ts`
   refuses known violations (retired tokens, focus classes). When this file
   gains a rule that code can check, add the check in the same change.
4. **Agents read this first.** `apps/desktop/AGENTS.md`,
   `apps/desktop/DESIGN.md` and `atum-mobile/AGENTS.md` point here.
5. **Review against it.** Every UI change states which board it matches and
   passes the checklist below.

### Checklist for every UI change

- [ ] Matches its canvas board; if none exists, one was drawn first.
- [ ] Only kit tokens and components; no raw colour, radius, shadow or size.
- [ ] People round, apps squircle, actions capsules.
- [ ] No colour beyond §3.
- [ ] Phosphor Light; Fill only for the selected state.
- [ ] Focus ring only for keyboard focus.
- [ ] Light and dark both checked.
- [ ] Every state (empty, loading, error, offline) uses a kit pattern.
- [ ] Copy in all five locales, from the shared catalog, and the phone export
      regenerated if shared copy or tokens changed.
